import type { HelmDatabase } from './Database';

/**
 * Inbox — 결과와 요청이 모이는 곳.
 *
 * 장시간·헤드리스 작업의 출력은 화면이 아니라 여기다. 루틴 결과, MCP 클라이언트의 완료 보고,
 * 승인·로그인 요청이 모두 항목으로 쌓이고, 읽지 않은 수가 사이드바 배지가 된다.
 *
 * M3 은 승인 대기를 메모리 큐로만 들고 있었다(앱을 닫으면 사라졌다). 여기에 `approval` 항목을
 * 함께 남기면 "무엇을 승인해 달라고 했는지" 가 재시작 후에도 남는다.
 */

export type InboxKind = 'result' | 'approval' | 'login_required' | 'done' | 'failed';

export const INBOX_KINDS: readonly InboxKind[] = [
  'result',
  'approval',
  'login_required',
  'done',
  'failed'
];

export interface InboxItem {
  id: number;
  kind: InboxKind;
  threadId: string | null;
  title: string;
  summary: string;
  /** 근거 파일(스크린샷·CSV) 경로. 본문을 DB 에 넣지 않는다. */
  evidencePath: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface PostInput {
  kind: InboxKind;
  title: string;
  threadId?: string;
  summary?: string;
  evidencePath?: string;
}

interface InboxRow {
  id: number;
  kind: string;
  thread_id: string | null;
  title: string;
  summary: string;
  evidence_path: string | null;
  created_at: number;
  read_at: number | null;
}

function toItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    kind: row.kind as InboxKind,
    threadId: row.thread_id,
    title: row.title,
    summary: row.summary,
    evidencePath: row.evidence_path,
    createdAt: row.created_at,
    readAt: row.read_at
  };
}

export class Inbox {
  private readonly db: HelmDatabase;
  private readonly onChange: () => void;

  constructor(db: HelmDatabase, onChange: () => void = () => undefined) {
    this.db = db;
    this.onChange = onChange;
  }

  post(input: PostInput): InboxItem {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO inbox (kind, thread_id, title, summary, evidence_path, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        input.kind,
        input.threadId ?? null,
        input.title,
        input.summary ?? '',
        input.evidencePath ?? null,
        now
      );

    this.onChange();

    return {
      id: Number(info.lastInsertRowid),
      kind: input.kind,
      threadId: input.threadId ?? null,
      title: input.title,
      summary: input.summary ?? '',
      evidencePath: input.evidencePath ?? null,
      createdAt: now,
      readAt: null
    };
  }

  list(options: { unreadOnly?: boolean; threadId?: string; limit?: number } = {}): InboxItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.unreadOnly) clauses.push('read_at IS NULL');
    if (options.threadId) {
      clauses.push('thread_id = ?');
      params.push(options.threadId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit ?? 200);

    const rows = this.db
      .prepare(`SELECT * FROM inbox ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params) as InboxRow[];
    return rows.map(toItem);
  }

  get(id: number): InboxItem | null {
    const row = this.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as InboxRow | undefined;
    return row ? toItem(row) : null;
  }

  unreadCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE read_at IS NULL').get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  markRead(id: number): boolean {
    const changed =
      this.db.prepare('UPDATE inbox SET read_at = ? WHERE id = ? AND read_at IS NULL').run(
        Date.now(),
        id
      ).changes > 0;
    if (changed) this.onChange();
    return changed;
  }

  markAllRead(): number {
    const changes = this.db
      .prepare('UPDATE inbox SET read_at = ? WHERE read_at IS NULL')
      .run(Date.now()).changes;
    if (changes > 0) this.onChange();
    return changes;
  }

  remove(id: number): boolean {
    const changed = this.db.prepare('DELETE FROM inbox WHERE id = ?').run(id).changes > 0;
    if (changed) this.onChange();
    return changed;
  }

  /** 보존 기간이 지난 읽은 항목을 버린다. 읽지 않은 것은 남긴다. */
  prune(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const changes = this.db
      .prepare('DELETE FROM inbox WHERE read_at IS NOT NULL AND created_at < ?')
      .run(cutoff).changes;
    if (changes > 0) this.onChange();
    return changes;
  }
}
