import type { Bookmark } from '../../shared/types';
import { checkForSecrets, type NoteRejection } from './NoteStore';
import type { HelmDatabase } from './Database';

/**
 * BookmarkMeta — 북마크에 붙는 AI 용 힌트.
 *
 * 사람에게 북마크는 "다시 갈 곳" 이지만 에이전트에게는 "무엇을 해야 하는 곳" 이다.
 * 그래서 의도(intent)·기대 콘텐츠·핵심 필드·요령을 따로 적어 둔다. 에이전트는 navigate 전에
 * `bookmark_list(query)` 로 관련 북마크를 찾아 이 힌트를 먼저 읽는다.
 *
 * 이 값도 프롬프트에 실리므로 메모와 같은 규칙으로 자격증명·개인정보를 거부한다.
 */

export interface BookmarkMetaValue {
  bookmarkId: number;
  /** 이 북마크로 무엇을 하려는가 */
  intent: string;
  /** 열면 무엇이 보여야 하는가 — 화면이 바뀌었는지 판단하는 기준 */
  expectedContent: string;
  /** 뽑아야 하는 필드 이름들 */
  keyFields: string[];
  /** 이 사이트를 다룰 때의 요령 */
  agentHints: string;
  updatedAt: number;
}

export interface BookmarkWithMeta {
  bookmark: Bookmark;
  meta: BookmarkMetaValue | null;
}

export type MetaWriteResult = { ok: true; meta: BookmarkMetaValue } | NoteRejection;

interface MetaRow {
  bookmark_id: number;
  intent: string;
  expected_content: string;
  key_fields: string;
  agent_hints: string;
  updated_at: number;
}

function parseFields(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toMeta(row: MetaRow): BookmarkMetaValue {
  return {
    bookmarkId: row.bookmark_id,
    intent: row.intent,
    expectedContent: row.expected_content,
    keyFields: parseFields(row.key_fields),
    agentHints: row.agent_hints,
    updatedAt: row.updated_at
  };
}

export interface MetaInput {
  intent?: string;
  expectedContent?: string;
  keyFields?: string[];
  agentHints?: string;
}

export class BookmarkMeta {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  get(bookmarkId: number): BookmarkMetaValue | null {
    const row = this.db
      .prepare('SELECT * FROM bookmark_meta WHERE bookmark_id = ?')
      .get(bookmarkId) as MetaRow | undefined;
    return row ? toMeta(row) : null;
  }

  set(bookmarkId: number, input: MetaInput): MetaWriteResult {
    const merged: MetaInput = { ...(this.get(bookmarkId) ?? {}), ...input };
    const joined = [
      merged.intent ?? '',
      merged.expectedContent ?? '',
      (merged.keyFields ?? []).join(' '),
      merged.agentHints ?? ''
    ].join('\n');

    const rejection = checkForSecrets(joined);
    if (rejection) return rejection;

    const now = Date.now();
    const value: BookmarkMetaValue = {
      bookmarkId,
      intent: merged.intent ?? '',
      expectedContent: merged.expectedContent ?? '',
      keyFields: merged.keyFields ?? [],
      agentHints: merged.agentHints ?? '',
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO bookmark_meta (bookmark_id, intent, expected_content, key_fields, agent_hints, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bookmark_id) DO UPDATE SET
           intent = excluded.intent,
           expected_content = excluded.expected_content,
           key_fields = excluded.key_fields,
           agent_hints = excluded.agent_hints,
           updated_at = excluded.updated_at`
      )
      .run(
        bookmarkId,
        value.intent,
        value.expectedContent,
        JSON.stringify(value.keyFields),
        value.agentHints,
        now
      );

    return { ok: true, meta: value };
  }

  remove(bookmarkId: number): boolean {
    return (
      this.db.prepare('DELETE FROM bookmark_meta WHERE bookmark_id = ?').run(bookmarkId).changes > 0
    );
  }

  /**
   * 북마크와 메타를 함께 돌려준다. `bookmark_list` 도구가 쓰는 경로다.
   * @param query 제목·주소·의도·힌트에서 부분 일치(대소문자 무시)
   */
  listWithBookmarks(query = '', limit = 50): BookmarkWithMeta[] {
    const rows = this.db
      .prepare(
        `SELECT b.id, b.title, b.url, b.folder, b.position, b.created_at AS createdAt,
                m.bookmark_id, m.intent, m.expected_content, m.key_fields, m.agent_hints, m.updated_at
         FROM bookmarks b
         LEFT JOIN bookmark_meta m ON m.bookmark_id = b.id
         ORDER BY b.position ASC, b.id ASC`
      )
      .all() as (Bookmark & Partial<MetaRow>)[];

    const needle = query.trim().toLowerCase();

    const mapped: BookmarkWithMeta[] = rows.map((row) => ({
      bookmark: {
        id: row.id,
        title: row.title,
        url: row.url,
        folder: row.folder,
        position: row.position,
        createdAt: row.createdAt
      },
      meta:
        row.bookmark_id === undefined || row.bookmark_id === null
          ? null
          : toMeta({
              bookmark_id: row.bookmark_id,
              intent: row.intent ?? '',
              expected_content: row.expected_content ?? '',
              key_fields: row.key_fields ?? '[]',
              agent_hints: row.agent_hints ?? '',
              updated_at: row.updated_at ?? 0
            })
    }));

    if (needle === '') return mapped.slice(0, limit);

    return mapped
      .filter((entry) => {
        const haystack = [
          entry.bookmark.title,
          entry.bookmark.url,
          entry.meta?.intent ?? '',
          entry.meta?.expectedContent ?? '',
          entry.meta?.agentHints ?? '',
          (entry.meta?.keyFields ?? []).join(' ')
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      })
      .slice(0, limit);
  }
}
