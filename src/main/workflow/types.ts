/**
 * 검증 계층의 공용 타입.
 *
 * 두 가지가 이 파일의 핵심이고 나머지는 거기 딸린 것이다.
 *
 * ## 1. 판정은 세 값이고 합성은 최악값이다
 *
 * `FAIL > REVIEW > PASS`. 오라클 하나가 FAIL 이면 전체가 FAIL 이다. "대체로 맞으니 PASS"
 * 같은 합성은 없다 — 틀린 것을 맞다고 말하는 쪽이 언제나 더 비싸다.
 * `ADAPTER_BROKEN` 은 그보다 앞선다: **판정할 수 없었다**는 사실이 오답보다 먼저 알려져야 한다.
 *
 * ## 2. 값은 출처를 들고 다닌다 (provenance)
 *
 * `source: 'llm'` 인 값이 PASS 의 근거에 쓰이면 그 오라클은 자동으로 REVIEW 로 내려간다.
 * **LLM 은 PASS 를 만들 수 없다.** 추출이 그럴듯해 보여도 사람이 한 번 봐야 한다는 뜻이고,
 * 이 규칙이 없으면 "모델이 잘 뽑았다" 는 믿음이 검증을 대신하게 된다.
 */

/** 값을 어디서 얻었는가. 구조화 우선 사다리의 순서이기도 하다. */
export type ValueSource = 'api' | 'network' | 'dom' | 'file' | 'llm' | 'const';

/** 사다리 순서 — 앞쪽이 더 믿을 만하다. */
export const SOURCE_LADDER: readonly ValueSource[] = ['api', 'network', 'dom', 'file', 'llm'];

export type Verdict = 'PASS' | 'REVIEW' | 'FAIL' | 'ADAPTER_BROKEN';

/** 합성 우선순위. 숫자가 클수록 강하다. */
const VERDICT_RANK: Record<Verdict, number> = {
  PASS: 0,
  REVIEW: 1,
  FAIL: 2,
  ADAPTER_BROKEN: 3
};

/**
 * 판정 합성 — 최악값. 빈 목록은 PASS 가 아니라 REVIEW 다.
 *
 * 오라클이 하나도 돌지 않았는데 PASS 를 내면 "검증했다" 는 거짓이 된다.
 * (워크플로우 로드 단계에서 빈 `oracles` 를 거부하지만, 실행 중 전부 건너뛰는 경우가 남는다.)
 */
export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'REVIEW';

  return verdicts.reduce<Verdict>(
    (worst, current) => (VERDICT_RANK[current] > VERDICT_RANK[worst] ? current : worst),
    'PASS'
  );
}

/** 출처를 들고 다니는 값. 규칙은 값이 아니라 이것을 본다. */
export interface Provenanced<T> {
  value: T;
  source: ValueSource;
  /** 어느 단계에서 얻었는가 — 증거 팩에서 되짚을 수 있게 */
  step?: string;
  /** 어댑터 이름·버전 */
  adapter?: string;
  adapterVersion?: number;
}

export function provenanced<T>(
  value: T,
  source: ValueSource,
  extra: Omit<Provenanced<T>, 'value' | 'source'> = {}
): Provenanced<T> {
  return { value, source, ...extra };
}

/** 이 값들 중 하나라도 LLM 에서 왔는가. PASS 강등 판정의 근거다. */
export function hasLlmSource(values: readonly Provenanced<unknown>[]): boolean {
  return values.some((item) => item.source === 'llm');
}

// ─────────────────────────────────────────────────────────────
// 규칙
// ─────────────────────────────────────────────────────────────

/** 규칙이 실패했을 때의 심각도. 기본은 fail. */
export type RuleSeverity = 'fail' | 'review';

export interface RuleContext {
  /** 워크플로우가 만든 이름 → 값. 출처가 붙어 있다. */
  values: Record<string, Provenanced<unknown>>;
  /** 이 규칙이 근거로 삼은 값 이름 — provenance 강등 판정에 쓴다 */
  used: string[];
}

export interface RuleResult {
  /** 규칙이 통과했는가(심각도 적용 전) */
  ok: boolean;
  /** 사람이 읽을 한 줄 */
  message: string;
  /** 실측값 — 증거 팩과 리포트에 그대로 남는다 */
  detail: Record<string, unknown>;
}

export interface Rule<Args = Record<string, unknown>> {
  id: string;
  /** 무엇을 보는 규칙인가 */
  description: string;
  /** 인자 검증. 잘못된 오라클 설정은 로드 시점에 걸러야 한다. */
  validate: (args: unknown) => Args;
  run: (args: Args, context: RuleContext) => RuleResult;
}

/** 오라클 = 규칙 + 인자 + 심각도. 워크플로우 YAML 의 `oracles` 항목이 이 모양이다. */
export interface OracleSpec {
  rule: string;
  args: Record<string, unknown>;
  severity: RuleSeverity;
  /** 사람이 붙인 설명(선택) */
  note?: string | undefined;
}

export interface OracleOutcome {
  rule: string;
  severity: RuleSeverity;
  verdict: Verdict;
  ok: boolean;
  message: string;
  detail: Record<string, unknown>;
  /** 근거로 쓴 값의 출처 — provenance 강등을 설명할 수 있어야 한다 */
  sources: { name: string; source: ValueSource }[];
  /** LLM 출처 때문에 PASS 가 REVIEW 로 내려갔는가 */
  downgraded: boolean;
}
