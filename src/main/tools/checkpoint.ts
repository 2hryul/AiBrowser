import { registerTool, ToolError, type Tool } from './index';

/**
 * checkpoint_save / checkpoint_list / checkpoint_restore — 복구 지점.
 *
 * 400페이지를 도는 작업이 380페이지에서 끊겼을 때 처음부터 다시 하지 않으려면 진행 상태가
 * 남아야 한다. 자동 저장(10스텝·페이지 전환·ask_user 직전)은 도구 밖에서 걸리고,
 * 이 도구는 AI 가 "지금이 좋은 지점" 이라고 판단할 때 쓰는 수동 경로다.
 *
 * `cursor` 에는 작업 고유의 진행 표시를 아무 형태로나 담을 수 있다. 재개할 때 이 값을 그대로
 * 돌려받아 "어디까지 했는지" 를 이어 간다.
 */

interface SaveArgs {
  name: string;
  note?: string;
  /** 작업 고유 진행 상태(예: { nextId: 201 }) */
  cursor?: Record<string, unknown>;
  /** 지금까지 모은 결과 행. ResultsTable 로 그려진다. */
  results?: unknown[];
}

interface CheckpointView {
  id: number;
  name: string;
  note: string;
  trigger: string;
  messageIndex: number;
  tabs: number;
  results: number;
  cursor: Record<string, unknown>;
  createdAt: number;
}

const checkpointSave: Tool<SaveArgs, CheckpointView> = {
  name: 'checkpoint_save',
  description:
    '지금 상태를 복구 지점으로 저장한다. 열린 AI 탭(주소·세션·스크롤)은 자동으로 담기고, ' +
    'cursor 와 results 로 작업 진행 상태를 함께 남긴다. 앱이 종료돼도 여기서 이어갈 수 있다.',
  input: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      note: { type: 'string', maxLength: 500 },
      cursor: { type: 'object' },
      results: { type: 'array' }
    },
    required: ['name'],
    additionalProperties: false
  },
  output: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
  sideEffect: 'persist',
  irreversible: false,
  /** 저장한 체크포인트를 지운다. */
  inverse(ctx, _args, result) {
    return {
      tool: 'checkpoint_save',
      describe: `체크포인트 "${result.name}" 삭제`,
      invert: async () => {
        ctx.checkpoints.remove(result.id);
      }
    };
  },
  async run(ctx, args) {
    const saved = await ctx.saveCheckpoint({
      name: args.name,
      trigger: 'manual',
      ...(args.note === undefined ? {} : { note: args.note }),
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.results === undefined ? {} : { results: args.results })
    });

    return {
      id: saved.id,
      name: saved.name,
      note: saved.note,
      trigger: saved.trigger,
      messageIndex: saved.messageIndex,
      tabs: saved.payload.tabs.length,
      results: saved.payload.results.length,
      cursor: saved.payload.cursor,
      createdAt: saved.createdAt
    };
  }
};

interface ListResult {
  threadId: string;
  checkpoints: CheckpointView[];
}

const checkpointList: Tool<Record<string, never>, ListResult> = {
  name: 'checkpoint_list',
  description: '이 작업의 복구 지점을 최근 순으로 나열한다.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: { threadId: { type: 'string' }, checkpoints: { type: 'array' } }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx) {
    return {
      threadId: ctx.threadId,
      checkpoints: ctx.checkpoints.list(ctx.threadId).map((checkpoint) => ({
        id: checkpoint.id,
        name: checkpoint.name,
        note: checkpoint.note,
        trigger: checkpoint.trigger,
        messageIndex: checkpoint.messageIndex,
        tabs: checkpoint.payload.tabs.length,
        results: checkpoint.payload.results.length,
        cursor: checkpoint.payload.cursor,
        createdAt: checkpoint.createdAt
      }))
    };
  }
};

interface RestoreArgs {
  /** 생략하면 가장 최근 체크포인트 */
  id?: number;
}

interface RestoreResult {
  id: number;
  name: string;
  /** 복원해 다시 연 탭 */
  tabs: { tabId: number; url: string; sessionName: string }[];
  results: unknown[];
  cursor: Record<string, unknown>;
  messageIndex: number;
  /** 복원 직전 상태를 담아 둔 임시 체크포인트 — 되돌리기가 이 지점으로 돌아간다. */
  restorePoint: number;
}

const checkpointRestore: Tool<RestoreArgs, RestoreResult> = {
  name: 'checkpoint_restore',
  description:
    '복구 지점으로 돌아간다. 저장돼 있던 AI 탭을 다시 열고(스크롤 위치까지) 결과·진행 커서를 ' +
    '돌려준다. 복원 전 상태는 임시 체크포인트로 먼저 저장되므로 이 동작도 되돌릴 수 있다.',
  input: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
    additionalProperties: false
  },
  output: { type: 'object', properties: { id: { type: 'integer' }, tabs: { type: 'array' } } },
  sideEffect: 'navigate',
  irreversible: false,
  /**
   * 복원 전 상태를 임시 체크포인트로 저장해 두었으므로, 되돌리기는 그 지점으로 다시 복원하는 것이다.
   * (CLAUDE.md 지속성 도구 표: "복원 전 상태를 임시 체크포인트로 저장 후 되돌림")
   */
  inverse(ctx, _args, result) {
    const before = result.restorePoint;

    return {
      tool: 'checkpoint_restore',
      describe: '복원 전 상태로 되돌리기',
      invert: async () => {
        await ctx.restoreCheckpoint(before);
      }
    };
  },
  async run(ctx, args) {
    const target =
      args.id === undefined ? ctx.checkpoints.latest(ctx.threadId) : ctx.checkpoints.get(args.id);

    if (!target) {
      throw new ToolError('no_checkpoint', '[checkpoint_restore] 복구 지점이 없습니다');
    }

    // 복원 전 상태를 먼저 남긴다 — 이 동작 자체를 되돌릴 수 있게.
    const before = await ctx.saveCheckpoint({
      name: `복원 전 (${target.name})`,
      trigger: 'resume',
      note: '자동 저장'
    });

    const restored = await ctx.restoreCheckpoint(target.id);

    return {
      id: target.id,
      name: target.name,
      tabs: restored.tabs,
      results: target.payload.results,
      cursor: target.payload.cursor,
      messageIndex: target.messageIndex,
      restorePoint: before.id
    };
  }
};

export function registerCheckpointTools(): void {
  registerTool(checkpointSave);
  registerTool(checkpointList);
  registerTool(checkpointRestore);
}
