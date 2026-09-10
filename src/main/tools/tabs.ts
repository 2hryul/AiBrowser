import { registerTool, requireTabId, ToolError, type Tool, type ToolContext } from './index';

/**
 * 탭 도구 4종 — Claude Browser 호환.
 * AI 가 만든 탭은 owner='ai' 로 표시되고 Handoff 가 소유권을 추적한다(불변 조건 2·3).
 */

interface TabInfo {
  tabId: number;
  /** 페이지가 스스로 정한 제목은 신뢰할 수 없으므로 origin 을 함께 준다. */
  origin: string;
  url: string;
  title: string;
  isActive: boolean;
  owner: 'human' | 'ai';
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function snapshot(ctx: ToolContext): TabInfo[] {
  return ctx.tabs.getState().tabs.map((tab) => ({
    tabId: tab.id,
    origin: originOf(tab.url),
    url: tab.url,
    title: tab.title,
    isActive: tab.id === ctx.tabs.activeTabId,
    owner: tab.owner
  }));
}

const tabsContext: Tool<Record<string, never>, { browserOpen: boolean; tabs: TabInfo[] }> = {
  name: 'tabs_context',
  description:
    '열려 있는 모든 탭을 나열한다. 페이지 제목은 페이지가 정하므로 origin 을 함께 본다. ' +
    'window.open 으로 열린 팝업도 여기에 새 탭으로 나타난다.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: {
      browserOpen: { type: 'boolean' },
      tabs: { type: 'array' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx) {
    return { browserOpen: true, tabs: snapshot(ctx) };
  }
};

const tabsCreate: Tool<{ url?: string; foreground?: boolean }, { tabId: number; url: string }> = {
  name: 'tabs_create',
  description:
    '새 탭을 연다. url 을 생략하면 홈이 열린다. foreground 를 true 로 주면 사람이 보는 탭이 바뀐다 — ' +
    '사람이 보고 있는 화면을 빼앗지 않도록 기본은 false 다.',
  input: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '열 주소' },
      foreground: { type: 'boolean', description: '앞으로 가져올지. 기본 false' }
    },
    additionalProperties: false
  },
  output: { type: 'object', properties: { tabId: { type: 'integer' }, url: { type: 'string' } } },
  sideEffect: 'navigate',
  irreversible: false,
  inverse(ctx, _args, result) {
    return {
      tool: 'tabs_create',
      describe: `탭 ${result.tabId} 닫기`,
      invert: async () => {
        ctx.tabs.closeTab(result.tabId);
      }
    };
  },
  async run(ctx, args) {
    const previousActive = ctx.tabs.activeTabId;
    const tabId = ctx.tabs.createTab(args.url, 'ai');

    // 기본은 배경 탭이다. AI 가 사람이 보는 화면을 가로채지 않는다(불변 조건 3).
    if (args.foreground !== true && previousActive !== null) {
      ctx.tabs.selectTab(previousActive);
    }

    const wc = ctx.tabs.getWebContents(tabId);
    if (wc) ctx.handoff.claimTab(tabId, ctx.threadId, wc);

    return { tabId, url: args.url ?? 'app://home/' };
  }
};

const tabsSelect: Tool<{ tabId: number }, { tabId: number; active: boolean }> = {
  name: 'tabs_select',
  description:
    '탭을 앞으로 가져온다. 사람이 보고 있는 탭을 AI 가 가로채지 않도록, AI 소유 탭만 선택할 수 있다.',
  input: {
    type: 'object',
    properties: { tabId: { type: 'integer', minimum: 1 } },
    required: ['tabId'],
    additionalProperties: false
  },
  output: { type: 'object', properties: { tabId: { type: 'integer' }, active: { type: 'boolean' } } },
  sideEffect: 'navigate',
  irreversible: false,
  inverse(ctx) {
    const previous = ctx.tabs.activeTabId;
    return {
      tool: 'tabs_select',
      describe: `이전 탭 ${previous} 로 복귀`,
      invert: async () => {
        if (previous !== null) ctx.tabs.selectTab(previous);
      }
    };
  },
  async run(ctx, args) {
    // 불변 조건 3: AI 는 사람이 보고 있는 탭을 tabs_select 하지 않는다.
    // 소유권의 근거는 TabManager 의 owner 다 — 팝업으로 열린 AI 탭도 여기서 ai 로 잡힌다.
    if (ctx.tabs.ownerOf(args.tabId) !== 'ai') {
      throw new ToolError(
        'not_ai_tab',
        `[tabs_select] 탭 ${args.tabId} 은(는) 사람 소유입니다. AI 는 사람이 보는 탭을 가로챌 수 없습니다.`
      );
    }

    ctx.tabs.selectTab(args.tabId);
    return { tabId: args.tabId, active: ctx.tabs.activeTabId === args.tabId };
  }
};

const tabsClose: Tool<{ tabId: number }, { closed: boolean; remaining: number }> = {
  name: 'tabs_close',
  description: '탭을 닫는다. 고정 탭과 사람 소유 탭은 닫지 않는다.',
  input: {
    type: 'object',
    properties: { tabId: { type: 'integer', minimum: 1 } },
    required: ['tabId'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: { closed: { type: 'boolean' }, remaining: { type: 'integer' } }
  },
  sideEffect: 'navigate',
  // 닫은 탭은 복구 스택에서 되살릴 수 있으므로 되돌릴 수 있다.
  irreversible: false,
  inverse(ctx) {
    return {
      tool: 'tabs_close',
      describe: '닫은 탭 복구',
      invert: async () => {
        ctx.tabs.restoreClosedTab();
      }
    };
  },
  async run(ctx, args) {
    if (ctx.tabs.ownerOf(args.tabId) !== 'ai') {
      throw new ToolError(
        'not_ai_tab',
        `[tabs_close] 탭 ${args.tabId} 은(는) 사람 소유입니다. AI 가 닫지 않습니다.`
      );
    }

    const before = ctx.tabs.getState().tabs.length;
    ctx.tabs.closeTab(args.tabId);
    ctx.handoff.releaseTab(args.tabId);

    const remaining = ctx.tabs.getState().tabs.length;
    return { closed: remaining < before, remaining };
  }
};

const previewStart: Tool<{ url: string }, { tabId: number; url: string; created: boolean }> = {
  name: 'preview_start',
  description:
    '주소를 새 탭(또는 이미 그 주소를 보고 있는 AI 탭)에서 연다. 작업 시작점을 잡을 때 쓴다. ' +
    'Claude Browser 의 preview_start 와 같은 이름이지만 개발 서버를 띄우지는 않는다 — url 만 받는다.',
  input: {
    type: 'object',
    properties: { url: { type: 'string', minLength: 1 } },
    required: ['url'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      url: { type: 'string' },
      created: { type: 'boolean' }
    }
  },
  sideEffect: 'navigate',
  irreversible: false,
  inverse(ctx, _args, result) {
    // 이미 있던 탭을 재사용했으면 닫지 않는다 — 남의 탭을 닫는 되돌리기는 되돌리기가 아니다.
    if (!result.created) return null;

    return {
      tool: 'preview_start',
      describe: `탭 ${result.tabId} 닫기`,
      invert: async () => {
        ctx.tabs.closeTab(result.tabId);
        ctx.handoff.releaseTab(result.tabId);
      }
    };
  },
  async run(ctx, args) {
    const existing = ctx.tabs
      .getState()
      .tabs.find((tab) => tab.owner === 'ai' && tab.url === args.url);

    if (existing) return { tabId: existing.id, url: args.url, created: false };

    const tabId = ctx.tabs.createTab(args.url, 'ai');
    const wc = ctx.tabs.getWebContents(tabId);
    if (wc) ctx.handoff.claimTab(tabId, ctx.threadId, wc);

    return { tabId, url: args.url, created: true };
  }
};

/** 다른 도구가 활성 탭 판정을 공유할 수 있게 노출한다. */
export function activeTabIdOf(ctx: ToolContext): number {
  return requireTabId(ctx);
}

export function registerTabTools(): void {
  registerTool(tabsContext);
  registerTool(tabsCreate);
  registerTool(tabsSelect);
  registerTool(tabsClose);
  registerTool(previewStart);
}
