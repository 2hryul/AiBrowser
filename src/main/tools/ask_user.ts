import { registerTool, type Tool } from './index';

/**
 * ask_user — 사람에게 묻고 답을 기다린다.
 *
 * AI 가 진행할 수 없을 때 쓴다: 로그인, 캡차, 판단이 필요한 분기.
 * 도메인 접근 허락은 승인 3단계를 쓰는 별도 도구다(request_access.ts).
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

export function registerAskTools(): void {
  registerTool(askUser);
}
