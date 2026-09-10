import { evaluateInFrame, mainFrameId } from '../cdp/PageReader';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, type Tool } from './index';

/**
 * javascript — 페이지에서 표현식 평가.
 *
 * 진단·조회용이다. 이 도구로 UI 를 "구현" 하지 않는다.
 * sideEffect 는 'exec' 이고 irreversible 이다 — 무엇을 할지 알 수 없으므로 M3 Policy 가
 * 승인을 강제한다. M2 에서는 승인 계층이 없어 호출은 되지만, 계약상 표시는 지금 맞춰 둔다.
 *
 * 격리 월드에서 실행한다. 페이지 전역을 오염시키지 않고, 페이지 스크립트가 우리 코드를
 * 가로챌 수도 없다.
 */

interface Args {
  code: string;
  tabId?: number;
  /** 특정 iframe 안에서 실행. read_page 가 준 frameId. */
  frameId?: string;
}

interface Result {
  tabId: number;
  frameId: string;
  /** JSON 으로 직렬화된 결과. undefined 는 null 로 온다. */
  value: unknown;
  ok: boolean;
}

const javascriptTool: Tool<Args, Result> = {
  name: 'javascript',
  description:
    '페이지 안에서 자바스크립트 표현식을 평가한다(격리 월드). 마지막 표현식의 값이 돌아온다. ' +
    'await 를 쓸 수 있다. 진단·조회 용도이며, 되돌릴 수 없는 도구로 표시되어 있다.',
  input: {
    type: 'object',
    properties: {
      code: { type: 'string', minLength: 1, description: '평가할 표현식' },
      frameId: { type: 'string', description: 'read_page 가 준 iframe 식별자' },
      ...TAB_ID_PROPERTY
    },
    required: ['code'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      frameId: { type: 'string' },
      value: {},
      ok: { type: 'boolean' }
    }
  },
  sideEffect: 'exec',
  // 무엇을 실행할지 알 수 없으므로 역연산을 만들 수 없다 → 승인 대상(M3).
  irreversible: true,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);
    const frameId = args.frameId ?? (await mainFrameId(wc));

    // 표현식 결과를 받기 위해 즉시실행 함수로 감싼다. 사용자가 문장을 여러 줄 써도 동작한다.
    const wrapped = `(async () => { ${args.code} })()`;
    const value = await ctx.handoff.duringAction(() =>
      evaluateInFrame<unknown>(wc, frameId, wrapped)
    );

    return { tabId, frameId, value: value ?? null, ok: value !== null };
  }
};

export function registerJavascriptTool(): void {
  registerTool(javascriptTool);
}
