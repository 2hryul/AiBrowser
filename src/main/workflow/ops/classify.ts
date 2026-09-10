import type { ValueSource } from '../types';

/**
 * classify — 값을 정해진 enum 중 하나로 분류한다. **규칙 우선, LLM 폴백.**
 *
 * 세 가지가 이 연산의 계약이다:
 *
 *   1. **허용 목록 밖은 절대 나오지 않는다.** 규칙이든 LLM 이든 enum 에 없는 답을 내면
 *      `unknown` 으로 떨어뜨리고 `review: true` 를 단다. 모델이 지어낸 새 분류가
 *      워크플로우를 타고 흐르는 것이 가장 나쁘다.
 *   2. **규칙이 먼저다.** 규칙으로 정해지면 LLM 을 부르지 않는다 — 싸고 결정적이다.
 *   3. **LLM 이 답하면 출처가 `llm` 이다.** Verifier 가 그 값을 근거로 한 PASS 를 REVIEW 로
 *      내린다(provenance 규칙). 분류기가 스스로 판정을 낮추지 않는다 — 강등은 한 곳에서만.
 *
 * M4b(내장 LLM)가 아직 없으므로 폴백은 **주입 지점만** 열려 있다. 폴백이 없으면 `unknown`
 * + `review` 다. 조용히 첫 번째 enum 값을 고르는 식의 기본값은 두지 않는다.
 */

export interface ClassifyRule {
  /** 이 규칙이 고르는 분류 */
  label: string;
  /** 부분 일치할 낱말들(소문자 비교) */
  keywords?: string[];
  /** 정규식 */
  pattern?: string;
  /** 직접 판단 */
  test?: (value: string) => boolean;
}

/** LLM 폴백 주입점. M4b 의 LLMClient 가 이 모양으로 들어온다. */
export type ClassifyFallback = (input: {
  text: string;
  allowed: readonly string[];
}) => Promise<string | null>;

export interface ClassifySpec {
  /** 허용 분류 목록 — 이 밖의 값은 나올 수 없다 */
  allowed: readonly string[];
  rules?: readonly ClassifyRule[];
  /** 규칙으로 못 정했을 때 부를 폴백(선택) */
  fallback?: ClassifyFallback;
}

export interface ClassifyOutcome {
  label: string;
  source: ValueSource;
  /** 사람이 봐야 하는가 */
  review: boolean;
  /** 어떻게 정해졌는지 — 증거 팩에 남는다 */
  reason: string;
}

/** enum 밖으로 나갔을 때 쓰는 값. 워크플로우는 이걸 보고 멈추거나 REVIEW 로 간다. */
export const UNKNOWN_LABEL = 'unknown';

export async function classify(value: unknown, spec: ClassifySpec): Promise<ClassifyOutcome> {
  const text = String(value ?? '').trim();
  const allowed = new Set(spec.allowed);

  if (allowed.size === 0) {
    return {
      label: UNKNOWN_LABEL,
      source: 'const',
      review: true,
      reason: '허용 분류 목록이 비어 있습니다'
    };
  }

  // ── 1. 규칙 ──
  for (const rule of spec.rules ?? []) {
    if (!allowed.has(rule.label)) {
      // 설정 오류다. 규칙이 허용 목록 밖을 가리키면 그 규칙은 쓰지 않는다.
      continue;
    }

    if (matches(text, rule)) {
      return {
        label: rule.label,
        source: 'const',
        review: false,
        reason: `규칙 일치 (${rule.keywords?.join('·') ?? rule.pattern ?? 'test'})`
      };
    }
  }

  // ── 2. LLM 폴백 ──
  if (!spec.fallback) {
    return {
      label: UNKNOWN_LABEL,
      source: 'const',
      review: true,
      reason: '규칙으로 정하지 못했고 폴백이 없습니다'
    };
  }

  let answer: string | null = null;
  try {
    answer = await spec.fallback({ text, allowed: [...allowed] });
  } catch (error) {
    return {
      label: UNKNOWN_LABEL,
      source: 'llm',
      review: true,
      reason: `폴백 실패: ${(error as Error).message}`
    };
  }

  const cleaned = String(answer ?? '').trim();

  if (!allowed.has(cleaned)) {
    // 허용 목록 밖 — 모델이 지어낸 분류는 그대로 흘려보내지 않는다.
    return {
      label: UNKNOWN_LABEL,
      source: 'llm',
      review: true,
      reason: `허용 목록 밖 응답: "${cleaned}"`
    };
  }

  return {
    label: cleaned,
    source: 'llm',
    review: true,
    reason: 'LLM 폴백 — 근거가 LLM 이라 사람 확인 대상'
  };
}

function matches(text: string, rule: ClassifyRule): boolean {
  if (rule.test?.(text)) return true;

  if (rule.pattern !== undefined && new RegExp(rule.pattern, 'i').test(text)) return true;

  if (rule.keywords) {
    const lower = text.toLowerCase();
    if (rule.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) return true;
  }

  return false;
}
