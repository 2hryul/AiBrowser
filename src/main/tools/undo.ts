import { registerTool, type Tool } from './index';
import type { UndoRecord } from '../persistence/UndoManager';

/**
 * undo_list / undo — AI 도 되돌릴 수 있다.
 *
 * 사람 UI(UndoPanel)와 **같은 스택**을 본다. 두 개를 따로 두면 사람이 되돌린 것을 AI 가
 * 다시 되돌리는 일이 생긴다. AI 는 자기 실행 단위(runId)의 항목만 되돌릴 수 있다.
 */

interface ListResult {
  runId: string;
  entries: UndoRecord[];
  /** 되돌릴 수 있는 항목 수 */
  undoable: number;
  /** 제출 후 봉인된 항목 수 */
  sealed: number;
}

const undoList: Tool<Record<string, never>, ListResult> = {
  name: 'undo_list',
  description:
    '되돌릴 수 있는 항목을 최근 순으로 나열한다. sealed 가 true 인 항목은 제출·상신 이후라 ' +
    '되돌릴 수 없다 — 사유가 sealedReason 에 있다.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: {
      runId: { type: 'string' },
      entries: { type: 'array' },
      undoable: { type: 'integer' },
      sealed: { type: 'integer' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx) {
    const entries = ctx.undo.list(ctx.runId);
    return {
      runId: ctx.runId,
      entries,
      undoable: entries.filter((entry) => !entry.undone && !entry.sealed).length,
      sealed: entries.filter((entry) => entry.sealed).length
    };
  }
};

interface UndoArgs {
  /** 지정하지 않으면 가장 최근 항목 */
  id?: string;
}

interface UndoResult {
  ok: boolean;
  /** 되돌린 항목 */
  record: UndoRecord | null;
  reason: string | null;
  message: string | null;
}

const undoTool: Tool<UndoArgs, UndoResult> = {
  name: 'undo',
  description:
    '가장 최근 작업을 되돌린다. id 를 주면 그 항목을 되돌린다. 제출·상신 이후 봉인된 항목은 ' +
    '되돌릴 수 없고, 그 사실을 사유와 함께 알려 준다. 되돌리기 자체는 다시 되돌릴 수 없다.',
  input: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1 } },
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      record: {},
      reason: { type: ['string', 'null'] },
      message: { type: ['string', 'null'] }
    }
  },
  // 되돌리기의 되돌리기(재실행)는 만들지 않는다. 그래서 inverse 가 없고 irreversible 이다.
  sideEffect: 'write',
  irreversible: true,
  async run(ctx, args) {
    const outcome = await ctx.undo.undo(ctx.runId, args.id);

    if (outcome.ok) {
      return { ok: true, record: outcome.record, reason: null, message: null };
    }
    return { ok: false, record: null, reason: outcome.reason, message: outcome.message };
  }
};

export function registerUndoTools(): void {
  registerTool(undoList);
  registerTool(undoTool);
}
