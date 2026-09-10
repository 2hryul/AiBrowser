import { registerTool, ToolError, type Tool } from './index';

/**
 * session_list / session_use — 이름 붙인 세션.
 *
 * 사내에서는 시스템마다 계정이 다르다. 세션을 바꾸면 **다음에 만드는 탭**이 그 파티션에서
 * 열린다. 이미 열린 탭의 세션은 바뀌지 않는다 — 열려 있는 로그인 상태를 뒤에서 갈아치우면
 * 사람이 보고 있는 화면과 실제 계정이 어긋난다.
 */

interface SessionView {
  name: string;
  partition: string;
  current: boolean;
  loginMethod: string | null;
  loggedInAt: number | null;
  /** 이 세션으로 열려 있는 탭 수 */
  tabs: number;
}

interface ListResult {
  current: string;
  sessions: SessionView[];
}

const sessionList: Tool<Record<string, never>, ListResult> = {
  name: 'session_list',
  description:
    '이름 붙인 세션 목록. 세션은 쿠키·localStorage 묶음이고, 시스템마다 다른 계정을 동시에 ' +
    '쓸 때 나눈다. current 가 다음에 만들 탭이 쓰는 세션이다.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: { current: { type: 'string' }, sessions: { type: 'array' } }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx) {
    const current = ctx.sessions.currentName();
    const tabs = ctx.tabs.getState().tabs;

    return {
      current,
      sessions: ctx.sessions.list().map((info) => ({
        name: info.name,
        partition: info.partition,
        current: info.name === current,
        loginMethod: info.loginMethod,
        loggedInAt: info.loggedInAt,
        tabs: tabs.filter((tab) => tab.sessionName === info.name).length
      }))
    };
  }
};

interface UseArgs {
  name: string;
}

interface UseResult {
  name: string;
  partition: string;
  previous: string;
  created: boolean;
}

const sessionUse: Tool<UseArgs, UseResult> = {
  name: 'session_use',
  description:
    '다음에 만들 탭이 쓸 세션을 정한다. 없는 이름이면 새로 만든다(소문자·숫자·-·_ 로 32자 이내). ' +
    '이미 열린 탭의 세션은 바뀌지 않는다.',
  input: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 32 } },
    required: ['name'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      partition: { type: 'string' },
      previous: { type: 'string' },
      created: { type: 'boolean' }
    }
  },
  sideEffect: 'persist',
  irreversible: false,
  /** 이전 세션으로 되돌린다. 탭을 건드리지 않으므로 완전히 되돌아간다. */
  inverse(ctx, _args, result) {
    return {
      tool: 'session_use',
      describe: `세션을 ${result.previous} 로 되돌리기`,
      invert: async () => {
        ctx.sessions.use(result.previous);
      }
    };
  },
  async run(ctx, args) {
    const previous = ctx.sessions.currentName();
    const existed = ctx.sessions.get(args.name) !== null;
    const info = ctx.sessions.use(args.name);

    if (!info) {
      throw new ToolError(
        'invalid_session_name',
        `[session_use] 쓸 수 없는 이름입니다: ${args.name} (소문자·숫자·-·_ 로 시작하고 32자 이내)`
      );
    }

    return { name: info.name, partition: info.partition, previous, created: !existed };
  }
};

export function registerSessionTools(): void {
  registerTool(sessionList);
  registerTool(sessionUse);
}
