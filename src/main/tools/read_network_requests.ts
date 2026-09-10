import { NET_BODY_LIMIT_BYTES, readRequests, startTap, tapStats, type NetEntry } from '../cdp/NetTap';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, type Tool } from './index';

/**
 * read_network_requests — XHR/fetch 응답을 읽는다.
 *
 * SPA 는 화면에 12행만 그려도 JSON 에는 137건이 들어 있다. DOM 을 긁는 대신 응답을 읽는 편이
 * 정확하고 싸다(포털 B 시나리오). 본문은 요청 시점에 받아 두지 않으면 사라지므로,
 * 이 도구를 한 번 호출한 뒤부터 도청이 켜진다 — 조작 전에 먼저 켜 두는 것이 맞다.
 */

interface Args {
  tabId?: number;
  urlPattern?: string;
  includeBody?: boolean;
  limit?: number;
}

interface Result {
  tabId: number;
  requests: NetEntry[];
  /** 본문 보관 상한과 현재 사용량 — 왜 본문이 비었는지 알 수 있게 함께 준다. */
  bodyLimitBytes: number;
  bodyBytesUsed: number;
  bodiesEvicted: number;
}

const readNetworkRequests: Tool<Args, Result> = {
  name: 'read_network_requests',
  description:
    '탭이 주고받은 요청 목록과 JSON/텍스트 응답 본문을 돌려준다. urlPattern 으로 좁힌다(정규식 또는 ' +
    `부분 문자열). 첫 호출 시점부터 기록을 시작하므로, 조회 버튼을 누르기 전에 한 번 불러 두어야 ` +
    `응답을 놓치지 않는다. 본문 보관 상한은 ${Math.round(NET_BODY_LIMIT_BYTES / 1024)}KB 이고, ` +
    '넘으면 오래된 본문부터 버려지고 bodyEvicted 로 표시된다.',
  input: {
    type: 'object',
    properties: {
      urlPattern: { type: 'string', description: '정규식 또는 부분 문자열' },
      includeBody: { type: 'boolean', description: '기본 true. false 면 메타데이터만' },
      limit: { type: 'integer', minimum: 1, maximum: 300 },
      ...TAB_ID_PROPERTY
    },
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      requests: { type: 'array' },
      bodyLimitBytes: { type: 'integer' },
      bodyBytesUsed: { type: 'integer' },
      bodiesEvicted: { type: 'integer' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    // 도청은 첫 호출에서 켜진다. 이미 켜져 있으면 그대로 둔다.
    await startTap(wc);

    const query: Parameters<typeof readRequests>[1] = {};
    if (args.urlPattern !== undefined) query.urlPattern = args.urlPattern;
    if (args.includeBody !== undefined) query.includeBody = args.includeBody;
    if (args.limit !== undefined) query.limit = args.limit;

    const requests = readRequests(wc, query);
    const stats = tapStats(wc);

    return {
      tabId,
      requests,
      bodyLimitBytes: NET_BODY_LIMIT_BYTES,
      bodyBytesUsed: stats.bodyBytes,
      bodiesEvicted: stats.evicted
    };
  }
};

export function registerReadNetworkRequestsTool(): void {
  registerTool(readNetworkRequests);
}
