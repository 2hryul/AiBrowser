import type { UndoEntry } from '../tools/index';

/**
 * UndoManager — 되돌리기 스택.
 *
 * 사람 UI(UndoPanel)와 AI 의 `undo` 도구가 **같은 스택**을 본다. 두 개를 따로 두면
 * 사람이 되돌린 것을 AI 가 다시 되돌리는 일이 생긴다.
 *
 * 실행 단위(runId)별 스택이다. M4 에서 threadId 로 승격된다.
 *
 * 봉인(sealed): 제출·상신처럼 서버에 반영된 뒤에는 되돌릴 수 없다. 그 사실을 감추지 않고
 * 항목에 표시해 사람이 "왜 안 되는지" 알 수 있게 한다.
 */

export interface UndoRecord {
  id: string;
  runId: string;
  tool: string;
  /** 사람이 읽을 설명 */
  describe: string;
  createdAt: number;
  undone: boolean;
  /** 제출 후 되돌릴 수 없음 */
  sealed: boolean;
  /** 봉인 사유 */
  sealedReason: string | null;
}

interface Slot extends UndoRecord {
  invert: () => Promise<void>;
}

/** 실행 단위별 상한. 무한히 쌓이면 메모리가 샌다. */
const STACK_LIMIT = 200;

export type UndoOutcome =
  | { ok: true; record: UndoRecord }
  | { ok: false; reason: 'empty' | 'sealed' | 'not_found' | 'failed'; message: string };

export class UndoManager {
  private readonly stacks = new Map<string, Slot[]>();
  /**
   * 마지막으로 바뀐 실행 단위. 셸의 UndoPanel 이 처음 열릴 때 무엇을 보여줄지 정한다 —
   * MCP 클라이언트가 만든 항목도 사람이 같은 목록에서 되돌릴 수 있어야 한다
   * (불변 조건: 사람 UI 와 AI 도구는 같은 스택을 본다).
   */
  private lastChangedRunId: string | null = null;
  private counter = 0;
  private readonly onChange: (runId: string, records: UndoRecord[]) => void;

  constructor(onChange: (runId: string, records: UndoRecord[]) => void) {
    this.onChange = onChange;
  }

  private stackOf(runId: string): Slot[] {
    const existing = this.stacks.get(runId);
    if (existing) return existing;
    const created: Slot[] = [];
    this.stacks.set(runId, created);
    return created;
  }

  /** 마지막으로 항목이 쌓인 실행 단위. 없으면 null. */
  activeRunId(): string | null {
    return this.lastChangedRunId;
  }

  /** 도구가 성공한 뒤 역연산을 등록한다. */
  push(runId: string, entry: UndoEntry): UndoRecord {
    this.counter += 1;
    const slot: Slot = {
      id: `undo-${this.counter}`,
      runId,
      tool: entry.tool,
      describe: entry.describe,
      createdAt: Date.now(),
      undone: false,
      sealed: false,
      sealedReason: null,
      invert: entry.invert
    };

    const stack = this.stackOf(runId);
    stack.push(slot);
    while (stack.length > STACK_LIMIT) stack.shift();

    this.lastChangedRunId = runId;
    this.emit(runId);
    return toRecord(slot);
  }

  /**
   * 제출이 일어났다 — 그 이전의 입력 항목을 봉인한다.
   *
   * 폼을 제출한 뒤 필드 값을 되돌려도 서버에 넘어간 것은 되돌아오지 않는다.
   * 되돌릴 수 있는 척하는 것이 가장 나쁘므로 여기서 못 박는다.
   */
  seal(runId: string, reason: string): number {
    let sealed = 0;
    for (const slot of this.stackOf(runId)) {
      if (slot.undone || slot.sealed) continue;
      if (slot.tool !== 'form_input' && slot.tool !== 'computer') continue;
      slot.sealed = true;
      slot.sealedReason = reason;
      sealed += 1;
    }

    if (sealed > 0) this.emit(runId);
    return sealed;
  }

  list(runId: string): UndoRecord[] {
    return this.stackOf(runId).map(toRecord).reverse();
  }

  /** 가장 최근에 되돌릴 수 있는 항목. */
  private topUndoable(runId: string): Slot | null {
    const stack = this.stackOf(runId);
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const slot = stack[index];
      if (slot && !slot.undone && !slot.sealed) return slot;
    }
    return null;
  }

  /**
   * 되돌린다. id 를 주지 않으면 가장 최근 항목.
   * 봉인된 항목을 지목하면 거부하고 사유를 알려 준다.
   */
  async undo(runId: string, id?: string): Promise<UndoOutcome> {
    const stack = this.stackOf(runId);
    const slot = id ? stack.find((item) => item.id === id) : this.topUndoable(runId);

    if (!slot) {
      // 지목한 id 가 있는데 못 찾았으면 not_found, 아니면 되돌릴 게 없다.
      if (id) return { ok: false, reason: 'not_found', message: `[undo] 항목을 찾지 못했습니다: ${id}` };

      const sealedExists = stack.some((item) => item.sealed && !item.undone);
      return sealedExists
        ? { ok: false, reason: 'sealed', message: '[undo] 남은 항목이 모두 봉인되었습니다(제출 후)' }
        : { ok: false, reason: 'empty', message: '[undo] 되돌릴 항목이 없습니다' };
    }

    if (slot.sealed) {
      return {
        ok: false,
        reason: 'sealed',
        message: `[undo] 봉인된 항목입니다: ${slot.sealedReason ?? '제출 후에는 되돌릴 수 없습니다'}`
      };
    }

    if (slot.undone) {
      return { ok: false, reason: 'not_found', message: '[undo] 이미 되돌린 항목입니다' };
    }

    try {
      await slot.invert();
    } catch (error) {
      return {
        ok: false,
        reason: 'failed',
        message: `[undo] 역연산 실패 - ${slot.describe}: ${(error as Error).message}`
      };
    }

    slot.undone = true;
    this.emit(runId);
    return { ok: true, record: toRecord(slot) };
  }

  clear(runId: string): void {
    this.stacks.delete(runId);
    this.emit(runId);
  }

  private emit(runId: string): void {
    this.onChange(runId, this.list(runId));
  }
}

function toRecord(slot: Slot): UndoRecord {
  return {
    id: slot.id,
    runId: slot.runId,
    tool: slot.tool,
    describe: slot.describe,
    createdAt: slot.createdAt,
    undone: slot.undone,
    sealed: slot.sealed,
    sealedReason: slot.sealedReason
  };
}
