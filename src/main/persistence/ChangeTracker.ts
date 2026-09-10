import type { HelmDatabase } from './Database';
import { truncateUtf8 } from './text';

/**
 * ChangeTracker — 북마크된 페이지의 본문 스냅샷과 낱말 단위 diff.
 *
 * "지난번과 뭐가 달라졌나" 는 사내 포털에서 가장 자주 나오는 질문이다. 매번 전체를 다시 읽어
 * LLM 에게 비교시키는 것은 느리고 비싸므로, 방문할 때 본문을 남겨 두고 텍스트로 비교한다.
 *
 * 본문은 200KB 로 자른다. 그보다 긴 페이지의 뒷부분은 대개 각주·이력이라 diff 가치가 낮고,
 * DB 를 키우면 열 때마다 느려진다.
 */

export const MAX_SNAPSHOT_BYTES = 200 * 1024;

export interface Snapshot {
  id: number;
  url: string;
  title: string;
  text: string;
  bytes: number;
  truncated: boolean;
  capturedAt: number;
}

export type HunkKind = 'same' | 'added' | 'removed';

export interface Hunk {
  kind: HunkKind;
  /** 낱말들을 공백으로 이어 붙인 조각 */
  text: string;
  words: number;
}

export interface WordDiff {
  hunks: Hunk[];
  addedWords: number;
  removedWords: number;
  unchangedWords: number;
  /** 변경 낱말 수(추가+삭제) — 이력 목록에 한 줄로 보여주는 값 */
  changedWords: number;
  /**
   * 차이가 너무 커서 낱말 정렬을 포기하고 "전체 교체" 로 본 경우.
   * 거짓으로 정확해 보이는 diff 를 내놓기보다 그 사실을 알린다.
   */
  coarse: boolean;
}

interface SnapshotRow {
  id: number;
  url: string;
  title: string;
  text: string;
  bytes: number;
  truncated: number;
  captured_at: number;
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    text: row.text,
    bytes: row.bytes,
    truncated: row.truncated === 1,
    capturedAt: row.captured_at
  };
}

/** 낱말 나누기. 공백 종류(전각 공백 포함)를 하나로 본다. */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== '');
}

/**
 * LCS 로 낱말을 맞춰 볼 상한.
 *
 * 앞뒤 공통 부분을 잘라낸 뒤의 크기로 판단한다. 스냅샷 비교는 보통 몇 낱말만 바뀌므로
 * 이 상한에 걸리는 일은 드물고, 걸리면 `coarse: true` 로 정직하게 알린다.
 */
const LCS_CELL_LIMIT = 1_000_000;

/** 낱말 단위 diff. 순수 함수라 골든 테스트로 고정할 수 있다. */
export function diffWords(before: string, after: string): WordDiff {
  const a = tokenize(before);
  const b = tokenize(after);

  // 앞뒤 공통 부분을 먼저 떼어낸다 — 대부분의 페이지는 여기서 거의 다 잘린다.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const hunks: Hunk[] = [];
  const push = (kind: HunkKind, words: string[]): void => {
    if (words.length === 0) return;
    const last = hunks[hunks.length - 1];
    if (last && last.kind === kind) {
      last.text = `${last.text} ${words.join(' ')}`;
      last.words += words.length;
      return;
    }
    hunks.push({ kind, text: words.join(' '), words: words.length });
  };

  push('same', a.slice(0, head));

  let coarse = false;

  if (midA.length === 0 || midB.length === 0) {
    // 한쪽만 남았다 — 순수 추가 또는 순수 삭제
    push('removed', midA);
    push('added', midB);
  } else if (midA.length * midB.length > LCS_CELL_LIMIT) {
    coarse = true;
    push('removed', midA);
    push('added', midB);
  } else {
    for (const step of lcsHunks(midA, midB)) push(step.kind, step.words);
  }

  push('same', a.slice(a.length - tail));

  let addedWords = 0;
  let removedWords = 0;
  let unchangedWords = 0;
  for (const hunk of hunks) {
    if (hunk.kind === 'added') addedWords += hunk.words;
    else if (hunk.kind === 'removed') removedWords += hunk.words;
    else unchangedWords += hunk.words;
  }

  return {
    hunks,
    addedWords,
    removedWords,
    unchangedWords,
    changedWords: addedWords + removedWords,
    coarse
  };
}

/** 표준 LCS DP + 역추적. 앞뒤를 이미 떼어낸 중간 구간에만 쓴다. */
function lcsHunks(a: string[], b: string[]): { kind: HunkKind; words: string[] }[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const index = i * cols + j;
      table[index] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[index + 1] ?? 0);
    }
  }

  const steps: { kind: HunkKind; words: string[] }[] = [];
  const emit = (kind: HunkKind, word: string): void => {
    const last = steps[steps.length - 1];
    if (last && last.kind === kind) last.words.push(word);
    else steps.push({ kind, words: [word] });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const wordA = a[i] as string;
    const wordB = b[j] as string;

    if (wordA === wordB) {
      emit('same', wordA);
      i += 1;
      j += 1;
      continue;
    }

    // 삭제와 추가 중 더 긴 공통 부분을 남기는 쪽을 고른다.
    if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + (j + 1)] ?? 0)) {
      emit('removed', wordA);
      i += 1;
    } else {
      emit('added', wordB);
      j += 1;
    }
  }

  while (i < a.length) {
    emit('removed', a[i] as string);
    i += 1;
  }
  while (j < b.length) {
    emit('added', b[j] as string);
    j += 1;
  }

  return steps;
}

export interface DiffResult extends WordDiff {
  url: string;
  from: { id: number; capturedAt: number };
  to: { id: number; capturedAt: number };
}

export class ChangeTracker {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  /**
   * 본문을 남긴다. 앞의 스냅샷과 내용이 같으면 새로 쌓지 않는다 —
   * 방문할 때마다 같은 본문을 쌓으면 이력이 잡음으로 덮인다.
   */
  snapshot(url: string, title: string, text: string): { snapshot: Snapshot; created: boolean } {
    const truncated = Buffer.byteLength(text, 'utf-8') > MAX_SNAPSHOT_BYTES;
    const stored = truncated ? truncateUtf8(text, MAX_SNAPSHOT_BYTES) : text;

    const previous = this.latest(url);
    if (previous && previous.text === stored) {
      return { snapshot: previous, created: false };
    }

    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO page_snapshots (url, title, text, bytes, truncated, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(url, title, stored, Buffer.byteLength(stored, 'utf-8'), truncated ? 1 : 0, now);

    return {
      snapshot: {
        id: Number(info.lastInsertRowid),
        url,
        title,
        text: stored,
        bytes: Buffer.byteLength(stored, 'utf-8'),
        truncated,
        capturedAt: now
      },
      created: true
    };
  }

  history(url: string, limit = 20): Snapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM page_snapshots WHERE url = ? ORDER BY id DESC LIMIT ?')
      .all(url, limit) as SnapshotRow[];
    return rows.map(toSnapshot);
  }

  latest(url: string): Snapshot | null {
    const row = this.db
      .prepare('SELECT * FROM page_snapshots WHERE url = ? ORDER BY id DESC LIMIT 1')
      .get(url) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  }

  get(id: number): Snapshot | null {
    const row = this.db.prepare('SELECT * FROM page_snapshots WHERE id = ?').get(id) as
      | SnapshotRow
      | undefined;
    return row ? toSnapshot(row) : null;
  }

  count(url: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM page_snapshots WHERE url = ?')
      .get(url) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** 추적 중인 주소 목록(이력 뷰). */
  trackedUrls(limit = 100): { url: string; title: string; snapshots: number; lastAt: number }[] {
    return this.db
      .prepare(
        `SELECT url,
                MAX(title)       AS title,
                COUNT(*)         AS snapshots,
                MAX(captured_at) AS lastAt
         FROM page_snapshots
         GROUP BY url
         ORDER BY lastAt DESC
         LIMIT ?`
      )
      .all(limit) as { url: string; title: string; snapshots: number; lastAt: number }[];
  }

  /**
   * 두 스냅샷을 비교한다. id 를 생략하면 **직전 ↔ 최신**을 본다.
   * 스냅샷이 하나뿐이면 비교 대상이 없으므로 null 이다.
   */
  diff(url: string, fromId?: number, toId?: number): DiffResult | null {
    const recent = this.history(url, 2);

    const to = toId === undefined ? recent[0] : this.get(toId);
    const from = fromId === undefined ? recent[1] : this.get(fromId);
    if (!to || !from) return null;

    return {
      url,
      from: { id: from.id, capturedAt: from.capturedAt },
      to: { id: to.id, capturedAt: to.capturedAt },
      ...diffWords(from.text, to.text)
    };
  }

  /** 보존 기간이 지난 스냅샷을 버린다. 주소별 최신 1건은 남긴다(비교 기준). */
  prune(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    return this.db
      .prepare(
        `DELETE FROM page_snapshots
         WHERE captured_at < ?
           AND id NOT IN (SELECT MAX(id) FROM page_snapshots GROUP BY url)`
      )
      .run(cutoff).changes;
  }
}
