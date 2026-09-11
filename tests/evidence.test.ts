import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EvidencePack,
  MASK,
  maskAdapterValue,
  maskAtPaths,
  maskFieldsDeep,
  piiFieldNames
} from '../src/main/audit/Evidence';
import { ledgerRows, settleRows } from '../src/main/browser/portals/settleData';
import { LEDGER_CONTRACT } from '../src/main/workflow/adapters/ledger';
import { SETTLE_CONTRACT } from '../src/main/workflow/adapters/settle';
import { Engine, type Adapter } from '../src/main/workflow/Engine';
import { loadWorkflow } from '../src/main/workflow/schema';

/**
 * 증거 팩 — 구조·규칙 버전·PII 마스킹 (GOAL-M5 성공 조건 7의 단위 절반).
 *
 * 마스킹을 여기서 단단히 못박는 이유: 증거 팩은 판정 근거를 남기려고 디스크에 쓰는 파일이다.
 * 도구 결과에서 가려 놓고 여기 원문이 남으면 아무 의미가 없다(감사 로그와 같은 원칙).
 */

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-evidence-'));
const DATE = '2026-03-04';

const WORKFLOW = loadWorkflow(
  readFileSync(path.join(process.cwd(), 'workflows', 'settle_vs_ledger_daily.yaml'), 'utf-8'),
  'settle_vs_ledger_daily.yaml'
);

afterAll(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});

function stubAdapters(): Record<string, Adapter> {
  return {
    [SETTLE_CONTRACT.name]: {
      contract: SETTLE_CONTRACT,
      run: async (ctx) => {
        const rows = settleRows(String(ctx.args['date']));
        return { value: rows, source: 'network' as const, raw: { date: DATE, total: rows.length, rows } };
      }
    },
    [LEDGER_CONTRACT.name]: {
      contract: LEDGER_CONTRACT,
      run: async (ctx) => {
        const rows = ledgerRows(String(ctx.args['date']));
        return { value: rows, source: 'dom' as const, raw: { rows, file: null, conflicts: 0 } };
      }
    }
  };
}

describe('경로 마스킹', () => {
  it('배열 항목의 지정 항목만 가린다', () => {
    const { value, masked } = maskAtPaths(
      { rows: [{ txId: 'TX-1', approver: '김민준' }, { txId: 'TX-2', approver: '이서연' }] },
      ['rows[].approver']
    );

    expect(masked).toBe(2);
    expect(value.rows[0]).toEqual({ txId: 'TX-1', approver: MASK });
    expect(value.rows[1]?.txId).toBe('TX-2');
  });

  it('없는 경로는 조용히 넘어간다 — 그날 그 항목이 안 왔을 수 있다', () => {
    const { masked } = maskAtPaths({ rows: [{ txId: 'TX-1' }] }, ['rows[].approver']);
    expect(masked).toBe(0);
  });

  it('원본을 바꾸지 않는다', () => {
    const original = { rows: [{ approver: '김민준' }] };
    maskAtPaths(original, ['rows[].approver']);
    expect(original.rows[0]?.approver).toBe('김민준');
  });

  it('금액은 건드리지 않는다 — 전역 마스킹을 쓰지 않는 이유다', () => {
    // 1250000 은 연속 7자리라 사번 패턴에 걸린다. 선언 경로만 가리므로 살아남아야 한다.
    const { value } = maskAtPaths({ rows: [{ amount: '1,250,000', approverNo: '1002135' }] }, [
      'rows[].approverNo'
    ]);

    expect(value.rows[0]?.amount).toBe('1,250,000');
    expect(value.rows[0]?.approverNo).toBe(MASK);
  });

  it('어댑터 출력은 계약의 출력 이름을 뿌리로 쓴다', () => {
    const rows = [{ txId: 'TX-1', approver: '김민준', approverNo: '1002135' }];
    const { value, masked } = maskAdapterValue(rows, SETTLE_CONTRACT.output, SETTLE_CONTRACT.pii);

    expect(masked).toBe(2);
    expect((value as typeof rows)[0]).toEqual({ txId: 'TX-1', approver: MASK, approverNo: MASK });
  });
});

describe('이름 마스킹', () => {
  it('경로 마지막 조각을 항목 이름으로 뽑는다', () => {
    expect(piiFieldNames(['rows[].approver', 'rows[].approverNo', 'a.b.c'])).toEqual([
      'approver',
      'approverNo',
      'c'
    ]);
  });

  it('임의 깊이에 묻힌 항목도 가린다 — 대사 결과는 행을 품는다', () => {
    const { value, masked } = maskFieldsDeep(
      { matches: [{ left: { approver: '김민준' }, right: { approver: '이서연' } }] },
      ['approver']
    );

    expect(masked).toBe(2);
    expect(JSON.stringify(value)).not.toContain('김민준');
  });
});

describe('증거 팩 파일', () => {
  it('폴더 구조·규칙 버전·마스킹이 갖춰진다', async () => {
    const engine = new Engine({ adapters: stubAdapters(), sleep: async () => undefined });
    const result = await engine.run(WORKFLOW, { date: DATE }, 'unit-run');

    const pack = new EvidencePack(TEMP, 'unit-run');
    pack.saveScreenshot('fetch_settle', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const contracts = {
      [SETTLE_CONTRACT.name]: {
        name: SETTLE_CONTRACT.name,
        version: SETTLE_CONTRACT.version,
        output: [...SETTLE_CONTRACT.output],
        pii: [...SETTLE_CONTRACT.pii],
        source: SETTLE_CONTRACT.source,
        write: SETTLE_CONTRACT.write
      },
      [LEDGER_CONTRACT.name]: {
        name: LEDGER_CONTRACT.name,
        version: LEDGER_CONTRACT.version,
        output: [...LEDGER_CONTRACT.output],
        pii: [...LEDGER_CONTRACT.pii],
        source: LEDGER_CONTRACT.source,
        write: LEDGER_CONTRACT.write
      }
    };

    const summary = pack.write({ workflow: WORKFLOW, result, contracts });

    expect(summary.files).toEqual([
      'extracted.json',
      'normalized.json',
      'oracles.json',
      'raw',
      'run.json',
      'steps'
    ]);
    expect(summary.screenshots).toBe(1);
    expect(summary.maskedFields).toBeGreaterThan(0);

    // raw/ 는 어댑터 단계마다 하나
    expect(fs.readdirSync(path.join(pack.dir, 'raw')).sort()).toEqual([
      'fetch_ledger.json',
      'fetch_settle.json'
    ]);

    const oracles = JSON.parse(fs.readFileSync(path.join(pack.dir, 'oracles.json'), 'utf-8')) as {
      verdict: string;
      outcomes: { rule: string; ruleVersion: number; note: string | null }[];
    };

    expect(oracles.verdict).toBe('FAIL');
    expect(oracles.outcomes).toHaveLength(WORKFLOW.oracles.length);
    for (const outcome of oracles.outcomes) {
      expect(outcome.rule).not.toBe('');
      expect(outcome.ruleVersion).toBeGreaterThanOrEqual(1);
      expect(outcome.note).not.toBeNull();
    }

    const run = JSON.parse(fs.readFileSync(path.join(pack.dir, 'run.json'), 'utf-8')) as {
      workflowVersion: number;
      adapterVersions: Record<string, number>;
      ruleVersions: Record<string, number>;
      evidencePath: string;
    };

    expect(run.workflowVersion).toBe(WORKFLOW.version);
    expect(run.adapterVersions[SETTLE_CONTRACT.name]).toBe(SETTLE_CONTRACT.version);
    expect(run.ruleVersions['sum_equal']).toBe(1);

    // ── 마스킹: 결재자 이름·사번이 어디에도 남지 않는다 ──
    for (const name of ['extracted.json', 'normalized.json', 'run.json']) {
      const text = fs.readFileSync(path.join(pack.dir, name), 'utf-8');
      for (const approver of ['김민준', '이서연', '박지호', '최수빈', '정예은']) {
        expect(text, `${name} 에 ${approver}`).not.toContain(approver);
      }
    }

    for (const raw of fs.readdirSync(path.join(pack.dir, 'raw'))) {
      const text = fs.readFileSync(path.join(pack.dir, 'raw', raw), 'utf-8');
      expect(text, `raw/${raw}`).not.toContain('김민준');
    }

    // 금액은 살아 있어야 한다 — 마스킹이 대사 근거를 지우면 안 된다.
    const extracted = fs.readFileSync(path.join(pack.dir, 'extracted.json'), 'utf-8');
    expect(extracted).toContain(settleRows(DATE)[0]?.amount ?? '');
  });

  it('어댑터가 깨진 실행도 팩을 남긴다 — 판정할 수 없었다는 기록이 필요하다', async () => {
    const { AdapterBrokenError } = await import('../src/main/workflow/Engine');
    const engine = new Engine({
      adapters: {
        ...stubAdapters(),
        [LEDGER_CONTRACT.name]: {
          contract: LEDGER_CONTRACT,
          run: async () => {
            throw new AdapterBrokenError(LEDGER_CONTRACT.name, '머리글 없음');
          }
        }
      },
      sleep: async () => undefined
    });

    const result = await engine.run(WORKFLOW, { date: DATE }, 'broken-run');
    const pack = new EvidencePack(TEMP, 'broken-run');
    pack.write({ workflow: WORKFLOW, result, contracts: {} });

    const oracles = JSON.parse(fs.readFileSync(path.join(pack.dir, 'oracles.json'), 'utf-8')) as {
      verdict: string;
      adapterBroken: string | null;
      outcomes: unknown[];
    };

    expect(oracles.verdict).toBe('ADAPTER_BROKEN');
    expect(oracles.adapterBroken).toContain('머리글 없음');
    expect(oracles.outcomes).toHaveLength(0);
  });
});
