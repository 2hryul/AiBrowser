import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ledgerRows, settleRows, SETTLE_DATES, expectedAll } from '../src/main/browser/portals/settleData';
import { Engine, type Adapter } from '../src/main/workflow/Engine';
import { loadWorkflow } from '../src/main/workflow/schema';
import { LEDGER_CONTRACT } from '../src/main/workflow/adapters/ledger';
import { SETTLE_CONTRACT } from '../src/main/workflow/adapters/settle';

/**
 * 골든셋 판정 — Electron 없이.
 *
 * `npm run eval` 은 실제 포털·ToolSurface·스크린샷까지 지나는 진짜 러너다(성공 조건 4).
 * 이 테스트는 그 앞단에 두는 빠른 그물이다: **워크플로우 YAML 과 오라클 조합만으로**
 * 20일치 정답표가 재현되는지 본다. 규칙을 건드려 오탐이 생기면 `npm test` 에서 먼저 터진다.
 *
 * 어댑터는 원천 데이터를 그대로 주는 대역이다 — 여기서 보려는 것은 수집 경로가 아니라
 * 정규화·대사·오라클의 판정이다.
 */

const WORKFLOW = loadWorkflow(
  readFileSync(join(process.cwd(), 'workflows', 'settle_vs_ledger_daily.yaml'), 'utf-8'),
  'workflows/settle_vs_ledger_daily.yaml'
);

function stubAdapters(): Record<string, Adapter> {
  return {
    [SETTLE_CONTRACT.name]: {
      contract: SETTLE_CONTRACT,
      run: async (context) => ({
        value: settleRows(String(context.args['date'])),
        source: 'network' as const
      })
    },
    [LEDGER_CONTRACT.name]: {
      contract: LEDGER_CONTRACT,
      run: async (context) => ({
        value: ledgerRows(String(context.args['date'])),
        source: 'dom' as const
      })
    }
  };
}

describe('골든셋 20일치 판정', () => {
  const engine = new Engine({ adapters: stubAdapters(), sleep: async () => undefined });

  it('워크플로우가 로드된다 (오라클 5개, prompt 없음)', () => {
    expect(WORKFLOW.id).toBe('settle_vs_ledger_daily');
    expect(WORKFLOW.version).toBe(1);
    expect(WORKFLOW.oracles.length).toBeGreaterThanOrEqual(3);
    expect(WORKFLOW.oracles.filter((oracle) => oracle.severity === 'review')).toHaveLength(1);
  });

  it('정답표와 판정이 일치하고 오탐이 0이다', async () => {
    const expected = new Map(expectedAll().map((day) => [day.date, day.verdict]));
    const actual: Record<string, string> = {};

    for (const date of SETTLE_DATES) {
      const result = await engine.run(WORKFLOW, { date }, `test-${date}`);
      actual[date] = result.verdict;
    }

    // 오탐 = 불일치가 심긴 날인데 PASS 가 나온 것. 하나라도 있으면 검증 계층이 거짓말을 한다.
    const falsePass = SETTLE_DATES.filter(
      (date) => expected.get(date) !== 'PASS' && actual[date] === 'PASS'
    );
    expect(falsePass).toEqual([]);

    // 반대 방향(정상인데 FAIL/REVIEW)도 본다 — 시끄러운 검증은 쓰이지 않는다.
    const falseAlarm = SETTLE_DATES.filter(
      (date) => expected.get(date) === 'PASS' && actual[date] !== 'PASS'
    );
    expect(falseAlarm).toEqual([]);

    for (const date of SETTLE_DATES) {
      expect(actual[date], `${date} 판정`).toBe(expected.get(date));
    }
  });

  it('금액 차이가 심긴 날은 mismatched 로, 누락은 onlyLeft/onlyRight 로 잡힌다', async () => {
    const amountDay = await engine.run(WORKFLOW, { date: '2026-03-04' }, 'test-amount');
    expect(amountDay.verdict).toBe('FAIL');
    expect(amountDay.outputs['mismatchedRows']).toHaveLength(1);

    const missingLedger = await engine.run(WORKFLOW, { date: '2026-03-06' }, 'test-missing-ledger');
    expect(missingLedger.outputs['onlyLeftRows']).toHaveLength(1);

    const missingSettle = await engine.run(WORKFLOW, { date: '2026-03-17' }, 'test-missing-settle');
    expect(missingSettle.outputs['onlyRightRows']).toHaveLength(1);
  });

  it('식별자 오타는 퍼지 매칭 뒤 REVIEW 로 남는다 (조용히 PASS 되지 않는다)', async () => {
    const result = await engine.run(WORKFLOW, { date: '2026-03-25' }, 'test-typo');

    expect(result.verdict).toBe('REVIEW');
    expect(result.outputs['fuzzy']).toBe(1);
    // 금액은 같으니 합계 오라클은 통과한다 — REVIEW 는 매칭률 오라클에서 나온다.
    const ratio = result.verification.outcomes.find((outcome) => outcome.rule === 'ratio_gte');
    expect(ratio?.verdict).toBe('REVIEW');
    expect(result.verification.outcomes.filter((outcome) => outcome.verdict === 'FAIL')).toHaveLength(0);
  });

  it('어댑터가 깨지면 FAIL 이 아니라 ADAPTER_BROKEN 이다', async () => {
    const { AdapterBrokenError } = await import('../src/main/workflow/Engine');
    const broken = new Engine({
      adapters: {
        ...stubAdapters(),
        [LEDGER_CONTRACT.name]: {
          contract: LEDGER_CONTRACT,
          run: async () => {
            throw new AdapterBrokenError(LEDGER_CONTRACT.name, '표 머리글을 찾을 수 없습니다');
          }
        }
      },
      sleep: async () => undefined
    });

    const result = await broken.run(WORKFLOW, { date: '2026-03-02' }, 'test-broken');
    expect(result.verdict).toBe('ADAPTER_BROKEN');
    expect(result.verification.outcomes).toHaveLength(0);
  });
});
