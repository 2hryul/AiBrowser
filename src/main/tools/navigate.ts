import {
  registerTool,
  requireTabId,
  requireWebContents,
  TAB_ID_PROPERTY,
  ToolError,
  type Tool
} from './index';

/**
 * navigate — 주소 이동, 뒤로/앞으로.
 *
 * 리다이렉트하는 페이지로 이동하면 `loadURL` 이 ERR_ABORTED 로 거부된다(정상 흐름).
 * 그 경우도 실패로 보지 않고 최종 URL 을 돌려준다 — 세션 만료 → 로그인 페이지 흐름이
 * 바로 이 모양이라, 여기서 던지면 AI 가 상황을 볼 수 없다.
 */

interface NavigateArgs {
  url: string;
  tabId?: number;
  /** 이동 후 로딩 완료까지 기다리는 최대 시간(ms) */
  timeoutMs?: number;
}

interface NavigateResult {
  tabId: number;
  requestedUrl: string;
  /** 리다이렉트가 있었다면 최종 주소 */
  finalUrl: string;
  title: string;
  redirected: boolean;
}

/**
 * 상대 주소를 지금 보고 있는 페이지 기준으로 푼다.
 *
 * 브라우저가 링크를 따라갈 때 늘 하는 일이고, 도구가 안 하면 **`?page=2` 같은 지극히
 * 자연스러운 이동이 거절된다.** 실측에서 내장 에이전트가 1페이지를 정확히 수집한 뒤
 * `navigate{url:"?page=2"}` 로 다음 장을 넘기려다 `bad_url` 을 맞고 멈췄다
 * (artifacts/m4b). 사람이 주소창에 치는 것과 달리 여기 오는 값은 **주소**이므로,
 * 검색어로 해석하지 않고 현재 문서 기준으로 풀어 주는 것이 맞다.
 *
 * 절대 주소는 그대로 둔다. 풀 수 없으면 원래 값을 돌려주고 판단은 아래에 맡긴다.
 */
export function resolveRelativeUrl(input: string, currentUrl: string): string {
  const value = input.trim();
  if (value === '' || currentUrl === '') return value;

  // 상대 주소로 볼 수 있는 모양만 푼다 — 옴니박스처럼 검색어를 받는 자리가 아니다.
  if (!/^[?#]|^\.{1,2}\/|^\//.test(value)) return value;

  try {
    return new URL(value, currentUrl).toString();
  } catch {
    return value;
  }
}

/** 이동이 끝났다고 볼 때까지 기다린다. */
async function waitSettled(wc: Electron.WebContents, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // did-stop-loading 을 놓칠 수 있어 폴링으로 확인한다. 리다이렉트가 연쇄로 일어나도 안전하다.
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return;
    if (!wc.isLoading()) {
      // 리다이렉트 스크립트가 곧바로 다음 이동을 시작할 수 있어 한 박자 더 본다.
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (!wc.isLoading()) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const navigate: Tool<NavigateArgs, NavigateResult> = {
  name: 'navigate',
  description:
    '탭을 주어진 주소로 이동시키고 로딩이 끝날 때까지 기다린다. 페이지가 다시 이동(리다이렉트)하면 ' +
    'finalUrl 이 요청한 주소와 달라지고 redirected 가 true 가 된다 — 세션 만료 감지에 쓴다.',
  input: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, description: '이동할 주소' },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
      ...TAB_ID_PROPERTY
    },
    required: ['url'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      requestedUrl: { type: 'string' },
      finalUrl: { type: 'string' },
      title: { type: 'string' },
      redirected: { type: 'boolean' }
    }
  },
  sideEffect: 'navigate',
  irreversible: false,
  inverse(ctx, args) {
    const tabId = args.tabId ?? ctx.tabs.activeTabId;
    return {
      tool: 'navigate',
      describe: '이전 페이지로',
      invert: async () => {
        if (tabId !== null && tabId !== undefined) ctx.tabs.goBack(tabId);
      }
    };
  },
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    // `?page=2` 처럼 지금 페이지 기준의 주소를 받는다. 브라우저가 링크에 늘 하는 일이다.
    const requestedUrl = resolveRelativeUrl(args.url, wc.getURL());

    if (!ctx.tabs.navigate(tabId, requestedUrl)) {
      throw new ToolError('bad_url', `[navigate] 이동할 수 없는 주소입니다: ${args.url}`);
    }

    await waitSettled(wc, args.timeoutMs ?? 15000);

    const finalUrl = wc.getURL();
    return {
      tabId,
      requestedUrl,
      finalUrl,
      title: wc.getTitle(),
      // 쿼리 인코딩 차이는 무시하고 경로가 달라졌을 때만 리다이렉트로 본다.
      redirected: normalize(finalUrl) !== normalize(requestedUrl)
    };
  }
};

function normalize(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

interface HistoryArgs {
  tabId?: number;
  direction: 'back' | 'forward';
}

const navigateHistory: Tool<HistoryArgs, { tabId: number; url: string; moved: boolean }> = {
  name: 'navigate_history',
  description: '탭의 뒤로/앞으로. Claude Browser 는 navigate 에 back/forward 문자열을 받지만, ' +
    '주소와 섞이면 오탐이 생겨 별도 도구로 분리했다(docs/tool-compat.md).',
  input: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['back', 'forward'] },
      ...TAB_ID_PROPERTY
    },
    required: ['direction'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      url: { type: 'string' },
      moved: { type: 'boolean' }
    }
  },
  sideEffect: 'navigate',
  irreversible: false,
  inverse(ctx, args, result) {
    // 반대 방향으로 한 걸음. 실제로 움직이지 않았으면 되돌릴 것도 없다.
    if (!result.moved) return null;

    return {
      tool: 'navigate_history',
      describe: args.direction === 'back' ? '앞으로' : '뒤로',
      invert: async () => {
        if (args.direction === 'back') ctx.tabs.goForward(result.tabId);
        else ctx.tabs.goBack(result.tabId);
      }
    };
  },
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);
    const before = wc.getURL();

    if (args.direction === 'back') ctx.tabs.goBack(tabId);
    else ctx.tabs.goForward(tabId);

    await waitSettled(wc, 10000);
    const url = wc.getURL();
    return { tabId, url, moved: url !== before };
  }
};

export function registerNavigateTools(): void {
  registerTool(navigate);
  registerTool(navigateHistory);
}
