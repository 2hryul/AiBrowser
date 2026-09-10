import type { HelmDatabase } from './Database';

/**
 * CheckpointStore — 복구 지점.
 *
 * 장시간 작업이 중간에 끊겼을 때 처음부터 다시 하지 않으려면 "어디까지 했는지" 가 남아야 한다.
 * 체크포인트는 그 최소 집합이다: 열린 AI 탭(주소·세션·스크롤), 지금까지의 결과표,
 * 스레드 메시지 위치, 메모 버전, 그리고 작업 고유의 진행 커서.
 *
 * 자동 저장 트리거(CLAUDE.md): 10스텝마다 · 페이지 전환마다 · ask_user 직전.
 * 수동은 사람 버튼 또는 AI `checkpoint_save`.
 */

export type CheckpointTrigger = 'manual' | 'steps' | 'navigate' | 'ask_user' | 'resume';

/** 자동 저장 간격(스텝). */
export const AUTO_CHECKPOINT_STEPS = 10;

export interface CheckpointTab {
  url: string;
  sessionName: string;
  scrollY: number;
  /** 저장 당시의 탭 id — 복원 후에는 달라진다(참고용) */
  tabId?: number;
  title?: string;
}

export interface CheckpointPayload {
  tabs: CheckpointTab[];
  /** ResultsTable 행. 출처 URL·단계 번호를 포함한 채로 저장한다. */
  results: unknown[];
  /** 복원 시 어느 메모 버전을 기준으로 볼지 */
  noteVersions: { scope: string; version: number }[];
  /**
   * 작업 고유의 진행 상태. 순회 작업이면 "다음에 볼 항목" 이 여기 들어간다.
   * 형태를 고정하지 않는 대신 JSON 으로만 저장한다.
   */
  cursor: Record<string, unknown>;
}

export interface Checkpoint {
  id: number;
  threadId: string;
  name: string;
  note: string;
  trigger: CheckpointTrigger;
  /** 저장 시점의 마지막 메시지 seq — 복원 후 여기 이후만 새로 읽는다 */
  messageIndex: number;
  payload: CheckpointPayload;
  createdAt: number;
}

interface CheckpointRow {
  id: number;
  thread_id: string;
  name: string;
  note: string;
  trigger_kind: string;
  message_index: number;
  payload: string;
  created_at: number;
}

export const EMPTY_PAYLOAD: CheckpointPayload = {
  tabs: [],
  results: [],
  noteVersions: [],
  cursor: {}
};

function parsePayload(raw: string): CheckpointPayload {
  try {
    const parsed = JSON.parse(raw) as Partial<CheckpointPayload>;
    return {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
      results: Array.isArray(parsed.results) ? parsed.results : [],
      noteVersions: Array.isArray(parsed.noteVersions) ? parsed.noteVersions : [],
      cursor:
        parsed.cursor !== null && typeof parsed.cursor === 'object'
          ? (parsed.cursor as Record<string, unknown>)
          : {}
    };
  } catch {
    // 깨진 체크포인트를 던지면 스레드 전체를 못 읽는다. 빈 것으로 보고 계속 간다.
    return { ...EMPTY_PAYLOAD };
  }
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    threadId: row.thread_id,
    name: row.name,
    note: row.note,
    trigger: row.trigger_kind as CheckpointTrigger,
    messageIndex: row.message_index,
    payload: parsePayload(row.payload),
    createdAt: row.created_at
  };
}

export interface SaveCheckpointInput {
  threadId: string;
  name: string;
  note?: string;
  trigger: CheckpointTrigger;
  messageIndex: number;
  payload?: Partial<CheckpointPayload>;
}

/** 스레드별 보관 상한. 넘으면 오래된 것부터 버린다(가장 최근 것은 항상 남는다). */
const KEEP_PER_THREAD = 50;

export class CheckpointStore {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  save(input: SaveCheckpointInput): Checkpoint {
    const now = Date.now();
    const payload: CheckpointPayload = { ...EMPTY_PAYLOAD, ...input.payload };

    const info = this.db
      .prepare(
        `INSERT INTO checkpoints (thread_id, name, note, trigger_kind, message_index, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.threadId,
        input.name,
        input.note ?? '',
        input.trigger,
        input.messageIndex,
        JSON.stringify(payload),
        now
      );

    this.prune(input.threadId);

    return {
      id: Number(info.lastInsertRowid),
      threadId: input.threadId,
      name: input.name,
      note: input.note ?? '',
      trigger: input.trigger,
      messageIndex: input.messageIndex,
      payload,
      createdAt: now
    };
  }

  list(threadId: string, limit = KEEP_PER_THREAD): Checkpoint[] {
    const rows = this.db
      .prepare('SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
      .all(threadId, limit) as CheckpointRow[];
    return rows.map(toCheckpoint);
  }

  get(id: number): Checkpoint | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as
      | CheckpointRow
      | undefined;
    return row ? toCheckpoint(row) : null;
  }

  /** 가장 최근 체크포인트. "이어서" 가 여기서 재개한다. */
  latest(threadId: string): Checkpoint | null {
    const row = this.db
      .prepare('SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT 1')
      .get(threadId) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : null;
  }

  count(threadId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?')
      .get(threadId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id).changes > 0;
  }

  private prune(threadId: string, keep = KEEP_PER_THREAD): number {
    const result = this.db
      .prepare(
        `DELETE FROM checkpoints
         WHERE thread_id = ?
           AND id NOT IN (SELECT id FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT ?)`
      )
      .run(threadId, threadId, keep);
    return result.changes;
  }
}
