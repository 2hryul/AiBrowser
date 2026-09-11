import { getRule } from './rules/index';
import { lookupProvenanced } from './values';
import {
  hasLlmSource,
  worstVerdict,
  type OracleOutcome,
  type OracleSpec,
  type Provenanced,
  type RuleContext,
  type Verdict
} from './types';

/**
 * Verifier — 오라클을 돌려 PASS / REVIEW / FAIL 을 낸다.
 *
 * 여기가 "오탐 0" 을 지키는 자리다. 지키는 방법은 규칙을 똑똑하게 만드는 것이 아니라
 * **판정을 낮추는 경로만 두는 것**이다:
 *
 *   - 규칙이 실패하면 심각도에 따라 FAIL 또는 REVIEW. PASS 로 올릴 길은 없다
 *   - 근거 값 중 하나라도 `source: 'llm'` 이면 PASS 는 REVIEW 로 내려간다
 *   - 어댑터가 깨졌으면 오라클을 아예 돌리지 않고 `ADAPTER_BROKEN` — 판정할 수 없었다는
 *     사실이 오답보다 먼저 알려져야 한다
 *   - 오라클이 하나도 없으면 REVIEW (로드 단계에서도 막지만 이중으로 둔다)
 */

export interface VerifyInput {
  values: Record<string, Provenanced<unknown>>;
  oracles: readonly OracleSpec[];
  /** 어댑터가 깨졌다면 그 사유. 있으면 오라클을 돌리지 않는다. */
  adapterBroken?: string | null;
}

export interface VerifyResult {
  verdict: Verdict;
  outcomes: OracleOutcome[];
  /** LLM 출처 때문에 내려간 오라클 수 */
  downgraded: number;
  adapterBroken: string | null;
}

export function verify(input: VerifyInput): VerifyResult {
  const broken = input.adapterBroken ?? null;

  if (broken) {
    return {
      verdict: 'ADAPTER_BROKEN',
      outcomes: [],
      downgraded: 0,
      adapterBroken: broken
    };
  }

  const outcomes: OracleOutcome[] = [];

  for (const oracle of input.oracles) {
    outcomes.push(runOracle(oracle, input.values));
  }

  return {
    verdict: worstVerdict(outcomes.map((outcome) => outcome.verdict)),
    outcomes,
    downgraded: outcomes.filter((outcome) => outcome.downgraded).length,
    adapterBroken: null
  };
}

function runOracle(
  oracle: OracleSpec,
  values: Record<string, Provenanced<unknown>>
): OracleOutcome {
  const rule = getRule(oracle.rule);

  if (!rule) {
    // 없는 규칙을 조용히 건너뛰면 "검증했다" 는 거짓이 된다.
    return {
      rule: oracle.rule,
      ruleVersion: 0,
      severity: oracle.severity,
      verdict: 'FAIL',
      ok: false,
      message: `없는 규칙: ${oracle.rule}`,
      detail: {},
      sources: [],
      downgraded: false
    };
  }

  const context: RuleContext = { values, used: [] };

  let result;
  try {
    const args = rule.validate(oracle.args) as never;
    result = rule.run(args, context);
  } catch (error) {
    return {
      rule: oracle.rule,
      ruleVersion: rule.version,
      severity: oracle.severity,
      verdict: 'FAIL',
      ok: false,
      message: `규칙 실행 실패: ${(error as Error).message}`,
      detail: { args: oracle.args },
      sources: [],
      downgraded: false
    };
  }

  // 근거 값의 출처는 경로 조회로 얻는다. `recon.onlyLeft` 처럼 안쪽을 가리킨 오라클도
  // 머리(`recon`)의 출처를 보게 되어 LLM 강등을 건너뛰지 않는다.
  const used = [...new Set(context.used)];
  const entries = used.map((name) => ({ name, entry: lookupProvenanced(values, name) }));

  const sources = entries.map(({ name, entry }) => ({
    name,
    source: entry?.source ?? ('const' as const)
  }));

  const llmBacked = hasLlmSource(
    entries.map(({ entry }) => entry).filter((item) => item !== undefined)
  );

  let verdict: Verdict;
  let downgraded = false;

  if (!result.ok) {
    verdict = oracle.severity === 'review' ? 'REVIEW' : 'FAIL';
  } else if (llmBacked) {
    // LLM 이 근거에 섞이면 PASS 를 줄 수 없다(GOAL-M5 provenance 규칙).
    verdict = 'REVIEW';
    downgraded = true;
  } else {
    verdict = 'PASS';
  }

  return {
    rule: oracle.rule,
    ruleVersion: rule.version,
    severity: oracle.severity,
    verdict,
    ok: result.ok,
    message: downgraded ? `${result.message} — LLM 추출 값이 근거라 REVIEW` : result.message,
    detail: result.detail,
    sources,
    downgraded
  };
}
