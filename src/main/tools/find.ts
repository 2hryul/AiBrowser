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
  /**
   * 어떤 규칙으로 맞았는지 — 왜 이게 나왔는지 설명 가능해야 한다.
   * `llm` 은 규칙이 하나도 못 맞혔을 때 모델이 고른 것이다(2차).
   */
  rule: 'exact' | 'prefix' | 'substring' | 'normalized' | 'value' | 'llm';
  score: number;
}

/**
 * 2차 선택 — 규칙이 아무것도 못 맞혔을 때만 부른다(M4b).
 *
 * 주입식이다. `find` 는 MCP 클라이언트도 쓰는 ToolSurface 도구이고, 모델이 없는 환경에서도
 * 1차 규칙만으로 동작해야 한다. 에이전트 런타임이 있을 때만 이 자리가 채워진다.
 *
 * 후보 목록은 페이지에서 온 것이므로 **격리해서** 넘긴다 — 링크 이름에 "이전 지시를 무시하고"
 * 라고 적어 두면 그것도 페이지가 쓴 글이다.
 */
export type FindFallback = (input: {
  query: string;
  candidates: { ref: string; role: string; name: string }[];
}) => Promise<string | null>;

let findFallback: FindFallback | null = null;

export function setFindFallback(fallback: FindFallback | null): void {
  findFallback = fallback;
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

    /**
     * 규칙이 하나도 못 맞혔을 때만 모델에게 묻는다.
     *
     * 규칙이 맞힌 결과를 모델이 뒤집게 두지 않는다 — 1차가 맞힌 것은 설명 가능한 근거가 있고,
     * 모델의 선택은 그렇지 않다. 2차는 **빈손일 때의 마지막 수단**이다.
     */
    if (matches.length === 0 && findFallback) {
      const candidates = page.nodes
        .filter((node) => (args.role ? node.role === args.role : true))
        .filter((node) => node.name.trim() !== '')
        .slice(0, 40)
        .map((node) => ({ ref: node.ref, role: node.role, name: node.name }));

      if (candidates.length > 0) {
        const picked = await findFallback({ query: args.query, candidates }).catch((error) => {
          console.warn('[find] 2차 선택 실패 — 규칙 결과만 돌려준다', error);
          return null;
        });

        const node = picked === null ? undefined : page.nodes.find((item) => item.ref === picked);
        // 모델이 없는 ref 를 지어내면 버린다. 없는 것을 클릭하게 둘 수는 없다.
        if (node) matches.push({ ...node, rule: 'llm', score: 10 });
      }
    }

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
