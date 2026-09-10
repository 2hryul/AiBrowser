import { describe, expect, it } from 'vitest';
import { WorkflowLoadError, loadWorkflow } from '../src/main/workflow/schema';
import {
  AdapterBrokenError,
  Engine,
  resolvePath,
  substitute,
  weakestSource,
  type Adapter,
  type RunState
} from '../src/main/workflow/Engine';
import { verify } from '../src/main/workflow/Verifier';
import { getRule, ruleIds } from '../src/main/workflow/rules/index';
import { provenanced, worstVerdict, type Provenanced } from '../src/main/workflow/types';

/**
 * 검증 계층 단위 테스트 (`npm run test:workflow`, GOAL-M5 성공 조건 2).
 *
 *   - YAML 로드 검증: 필수 키 누락 · `prompt:` 키 · 빈 oracles 거부
 *   - 상태머신 재개
 *   - 규칙 7종 단위 테스트(경계값 포함)
 *   - provenance 강등: llm 출처 값으로 sum_equal PASS 시도 → REVIEW
 *   - 판정 합성 최악값, `ADAPTER_BROKEN` 우선
 */

const VALID_YAML = `
id: demo_flow
version: 2
description: 데모
inputs:
  date:
    type: date
    required: true
steps:
  - id: fetch
    adapter: demo
    with:
      date: \${inputs.date}
    as: rows
  - id: total
    op: aggregate
    with:
      rows: \${rows}
      field: amount
      fn: sum
    as: rows_total
outputs:
  total: rows_total
oracles:
  - rule: sum_equal
    args:
      left: rows_total
      right: rows_total
      tolerance: 0
    severity: fail
evidence:
  screenshots: true
  raw: true
`;

function values(entries: Record<string, Provenanced<unknown>>): Record<string, Provenanced<unknown>> {
  return entries;
}

// ─────────────────────────────────────────────────────────────
// YAML 로드
// ─────────────────────────────────────────────────────────────

describe('워크플로우 로드', () => {
  it('올바른 YAML 을 읽는다', () => {
    const doc = loadWorkflow(VALID_YAML);

    expect(doc.id).toBe('demo_flow');
    expect(doc.version).toBe(2);
    expect(doc.steps).toHaveLength(2);
    expect(doc.oracles[0]?.severity).toBe('fail');
    expect(doc.evidence.screenshots).toBe(true);
  });

  it('필수 키가 없으면 무엇이 없는지 말하며 거부한다', () => {
    for (const key of ['id', 'version', 'inputs', 'steps', 'outputs', 'oracles', 'evidence']) {
      const broken = VALID_YAML.replace(new RegExp(`^${key}:`, 'm'), `_${key}:`);

      let thrown: WorkflowLoadError | null = null;
      try {
        loadWorkflow(broken, key);
      } catch (error) {
        thrown = error as WorkflowLoadError;
      }

      expect(thrown, `${key} 없이 로드됐다`).not.toBeNull();
      expect(thrown?.issues.join(' '), key).toContain(key);
    }
  });

  it('`prompt:` 키는 최상위에도 단계에도 존재하지 않는다', () => {
    const topLevel = `prompt: 알아서 잘 해줘\n${VALID_YAML}`;
    expect(() => loadWorkflow(topLevel)).toThrow(/prompt/);

    const inStep = VALID_YAML.replace(
      '  - id: fetch\n',
      '  - id: fetch\n    prompt: 이 페이지에서 알아서 뽑아라\n'
    );
    let thrown: WorkflowLoadError | null = null;
    try {
      loadWorkflow(inStep);
    } catch (error) {
      thrown = error as WorkflowLoadError;
    }
    expect(thrown?.issues.join(' ')).toContain('steps[0]');
    expect(thrown?.issues.join(' ')).toContain('prompt');
  });

  it('oracles 가 비면 거부한다 — 검증하지 않는 워크플로우는 검증 계층이 아니다', () => {
    const noOracles = VALID_YAML.replace(/oracles:[\s\S]*?evidence:/, 'oracles: []\nevidence:');
    expect(() => loadWorkflow(noOracles)).toThrow(WorkflowLoadError);
    expect(() => loadWorkflow(noOracles)).toThrow(/oracles/);
  });

  it('모르는 키·중복 이름·잘못된 id 를 거부한다', () => {
    expect(() => loadWorkflow(`${VALID_YAML}\nextra: 1\n`)).toThrow(WorkflowLoadError);

    const duplicate = VALID_YAML.replace('    as: rows_total', '    as: rows');
    expect(() => loadWorkflow(duplicate)).toThrow(/중복 결과 이름/);

    const badId = VALID_YAML.replace('id: demo_flow', 'id: Demo-Flow');
    expect(() => loadWorkflow(badId)).toThrow(/소문자/);
  });

  it('YAML 구문 오류는 구문 오류라고 말한다', () => {
    expect(() => loadWorkflow('id: [열린 대괄호\n')).toThrow(/YAML 구문 오류/);
  });
});

// ─────────────────────────────────────────────────────────────
// 치환·경로
// ─────────────────────────────────────────────────────────────

describe('치환과 경로', () => {
  it('`${이름}` 만 바꾸고 식은 계산하지 않는다', () => {
    const table = values({
      rows: provenanced([{ a: 1 }], 'api'),
      'inputs.date': provenanced('2026-03-04', 'const')
    });

    expect(substitute('${rows}', table)).toEqual([{ a: 1 }]);
    expect(substitute({ date: '${inputs.date}' }, table)).toEqual({ date: '2026-03-04' });
    // 식처럼 보이는 것은 문자열 그대로 남는다
    expect(substitute('${rows} + 1', table)).toBe('${rows} + 1');
    expect(substitute('그냥 문자열', table)).toBe('그냥 문자열');
  });

  it('점 경로를 따라간다', () => {
    const table = values({ recon: provenanced({ counts: { exact: 3 } }, 'api') });

    expect(resolvePath(table, 'recon.counts.exact')).toBe(3);
    expect(resolvePath(table, 'recon.counts.none')).toBeUndefined();
    expect(resolvePath(table, '없는이름')).toBeUndefined();
  });

  it('출처는 가장 약한 것을 물려받는다', () => {
    expect(weakestSource(['api', 'network'])).toBe('network');
    expect(weakestSource(['api', 'llm', 'network'])).toBe('llm');
    expect(weakestSource(['dom', 'network'])).toBe('dom');
    expect(weakestSource([])).toBe('const');
  });
});

// ─────────────────────────────────────────────────────────────
// 규칙 7종
// ─────────────────────────────────────────────────────────────

describe('규칙 7종', () => {
  const run = (id: string, args: Record<string, unknown>, table: Record<string, Provenanced<unknown>>) => {
    const rule = getRule(id);
    expect(rule, `${id} 규칙 없음`).not.toBeNull();
    const context = { values: table, used: [] as string[] };
    return rule?.run(rule.validate(args) as never, context);
  };

  it('7종이 모두 등록돼 있다', () => {
    expect(ruleIds()).toEqual([
      'cross_equal',
      'date_order',
      'empty',
      'format',
      'ratio_gte',
      'required_fields',
      'sum_equal'
    ]);
  });

  it('sum_equal — 경계값: 오차와 정확히 같으면 통과', () => {
    const table = values({ a: provenanced(1000, 'api'), b: provenanced(1100, 'api') });

    expect(run('sum_equal', { left: 'a', right: 'b', tolerance: 100 }, table)?.ok).toBe(true);
    expect(run('sum_equal', { left: 'a', right: 'b', tolerance: 99 }, table)?.ok).toBe(false);
    expect(run('sum_equal', { left: 'a', right: 'a', tolerance: 0 }, table)?.ok).toBe(true);

    // 쉼표 문자열도 숫자로 읽는다
    const text = values({ a: provenanced('1,000', 'dom'), b: provenanced('1000', 'dom') });
    expect(run('sum_equal', { left: 'a', right: 'b', tolerance: 0 }, text)?.ok).toBe(true);

    // 숫자가 아니면 통과시키지 않는다
    const bad = values({ a: provenanced('금액없음', 'dom'), b: provenanced(0, 'api') });
    expect(run('sum_equal', { left: 'a', right: 'b', tolerance: 0 }, bad)?.ok).toBe(false);
  });

  it('ratio_gte — 경계값: 기준과 같으면 통과, 분모 0 은 실패', () => {
    const table = values({ n: provenanced(9, 'api'), d: provenanced(10, 'api') });

    expect(run('ratio_gte', { numerator: 'n', denominator: 'd', min: 0.9 }, table)?.ok).toBe(true);
    expect(run('ratio_gte', { numerator: 'n', denominator: 'd', min: 0.91 }, table)?.ok).toBe(false);

    const zero = values({ n: provenanced(0, 'api'), d: provenanced(0, 'api') });
    const result = run('ratio_gte', { numerator: 'n', denominator: 'd', min: 1 }, zero);
    expect(result?.ok, '0건 중 0건 성공을 PASS 로 만들면 안 된다').toBe(false);
    expect(result?.message).toContain('분모가 0');
  });

  it('empty — 빈 목록만 통과하고 목록이 아니면 실패', () => {
    expect(run('empty', { target: 'x' }, values({ x: provenanced([], 'api') }))?.ok).toBe(true);
    expect(run('empty', { target: 'x' }, values({ x: provenanced([1], 'api') }))?.ok).toBe(false);
    expect(run('empty', { target: 'x' }, values({ x: provenanced('목록아님', 'api') }))?.ok).toBe(
      false
    );
  });

  it('required_fields — 빈 문자열·null 도 누락으로 본다', () => {
    const table = values({
      rows: provenanced([{ a: 1, b: 'x' }, { a: 2, b: '' }, { a: null, b: 'y' }], 'dom')
    });

    const result = run('required_fields', { target: 'rows', fields: ['a', 'b'] }, table);
    expect(result?.ok).toBe(false);
    expect(result?.detail['missing']).toHaveLength(2);

    const clean = values({ rows: provenanced([{ a: 1, b: 'x' }], 'dom') });
    expect(run('required_fields', { target: 'rows', fields: ['a', 'b'] }, clean)?.ok).toBe(true);
  });

  it('format — 이름 있는 형식과 정규식 모두 쓴다', () => {
    const table = values({
      rows: provenanced([{ d: '2026-03-04' }, { d: '2026/03/04' }], 'dom'),
      one: provenanced('TX-20260304-02', 'api')
    });

    expect(run('format', { target: 'rows', field: 'd', pattern: 'date' }, table)?.ok).toBe(false);
    expect(run('format', { target: 'one', pattern: 'txid' }, table)?.ok).toBe(true);
    expect(run('format', { target: 'one', pattern: '^TX-' }, table)?.ok).toBe(true);
    expect(run('format', { target: 'one', pattern: '^V-' }, table)?.ok).toBe(false);
  });

  it('cross_equal — 짝이 있는 행만 비교한다', () => {
    const table = values({
      left: provenanced([{ k: 'a', v: '1' }, { k: 'b', v: '2' }], 'api'),
      right: provenanced([{ k: 'a', v: '1' }, { k: 'c', v: '9' }], 'dom')
    });

    // b·c 는 짝이 없어 이 규칙이 보지 않는다(empty 가 본다)
    const same = run('cross_equal', { left: 'left', right: 'right', key: 'k', fields: ['v'] }, table);
    expect(same?.ok).toBe(true);
    expect(same?.detail['compared']).toBe(1);

    const diff = values({
      left: provenanced([{ k: 'a', v: '1' }], 'api'),
      right: provenanced([{ k: 'a', v: '2' }], 'dom')
    });
    expect(run('cross_equal', { left: 'left', right: 'right', key: 'k', fields: ['v'] }, diff)?.ok).toBe(
      false
    );
  });

  it('date_order — 오름차순·내림차순·같은 날', () => {
    const asc = values({ rows: provenanced([{ d: '2026-03-01' }, { d: '2026-03-02' }], 'api') });
    expect(run('date_order', { target: 'rows', field: 'd', order: 'asc' }, asc)?.ok).toBe(true);
    expect(run('date_order', { target: 'rows', field: 'd', order: 'desc' }, asc)?.ok).toBe(false);
    expect(run('date_order', { target: 'rows', field: 'd', order: 'same' }, asc)?.ok).toBe(false);

    const same = values({ rows: provenanced([{ d: '2026-03-01' }, { d: '2026-03-01' }], 'api') });
    expect(run('date_order', { target: 'rows', field: 'd', order: 'same' }, same)?.ok).toBe(true);
    // 같은 값은 오름차순도 만족한다(엄격 증가가 아니다)
    expect(run('date_order', { target: 'rows', field: 'd', order: 'asc' }, same)?.ok).toBe(true);
  });

  it('잘못된 인자는 규칙 실행 전에 걸린다', () => {
    const rule = getRule('sum_equal');
    expect(() => rule?.validate({ left: 'a' })).toThrow();
    expect(() => rule?.validate({ left: 'a', right: 'b', tolerance: -1 })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// 판정 합성 · provenance · ADAPTER_BROKEN
// ─────────────────────────────────────────────────────────────

describe('판정', () => {
  it('합성은 최악값이고 빈 목록은 REVIEW 다', () => {
    expect(worstVerdict(['PASS', 'PASS'])).toBe('PASS');
    expect(worstVerdict(['PASS', 'REVIEW'])).toBe('REVIEW');
    expect(worstVerdict(['REVIEW', 'FAIL'])).toBe('FAIL');
    expect(worstVerdict(['FAIL', 'ADAPTER_BROKEN'])).toBe('ADAPTER_BROKEN');
    expect(worstVerdict([]), '검증하지 않았으면 PASS 가 아니다').toBe('REVIEW');
  });

  it('severity: review 인 오라클이 실패하면 FAIL 이 아니라 REVIEW 다', () => {
    const result = verify({
      values: values({ n: provenanced(9, 'api'), d: provenanced(10, 'api') }),
      oracles: [
        { rule: 'ratio_gte', args: { numerator: 'n', denominator: 'd', min: 1 }, severity: 'review' }
      ]
    });

    expect(result.verdict).toBe('REVIEW');
    expect(result.outcomes[0]?.ok).toBe(false);
  });

  it('provenance — llm 출처 값으로 PASS 를 만들 수 없다', () => {
    const table = values({
      left: provenanced(1000, 'llm'),
      right: provenanced(1000, 'api')
    });

    const result = verify({
      values: table,
      oracles: [{ rule: 'sum_equal', args: { left: 'left', right: 'right', tolerance: 0 }, severity: 'fail' }]
    });

    // 규칙 자체는 통과했는데(합계 같음) 판정은 REVIEW 로 내려간다
    expect(result.outcomes[0]?.ok).toBe(true);
    expect(result.verdict).toBe('REVIEW');
    expect(result.downgraded).toBe(1);
    expect(result.outcomes[0]?.downgraded).toBe(true);
    expect(result.outcomes[0]?.message).toContain('LLM');
    expect(result.outcomes[0]?.sources).toEqual([
      { name: 'left', source: 'llm' },
      { name: 'right', source: 'api' }
    ]);
  });

  it('provenance — 근거에 llm 이 없으면 PASS 그대로다', () => {
    const result = verify({
      values: values({ left: provenanced(1000, 'network'), right: provenanced(1000, 'dom') }),
      oracles: [{ rule: 'sum_equal', args: { left: 'left', right: 'right', tolerance: 0 }, severity: 'fail' }]
    });

    expect(result.verdict).toBe('PASS');
    expect(result.downgraded).toBe(0);
  });

  it('ADAPTER_BROKEN 이면 오라클을 아예 돌리지 않는다', () => {
    const result = verify({
      values: values({ left: provenanced(1, 'api'), right: provenanced(1, 'api') }),
      oracles: [{ rule: 'sum_equal', args: { left: 'left', right: 'right', tolerance: 0 }, severity: 'fail' }],
      adapterBroken: '표 구조가 바뀌었습니다'
    });

    expect(result.verdict).toBe('ADAPTER_BROKEN');
    expect(result.outcomes, '판정할 수 없었는데 오라클 결과가 있으면 안 된다').toHaveLength(0);
    expect(result.adapterBroken).toContain('표 구조');
  });

  it('없는 규칙은 조용히 건너뛰지 않고 FAIL 이다', () => {
    const result = verify({
      values: {},
      oracles: [{ rule: '있지도않은규칙', args: {}, severity: 'fail' }]
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.outcomes[0]?.message).toContain('없는 규칙');
  });
});

// ─────────────────────────────────────────────────────────────
// 상태머신
// ─────────────────────────────────────────────────────────────

describe('Engine 상태머신', () => {
  const rows = [{ amount: '1,000' }, { amount: '2,000' }];

  function demoAdapter(calls: string[], behavior: 'ok' | 'broken' | 'flaky' = 'ok'): Adapter {
    let attempts = 0;

    return {
      contract: {
        name: 'demo',
        version: 3,
        input: ['date'],
        output: ['rows'],
        write: false,
        source: 'network',
        pii: []
      },
      run: async ({ stepId }) => {
        calls.push(stepId);
        attempts += 1;

        if (behavior === 'broken') throw new AdapterBrokenError('demo', '표를 찾을 수 없습니다');
        if (behavior === 'flaky' && attempts < 3) throw new Error('일시 오류');

        return { value: rows, source: 'network', raw: { rows }, note: `${attempts}회차` };
      }
    };
  }

  it('단계를 순서대로 실행하고 출력·어댑터 버전을 남긴다', async () => {
    const calls: string[] = [];
    const engine = new Engine({ adapters: { demo: demoAdapter(calls) }, sleep: async () => undefined });

    const result = await engine.run(loadWorkflow(VALID_YAML), { date: '2026-03-04' }, 'run-1');

    expect(calls).toEqual(['fetch']);
    expect(result.state.status).toBe('done');
    expect(result.verdict).toBe('PASS');
    expect(result.outputs['total']).toBe(3000);
    expect(result.adapterVersions).toEqual({ demo: 3 });
    expect(result.state.steps.map((step) => step.id)).toEqual(['fetch', 'total']);
    expect(result.state.steps[0]?.source).toBe('network');
  });

  it('재개하면 이미 끝난 단계를 다시 돌지 않는다', async () => {
    const calls: string[] = [];
    const engine = new Engine({ adapters: { demo: demoAdapter(calls) }, sleep: async () => undefined });
    const workflow = loadWorkflow(VALID_YAML);

    // 첫 단계까지 끝난 상태를 손으로 만든다(앱이 죽었다 살아난 상황).
    const saved: RunState = {
      runId: 'run-2',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      inputs: { date: '2026-03-04' },
      cursor: 1,
      values: {
        'inputs.date': provenanced('2026-03-04', 'const'),
        rows: provenanced(rows, 'network')
      },
      steps: [
        {
          id: 'fetch',
          kind: 'adapter',
          name: 'demo',
          as: 'rows',
          source: 'network',
          startedAt: 0,
          durationMs: 1,
          attempts: 1,
          ok: true,
          error: null,
          screenshot: null,
          note: null
        }
      ],
      status: 'running',
      adapterBroken: null,
      startedAt: 0,
      updatedAt: 0
    };

    const result = await engine.resume(workflow, saved);

    expect(calls, '재개하면서 어댑터를 다시 불렀다').toEqual([]);
    expect(result.verdict).toBe('PASS');
    expect(result.outputs['total']).toBe(3000);
    expect(result.state.steps).toHaveLength(2);
  });

  it('재시도로 낫는 오류는 재시도한다', async () => {
    const calls: string[] = [];
    const engine = new Engine({
      adapters: { demo: demoAdapter(calls, 'flaky') },
      sleep: async () => undefined
    });

    const retrying = VALID_YAML.replace(
      '    as: rows\n',
      '    as: rows\n    retry:\n      max: 3\n      delayMs: 0\n'
    );

    const result = await engine.run(loadWorkflow(retrying), { date: '2026-03-04' }, 'run-3');

    expect(result.state.steps[0]?.attempts).toBe(3);
    expect(result.verdict).toBe('PASS');
  });

  it('어댑터가 깨지면 재시도하지 않고 ADAPTER_BROKEN 으로 멈춘다', async () => {
    const calls: string[] = [];
    const engine = new Engine({
      adapters: { demo: demoAdapter(calls, 'broken') },
      sleep: async () => undefined
    });

    const retrying = VALID_YAML.replace(
      '    as: rows\n',
      '    as: rows\n    retry:\n      max: 3\n      delayMs: 0\n'
    );

    const result = await engine.run(loadWorkflow(retrying), { date: '2026-03-04' }, 'run-4');

    expect(result.verdict).toBe('ADAPTER_BROKEN');
    expect(result.state.status).toBe('adapter_broken');
    expect(result.state.steps[0]?.attempts, '깨진 어댑터를 재시도했다').toBe(1);
    // 뒤 단계는 돌지 않는다
    expect(result.state.steps).toHaveLength(1);
    expect(result.verification.outcomes).toHaveLength(0);
  });

  it('필수 입력이 없으면 시작하지 않는다', () => {
    const engine = new Engine({ adapters: {}, sleep: async () => undefined });
    expect(() => engine.start(loadWorkflow(VALID_YAML), {}, 'run-5')).toThrow(/필수 입력 누락/);
  });

  it('등록되지 않은 어댑터는 FAIL 이고 이유가 남는다', async () => {
    const engine = new Engine({ adapters: {}, sleep: async () => undefined });
    const result = await engine.run(loadWorkflow(VALID_YAML), { date: '2026-03-04' }, 'run-6');

    expect(result.verdict).toBe('FAIL');
    expect(result.state.steps[0]?.error).toContain('등록되지 않은 어댑터');
  });
});
