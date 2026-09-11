import cron, { type ScheduledTask } from 'node-cron';
import type { WorkflowRunner, WorkflowRunOutcome } from '../workflow/Runner';

/**
 * 예약 실행 — cron 으로 워크플로우를 돌리고 결과를 받은편지함에 넣는다.
 *
 * 루틴의 값은 사람이 없을 때 도는 것이다. 그래서 결과를 화면에 띄우지 않고 **받은편지함**에
 * 남긴다: 판정과 증거 팩 경로가 함께 들어가므로, 아침에 항목 하나를 열면 근거까지 바로 간다.
 *
 * 실패도 항목이다. 조용히 빠지면 "어제 안 돌았다" 를 아무도 모른다 —
 * `ADAPTER_BROKEN` 은 `failed`, 그 밖의 판정은 `result` 로 넣는다.
 */

export interface ScheduleInput {
  id: string;
  workflowId: string;
  /** 5칸 또는 6칸 cron 식 */
  cron: string;
  /** 실행마다 넘길 입력. `date` 가 없으면 실행 시각의 날짜를 넣는다. */
  inputs?: Record<string, unknown>;
  description?: string;
}

export interface ScheduleEntry extends ScheduleInput {
  nextNote: string;
  createdAt: number;
  lastRunAt: number | null;
  lastVerdict: string | null;
  runCount: number;
}

export interface SchedulerOptions {
  runner: WorkflowRunner;
  post: (input: {
    kind: 'result' | 'failed';
    title: string;
    summary: string;
    evidencePath: string;
    threadId: string;
  }) => void;
  /** 테스트가 시각을 고정한다 */
  now?: () => Date;
}

/** `2026-03-04` — 로케일에 의존하지 않게 직접 만든다. */
function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly entries = new Map<string, ScheduleEntry>();
  private readonly running = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  list(): ScheduleEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 예약을 등록한다. 같은 id 는 덮어쓴다(설정 화면에서 식을 고치는 경우).
   * cron 식이 틀리면 등록하지 않고 던진다 — 조용히 안 도는 예약이 최악이다.
   */
  add(input: ScheduleInput): ScheduleEntry {
    if (!cron.validate(input.cron)) {
      throw new Error(`[scheduler] cron 식이 올바르지 않습니다: "${input.cron}"`);
    }

    this.remove(input.id);

    const entry: ScheduleEntry = {
      ...input,
      nextNote: `cron ${input.cron}`,
      createdAt: Date.now(),
      lastRunAt: null,
      lastVerdict: null,
      runCount: 0
    };

    this.entries.set(input.id, entry);

    const task = cron.schedule(input.cron, () => {
      void this.fire(input.id);
    });

    this.tasks.set(input.id, task);
    return entry;
  }

  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      void task.destroy?.();
      this.tasks.delete(id);
    }
    return this.entries.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.tasks.keys()]) this.remove(id);
  }

  /** 예약을 기다리지 않고 지금 한 번 돌린다(설정 화면의 "지금 실행", 테스트). */
  async fire(id: string): Promise<WorkflowRunOutcome | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;

    // 앞 실행이 아직 안 끝났으면 겹쳐 돌리지 않는다 — 같은 탭·같은 포털을 두 번 만진다.
    if (this.running.has(id)) {
      console.warn(`[scheduler] ${id} 앞 실행이 끝나지 않아 이번 차례를 건너뜁니다`);
      return null;
    }

    this.running.add(id);
    const now = this.options.now ?? (() => new Date());

    try {
      const inputs = { date: isoDate(now()), ...(entry.inputs ?? {}) };
      const runId = `${entry.workflowId}-${id}-${Date.now().toString(36)}`;

      const outcome = await this.options.runner.run(entry.workflowId, inputs, {
        runId,
        threadId: `schedule:${id}`
      });

      entry.lastRunAt = Date.now();
      entry.lastVerdict = outcome.verdict;
      entry.runCount += 1;

      const failed = outcome.verdict === 'ADAPTER_BROKEN' || outcome.status === 'failed';

      this.options.post({
        kind: failed ? 'failed' : 'result',
        title: `${entry.workflowId} ${String(inputs['date'])} — ${outcome.verdict}`,
        summary: summarize(outcome),
        evidencePath: outcome.evidence.dir,
        threadId: `schedule:${id}`
      });

      return outcome;
    } catch (error) {
      entry.lastRunAt = Date.now();
      entry.lastVerdict = 'ERROR';
      entry.runCount += 1;

      this.options.post({
        kind: 'failed',
        title: `${entry.workflowId} 실행 실패`,
        summary: `[scheduler] ${id} 실행 중 오류 - ${(error as Error).message}`,
        evidencePath: '',
        threadId: `schedule:${id}`
      });

      return null;
    } finally {
      this.running.delete(id);
    }
  }
}

/** 받은편지함 한 줄. 판정과 그 근거가 되는 오라클 이름까지 넣어 열지 않고도 짐작되게 한다. */
function summarize(outcome: WorkflowRunOutcome): string {
  const failing = outcome.oracles.filter((oracle) => !oracle.ok);
  const sources = outcome.sources.map((step) => `${step.adapter}:${step.source}`).join(' · ');

  if (failing.length === 0) {
    return `오라클 ${outcome.oracles.length}개 통과 · ${sources} · ${outcome.durationMs}ms`;
  }

  return `${failing.map((oracle) => `${oracle.rule}(${oracle.verdict}) ${oracle.message}`).join(' / ')} · ${sources}`;
}
