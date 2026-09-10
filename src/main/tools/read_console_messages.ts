import type { WebContents } from 'electron';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, type Tool } from './index';

/**
 * read_console_messages — 페이지 콘솔 로그.
 *
 * CDP 대신 Electron 의 `console-message` 이벤트를 쓴다. 같은 정보를 주면서 CDP Runtime 을
 * 켜지 않아도 되고, 탭마다 붙였다 떼기가 간단하다. 링버퍼에 담아 둔다 —
 * 도구를 부르는 시점에는 이미 지나간 로그가 필요하기 때문이다.
 */

export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source: string;
  line: number;
  at: number;
}

const MAX_ENTRIES = 200;

const buffers = new Map<number, ConsoleEntry[]>();
const attached = new Set<number>();

/** Electron 의 level 숫자를 이름으로. 0=verbose, 1=info, 2=warning, 3=error */
const LEVELS: ConsoleEntry['level'][] = ['debug', 'info', 'warning', 'error'];

interface MessageDetailsLike {
  level?: number;
  message?: string;
  sourceUrl?: string;
  lineNumber?: number;
}

/**
 * `console-message` 인자 형태를 흡수한다.
 * 최신: (event, MessageDetails) / 과거: (event, level, message, line, sourceId)
 */
export function parseConsolePayload(payload: readonly unknown[]): ConsoleEntry | null {
  const second = payload[1];

  if (typeof second === 'object' && second !== null) {
    const details = second as MessageDetailsLike;
    if (typeof details.message !== 'string') return null;
    return {
      level: LEVELS[details.level ?? 1] ?? 'info',
      message: details.message,
      source: details.sourceUrl ?? '',
      line: details.lineNumber ?? 0,
      at: Date.now()
    };
  }

  if (typeof second === 'number' && typeof payload[2] === 'string') {
    return {
      level: LEVELS[second] ?? 'info',
      message: payload[2],
      source: typeof payload[4] === 'string' ? payload[4] : '',
      line: typeof payload[3] === 'number' ? payload[3] : 0,
      at: Date.now()
    };
  }

  return null;
}

/** 탭에 콘솔 수집을 붙인다. 도구 첫 호출과 AI 탭 생성 시점에 부른다. */
export function startConsoleCapture(wc: WebContents): void {
  if (attached.has(wc.id)) return;
  attached.add(wc.id);
  buffers.set(wc.id, []);

  // Electron 은 이 이벤트의 시그니처를 버전에 따라 바꿔 왔다(개별 인자 → MessageDetails).
  // 두 형태를 모두 받아 쓸 수 있게 런타임에서 판별한다.
  wc.on('console-message', (...payload: unknown[]) => {
    const entries = buffers.get(wc.id);
    if (!entries) return;

    const entry = parseConsolePayload(payload);
    if (!entry) return;

    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
  });

  wc.once('destroyed', () => {
    attached.delete(wc.id);
    buffers.delete(wc.id);
  });
}

interface Args {
  tabId?: number;
  onlyErrors?: boolean;
  pattern?: string;
  limit?: number;
}

interface Result {
  tabId: number;
  messages: ConsoleEntry[];
  /** 버퍼 상한 — 잘렸을 수 있음을 알린다. */
  bufferLimit: number;
}

const readConsoleMessages: Tool<Args, Result> = {
  name: 'read_console_messages',
  description:
    '페이지 콘솔에 찍힌 로그를 돌려준다. 페이지가 조용히 실패할 때(폼 검증 오류, XHR 실패) ' +
    '원인이 여기 남는다. 도구를 처음 부른 시점 이후의 로그가 쌓인다.',
  input: {
    type: 'object',
    properties: {
      onlyErrors: { type: 'boolean' },
      pattern: { type: 'string', description: '부분 문자열 필터' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      ...TAB_ID_PROPERTY
    },
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      messages: { type: 'array' },
      bufferLimit: { type: 'integer' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    startConsoleCapture(wc);

    const all = buffers.get(wc.id) ?? [];
    const filtered = all
      .filter((entry) => (args.onlyErrors === true ? entry.level === 'error' : true))
      .filter((entry) => (args.pattern ? entry.message.includes(args.pattern) : true))
      .slice(-(args.limit ?? 50));

    return { tabId, messages: filtered, bufferLimit: MAX_ENTRIES };
  }
};

export function registerReadConsoleMessagesTool(): void {
  registerTool(readConsoleMessages);
}
