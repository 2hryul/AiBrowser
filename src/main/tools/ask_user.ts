import { registerTool, type Tool } from './index';

/**
 * ask_user / request_access — 사람에게 묻는 두 도구.
 *
 * ask_user 는 AI 가 진행할 수 없을 때 쓴다: 로그인, 캡차, 판단이 필요한 분기.
 * request_access 는 아직 허용되지 않은 도메인에 처음 붙을 때 쓴다.
 *
 * M2 는 다이얼로그까지만 만든다. 승인 결과를 policy.json 에 남기는 것은 M3 다
 * (GOAL-M2 OUT OF SCOPE). 그래서 여기서는 매번 묻는다.
 */

interface AskArgs {
  question: string;
  options?: string[];
}

interface AskResult {
  answer: string;
  /** 사람이 답할 때까지 기다렸는지 */
  answered: boolean;
}

const askUser: Tool<AskArgs, AskResult> = {
  name: 'ask_user',
  description:
    '사람에게 묻고 답을 기다린다. 로그인·캡차처럼 AI 가 대신할 수 없는 상황, 또는 되돌릴 수 없는 ' +
    '선택 앞에서 쓴다. options 를 주면 버튼으로, 주지 않으면 자유 입력으로 묻는다.',
  input: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1 },
      options: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 6,
        description: '선택지. 생략하면 자유 입력'
      }
    },
    required: ['question'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: { answer: { type: 'string' }, answered: { type: 'boolean' } }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const result = await ctx.askUser(args.question, args.options ?? []);
    return { answer: result.answer, answered: result.answer !== '' };
  }
};

interface AccessArgs {
  host: string;
  reason: string;
}

interface AccessResult {
  host: string;
  granted: boolean;
  /** 승인 범위. M3 에서 once/thread/domain 으로 확장된다. */
  scope: 'once';
}

const requestAccess: Tool<AccessArgs, AccessResult> = {
  name: 'request_access',
  description:
    '아직 허용되지 않은 도메인에 접근하기 전에 사람의 허락을 받는다. 왜 필요한지(reason)를 함께 ' +
    '보여준다. M2 에서는 이번 한 번만 허용되며 기록되지 않는다 — 범위 있는 승인은 M3.',
  input: {
    type: 'object',
    properties: {
      host: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1 }
    },
    required: ['host', 'reason'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      host: { type: 'string' },
      granted: { type: 'boolean' },
      scope: { type: 'string' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const granted = await ctx.requestAccess(args.host, args.reason);
    return { host: args.host, granted, scope: 'once' };
  }
};

export function registerAskTools(): void {
  registerTool(askUser);
  registerTool(requestAccess);
}
