import type { HelmDatabase } from './Database';

/**
 * ThreadStore — 사람과 AI 의 대화·작업 단위.
 *
 * 중단은 정상 흐름이다(불변 조건 6). 그래서 스레드는 메모리에 없고 DB 에 있다 —
 * 앱이 죽어도 다음 실행에서 같은 스레드에 이어 말할 수 있어야 한다.
 *
 * 재시작 시 `running` 은 **`paused` 로 내린다**. 실행 중이던 도구 호출은 프로세스와 함께
 * 사라졌으므로 "돌고 있다" 고 표시하면 거짓말이 된다. 사람이 "이어서" 를 누르면
 * 마지막 체크포인트에서 재개한다.
 */

export type ThreadStatus =
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'waiting_login'
  | 'done'
  | 'failed';

export const THREAD_STATUSES: readonly ThreadStatus[] = [
  'running',
  'paused',
  'waiting_approval',
  'waiting_login',
  'done',
  'failed'
];

/** 기본 스텝 상한. 장시간 모드는 2,000 이고 체크포인트가 필수다(CLAUDE.md 내장 에이전트). */
export const DEFAULT_STEP_LIMIT = 60;
export const LONG_RUN_STEP_LIMIT = 2000;

export type MessageRole = 'human' | 'ai' | 'system' | 'tool';

export interface Thread {
  id: string;
  title: string;
  status: ThreadStatus;
  sessionName: string;
  stepCount: number;
  stepLimit: number;
  closedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadMessage {
  id: number;
  threadId: string;
  seq: number;
  role: MessageRole;
  text: string;
  tool: string | null;
  /** 도구 인자 — 마스킹된 값만 넣는다(자격증명·PII 금지) */
  args: unknown;
  result: unknown;
  createdAt: number;
}

export interface CreateThreadInput {
  title?: string;
  sessionName?: string;
  /** 장시간 작업이면 LONG_RUN_STEP_LIMIT */
  stepLimit?: number;
  /** 테스트가 id 를 고정할 때 */
  id?: string;
}

export interface AppendMessageInput {
  role: MessageRole;
  text?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
}

interface ThreadRow {
  id: string;
  title: string;
  status: string;
  session_name: string;
  step_count: number;
  step_limit: number;
  closed_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  thread_id: string;
  seq: number;
  role: string;
  text: string;
  tool: string | null;
  args: string | null;
  result: string | null;
  created_at: number;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    status: row.status as ThreadStatus,
    sessionName: row.session_name,
    stepCount: row.step_count,
    stepLimit: row.step_limit,
    closedReason: row.closed_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** JSON 파싱 실패는 데이터 손실이 아니라 표시 문제다 — null 로 떨어뜨리고 계속 간다. */
function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role as MessageRole,
    text: row.text,
    tool: row.tool,
    args: parseJson(row.args),
    result: parseJson(row.result),
    createdAt: row.created_at
  };
}

export class ThreadStore {
  private readonly db: HelmDatabase;
  private counter = 0;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  private nextId(): string {
    this.counter += 1;
    return `t-${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }

  create(input: CreateThreadInput = {}): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: input.id ?? this.nextId(),
      title: input.title ?? '',
      status: 'running',
      sessionName: input.sessionName ?? 'default',
      stepCount: 0,
      stepLimit: input.stepLimit ?? DEFAULT_STEP_LIMIT,
      closedReason: null,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO threads (id, title, status, session_name, step_count, step_limit, closed_reason, created_at, updated_at)
         VALUES (@id, @title, @status, @sessionName, @stepCount, @stepLimit, NULL, @createdAt, @updatedAt)`
      )
      .run(thread);

    return thread;
  }

  get(id: string): Thread | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | ThreadRow
      | undefined;
    return row ? toThread(row) : null;
  }

  list(limit = 100): Thread[] {
    const rows = this.db
      .prepare('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as ThreadRow[];
    return rows.map(toThread);
  }

  setStatus(id: string, status: ThreadStatus, closedReason?: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE threads SET status = ?, closed_reason = COALESCE(?, closed_reason), updated_at = ?
         WHERE id = ?`
      )
      .run(status, closedReason ?? null, Date.now(), id);
    return result.changes > 0;
  }

  setTitle(id: string, title: string): boolean {
    const result = this.db
      .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
    return result.changes > 0;
  }

  setSession(id: string, sessionName: string): boolean {
    const result = this.db
      .prepare('UPDATE threads SET session_name = ?, updated_at = ? WHERE id = ?')
      .run(sessionName, Date.now(), id);
    return result.changes > 0;
  }

  /** 스텝 상한을 바꾼다(장시간 모드 진입). */
  setStepLimit(id: string, stepLimit: number): boolean {
    const result = this.db
      .prepare('UPDATE threads SET step_limit = ?, updated_at = ? WHERE id = ?')
      .run(stepLimit, Date.now(), id);
    return result.changes > 0;
  }

  /**
   * 스텝을 하나 진행한다.
   * @returns 진행 후 스텝 수와 상한 초과 여부. 초과면 호출자가 멈춰야 한다.
   */
  step(id: string): { count: number; limit: number; exceeded: boolean } {
    this.db
      .prepare('UPDATE threads SET step_count = step_count + 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);

    const thread = this.get(id);
    const count = thread?.stepCount ?? 0;
    const limit = thread?.stepLimit ?? DEFAULT_STEP_LIMIT;
    return { count, limit, exceeded: count > limit };
  }

  append(threadId: string, input: AppendMessageInput): ThreadMessage {
    const now = Date.now();
    const seq = this.messageCount(threadId) + 1;

    const info = this.db
      .prepare(
        `INSERT INTO thread_messages (thread_id, seq, role, text, tool, args, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        threadId,
        seq,
        input.role,
        input.text ?? '',
        input.tool ?? null,
        input.args === undefined ? null : JSON.stringify(input.args),
        input.result === undefined ? null : JSON.stringify(input.result),
        now
      );

    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, threadId);

    return {
      id: Number(info.lastInsertRowid),
      threadId,
      seq,
      role: input.role,
      text: input.text ?? '',
      tool: input.tool ?? null,
      args: input.args ?? null,
      result: input.result ?? null,
      createdAt: now
    };
  }

  /** @param fromSeq 이 번호 **이후**(초과)만 가져온다. 체크포인트 복원 지점에서 이어 읽을 때. */
  messages(threadId: string, fromSeq = 0): ThreadMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM thread_messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC')
      .all(threadId, fromSeq) as MessageRow[];
    return rows.map(toMessage);
  }

  messageCount(threadId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM thread_messages WHERE thread_id = ?')
      .get(threadId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * 앱 재시작 복구: `running` 이던 스레드를 `paused` 로 내린다.
   * @returns 내려간 스레드 수
   */
  recoverInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE threads SET status = 'paused', closed_reason = ?, updated_at = ?
         WHERE status IN ('running', 'waiting_approval')`
      )
      .run('앱이 종료되어 일시정지되었습니다', Date.now());
    return result.changes;
  }

  remove(id: string): boolean {
    // thread_messages·checkpoints 는 ON DELETE CASCADE 로 함께 지워진다.
    return this.db.prepare('DELETE FROM threads WHERE id = ?').run(id).changes > 0;
  }
}
