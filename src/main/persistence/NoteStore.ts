import { findPii } from '../control/Masking';
import type { HelmDatabase } from './Database';
import { truncateUtf8Tail } from './text';

/**
 * NoteStore — thread/site 범위의 마크다운 메모.
 *
 * `site:<host>` 메모는 다음에 그 사이트를 방문할 때 에이전트 프롬프트에 자동으로 실린다.
 * 그래서 **여기 들어간 것은 다음 실행에서 LLM 에게 보내진다** — 자격증명이나 개인정보가
 * 들어가면 그대로 흘러 나간다. 저장 전에 검사해 거부한다(CLAUDE.md).
 *
 * 버전을 쌓아 두는 이유는 되돌리기다. `note_append` 의 역연산은 이전 버전 복원이다.
 */

/** site 메모는 프롬프트에 실리므로 호스트당 상한을 둔다. */
export const MAX_SITE_NOTE_BYTES = 2048;

export interface Note {
  scope: string;
  version: number;
  text: string;
  createdAt: number;
}

export type NoteRejection =
  | { ok: false; reason: 'scope'; message: string }
  | { ok: false; reason: 'credential'; message: string; matches: string[] }
  | { ok: false; reason: 'pii'; message: string; matches: string[] };

export type NoteWriteResult =
  | { ok: true; note: Note; truncated: boolean }
  | NoteRejection;

interface NoteRow {
  scope: string;
  version: number;
  text: string;
  created_at: number;
}

/**
 * 자격증명 패턴 — "키워드 + 값" 꼴만 잡는다.
 *
 * "비밀번호를 바꿔야 한다" 같은 문장은 막지 않는다. 막아야 하는 것은 값이 붙은 경우다
 * ("비밀번호: abcd1234"). 키워드만으로 거부하면 사람이 메모를 못 쓰게 되고,
 * 그러면 메모 기능 자체를 우회하게 된다.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(비밀번호|패스워드|암호|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /(토큰|token|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/gi,
  /(api[_ -]?key|apikey|secret|client[_ -]?secret)\s*[:=]\s*\S+/gi,
  /(bearer)\s+[A-Za-z0-9._-]{16,}/gi,
  // 카드번호 — 4자리 묶음 4개
  /\b(?:\d{4}[- ]?){3}\d{4}\b/g
];

export function findCredentials(text: string): string[] {
  const found: string[] = [];

  for (const pattern of CREDENTIAL_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(text);
    while (match) {
      found.push(match[0]);
      match = regex.exec(text);
    }
  }

  return found;
}

const SCOPE_PATTERN = /^(thread:[\w.-]+|site:[\w.-]+)$/;

export function isValidScope(scope: string): boolean {
  return SCOPE_PATTERN.test(scope);
}

export function isSiteScope(scope: string): boolean {
  return scope.startsWith('site:');
}

/** 검사 결과만 알고 싶을 때(북마크 메타도 같은 규칙을 쓴다). */
export function checkForSecrets(text: string): NoteRejection | null {
  const credentials = findCredentials(text);
  if (credentials.length > 0) {
    return {
      ok: false,
      reason: 'credential',
      message: '자격증명으로 보이는 값이 있어 저장하지 않았습니다',
      // 무엇이 걸렸는지 알려 주되 값 자체는 돌려주지 않는다.
      matches: credentials.map((match) => match.slice(0, Math.min(12, match.length)) + '…')
    };
  }

  const pii = findPii(text);
  if (pii.length > 0) {
    return {
      ok: false,
      reason: 'pii',
      message: '개인정보로 보이는 값이 있어 저장하지 않았습니다',
      matches: [...new Set(pii.map((hit) => hit.kind))]
    };
  }

  return null;
}

function toNote(row: NoteRow): Note {
  return { scope: row.scope, version: row.version, text: row.text, createdAt: row.created_at };
}

export class NoteStore {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  latestVersion(scope: string): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM notes WHERE scope = ?')
      .get(scope) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  read(scope: string): Note | null {
    const row = this.db
      .prepare('SELECT * FROM notes WHERE scope = ? ORDER BY version DESC LIMIT 1')
      .get(scope) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  history(scope: string): Note[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE scope = ? ORDER BY version DESC')
      .all(scope) as NoteRow[];
    return rows.map(toNote);
  }

  getVersion(scope: string, version: number): Note | null {
    const row = this.db
      .prepare('SELECT * FROM notes WHERE scope = ? AND version = ?')
      .get(scope, version) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  scopes(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT scope FROM notes ORDER BY scope').all() as {
      scope: string;
    }[];
    return rows.map((row) => row.scope);
  }

  /** 기존 본문 뒤에 붙여 **새 버전**을 만든다. 이전 버전은 그대로 남는다(되돌리기용). */
  append(scope: string, text: string): NoteWriteResult {
    if (!isValidScope(scope)) {
      return {
        ok: false,
        reason: 'scope',
        message: `범위는 thread:<id> 또는 site:<host> 여야 합니다 (받은 값: ${scope})`
      };
    }

    const rejection = checkForSecrets(text);
    if (rejection) return rejection;

    const previous = this.read(scope);
    let merged = previous ? `${previous.text}\n${text}` : text;
    let truncated = false;

    // site 메모는 프롬프트에 실리므로 상한을 넘기면 앞부분을 버린다(최근 내용이 유용하다).
    if (isSiteScope(scope) && Buffer.byteLength(merged, 'utf-8') > MAX_SITE_NOTE_BYTES) {
      truncated = true;
      merged = truncateUtf8Tail(merged, MAX_SITE_NOTE_BYTES);
      // 잘린 첫 줄은 문장 중간일 수 있어 버린다.
      const firstBreak = merged.indexOf('\n');
      if (firstBreak > 0) merged = merged.slice(firstBreak + 1);
    }

    return { ok: true, note: this.write(scope, merged), truncated };
  }

  /** 본문을 **교체**해 새 버전을 만든다. 되돌리기(이전 버전 복원)가 이 경로를 쓴다. */
  replace(scope: string, text: string): NoteWriteResult {
    if (!isValidScope(scope)) {
      return { ok: false, reason: 'scope', message: `잘못된 범위: ${scope}` };
    }

    const rejection = checkForSecrets(text);
    if (rejection) return rejection;

    return { ok: true, note: this.write(scope, text), truncated: false };
  }

  private write(scope: string, text: string): Note {
    const version = this.latestVersion(scope) + 1;
    const now = Date.now();
    this.db
      .prepare('INSERT INTO notes (scope, version, text, created_at) VALUES (?, ?, ?, ?)')
      .run(scope, version, text, now);
    return { scope, version, text, createdAt: now };
  }

  /** 특정 버전으로 되돌린다 — 지우지 않고 그 내용을 새 버전으로 다시 쓴다. */
  restore(scope: string, version: number): NoteWriteResult {
    const target = this.getVersion(scope, version);
    if (!target) {
      return { ok: false, reason: 'scope', message: `없는 버전: ${scope} v${version}` };
    }
    return { ok: true, note: this.write(scope, target.text), truncated: false };
  }

  remove(scope: string): number {
    return this.db.prepare('DELETE FROM notes WHERE scope = ?').run(scope).changes;
  }
}
