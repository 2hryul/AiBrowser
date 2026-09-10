import { readPage, type AxNode } from '../cdp/PageReader';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, type Tool } from './index';

/**
 * find — 페이지에서 요소를 찾는다.
 *
 * M2 는 **1차 규칙 매칭만** 한다(GOAL IN SCOPE). LLM 을 붙인 2차 추론은 M4 다.
 * 규칙은 사람이 화면에서 요소를 고르는 방식을 흉내낸다: 정확 일치 → 접두 → 부분 → 정규화 부분.
 */

interface Args {
  query: string;
  tabId?: number;
  /** 특정 역할로 좁힌다(예: button, link). */
  role?: string;
  limit?: number;
}

export interface FindMatch extends AxNode {
  /** 어떤 규칙으로 맞았는지 — 왜 이게 나왔는지 설명 가능해야 한다. */
  rule: 'exact' | 'prefix' | 'substring' | 'normalized' | 'value';
  score: number;
}

interface Result {
  tabId: number;
  query: string;
  matches: FindMatch[];
  /** 규칙으로 못 찾았을 때 AI 가 다음 수를 정할 수 있게 알려 준다. */
  searchedNodes: number;
}

/** 공백·구두점을 걷어내 "로그 인" 과 "로그인" 을 같게 본다. */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    // \s 는 전각 공백(U+3000)까지 포함하므로 한국어 UI 에도 그대로 통한다.
    .replace(/\s+/g, '')
    .replace(/[.,!?()[\]{}·:;'"-]/g, '');
}

/** 규칙 5종. 점수가 높은 것이 먼저 온다. */
export function matchRule(
  nodeText: string,
  query: string
): { rule: FindMatch['rule']; score: number } | null {
  const text = nodeText.trim();
  if (text === '') return null;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.trim().toLowerCase();
  if (lowerQuery === '') return null;

  if (lowerText === lowerQuery) return { rule: 'exact', score: 100 };
  if (lowerText.startsWith(lowerQuery)) return { rule: 'prefix', score: 80 };
  if (lowerText.includes(lowerQuery)) return { rule: 'substring', score: 60 };

  const normalizedText = normalizeForMatch(text);
  const normalizedQuery = normalizeForMatch(query);
  if (normalizedQuery !== '' && normalizedText.includes(normalizedQuery)) {
    return { rule: 'normalized', score: 40 };
  }

  return null;
}

const findTool: Tool<Args, Result> = {
  name: 'find',
  description:
    '페이지에서 이름(접근성 이름)이 질의와 맞는 요소를 찾는다. 정확 일치 → 접두 → 부분 → ' +
    '공백·구두점 무시 순으로 점수를 매겨 돌려준다. 반환된 ref 로 바로 클릭할 수 있다. ' +
    '규칙으로만 찾으며 추론은 하지 않는다.',
  input: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: '찾을 문구' },
      role: { type: 'string', description: 'button, link 처럼 역할로 좁히기' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      ...TAB_ID_PROPERTY
    },
    required: ['query'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      query: { type: 'string' },
      matches: { type: 'array' },
      searchedNodes: { type: 'integer' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    // find 는 ref 를 돌려주므로 read_page 와 같은 매핑을 써야 한다 — 여기서 함께 갱신된다.
    const page = await readPage(wc, { limit: 500 });
    const limit = args.limit ?? 10;

    const matches: FindMatch[] = [];

    for (const node of page.nodes) {
      if (args.role && node.role !== args.role) continue;

      const byName = matchRule(node.name, args.query);
      if (byName) {
        matches.push({ ...node, rule: byName.rule, score: byName.score });
        continue;
      }

      // 이름이 비어 있는 입력은 현재 값으로도 찾을 수 있게 한다.
      if (node.value) {
        const byValue = matchRule(node.value, args.query);
        if (byValue) matches.push({ ...node, rule: 'value', score: byValue.score - 20 });
      }
    }

    matches.sort((a, b) => b.score - a.score || a.name.length - b.name.length);

    return {
      tabId,
      query: args.query,
      matches: matches.slice(0, limit),
      searchedNodes: page.nodes.length
    };
  }
};

export function registerFindTool(): void {
  registerTool(findTool);
}
