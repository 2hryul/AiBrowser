import { describe, expect, it } from 'vitest';
import { ledgerRows, settleRows } from '../src/main/browser/portals/settleData';
import { buildXlsx } from '../src/main/workflow/xlsx/write';
import { createLedgerAdapter, LEDGER_CONTRACT } from '../src/main/workflow/adapters/ledger';
import { createSettleAdapter, SETTLE_CONTRACT } from '../src/main/workflow/adapters/settle';
import { parseTextTable, type NetEntryLike, type PortalIo } from '../src/main/workflow/adapters/io';
import { AdapterBrokenError } from '../src/main/workflow/Engine';

/**
 * 어댑터 사다리 — Electron 없이 (GOAL-M5 성공 조건 5의 단위 절반).
 *
 * `PortalIo` 를 가짜로 넣어 **폴백이 실제로 일어나는지**, 그리고 폴백했다는 사실이
 * `source` 로 드러나는지 본다. 조용히 내려가는 폴백은 폴백이 아니라 버그다.
 *
 * E2E 쪽 절반(진짜 포털·진짜 XHR·`?api=off` 스위치)은 `scripts/workflow-e2e.ts` 가 본다.
 */

const DATE = '2026-03-04';

/** `document.body.innerText` 가 표를 주는 모양 — 행은 줄, 칸은 탭이다. */
function asInnerText(headers: readonly string[], rows: readonly string[][]): string {
  return [headers.join('\t'), ...rows.map((row) => row.join('\t'))].join('\n');
}

function settleText(date: string): string {
  return [
    '정산 포털',
    '조회 완료',
    // 정산 화면에는 표가 둘이다(XHR 표 + 정적 표). 머리글이 두 번 나온다.
    asInnerText(
      ['거래번호', '공급사', '정산금액', '결재자'],
      []
    ),
    '서버 렌더링 표(스크립트 없이 보는 화면)',
    asInnerText(
      ['거래번호', '공급사', '정산금액', '결재자'],
      settleRows(date).map((row) => [row.txId, row.vendor, row.amount, row.approver])
    )
  ].join('\n');
}

function ledgerText(date: string): string {
  return [
    '회계 시스템',
    `조회 완료 ${ledgerRows(date).length}건`,
    asInnerText(
      ['전표번호', '거래번호', '공급사', '금액', '전표일자'],
      ledgerRows(date).map((row) => [row.voucherNo, row.txId, row.vendor, row.amount, row.date])
    )
  ].join('\n');
}

interface FakeOptions {
  /** 정산 API 응답 상태. 503 이면 폴백 경로로 간다. */
  apiStatus?: number;
  /** 화면 텍스트를 갈아치운다(어댑터 깨짐 시험) */
  text?: (url: string) => string;
  /** 다운로드를 실패시킨다 */
  downloadFails?: boolean;
  /** xlsx 금액을 바꿔 화면↔파일 충돌을 만든다 */
  fileAmountShift?: number;
}

interface Fake {
  io: PortalIo;
  calls: string[];
}

function fakeIo(options: FakeOptions = {}): Fake {
  const calls: string[] = [];
  let url = '';

  const io: PortalIo = {
    async open(target) {
      url = target;
      calls.push(`open ${target}`);
      return 1;
    },

    async tap(_tabId, pattern) {
      calls.push(`tap ${pattern}`);

      const status = options.apiStatus ?? 200;
      const date = new URL(url).searchParams.get('date') ?? DATE;

      const entry: NetEntryLike = {
        url: `app://portal-h-settle/api/settlements?date=${date}`,
        status,
        body:
          status === 200
            ? JSON.stringify({ date, total: settleRows(date).length, rows: settleRows(date) })
            : JSON.stringify({ error: 'service unavailable' })
      };

      return [entry];
    },

    async click(_tabId, query) {
      calls.push(`click ${query}`);
    },

    async text() {
      calls.push('text');
      if (options.text) return options.text(url);

      // 날짜는 주소에서 읽는다 — 20일치를 같은 가짜 IO 로 돌릴 수 있어야 한다.
      const date = new URL(url).searchParams.get('date') ?? DATE;
      return url.includes('ledger') ? ledgerText(date) : settleText(date);
    },

    async download(_tabId, target) {
      calls.push(`download ${target}`);
      if (options.downloadFails) throw new Error('권한이 없습니다');
      return { savePath: `C:\\tmp\\${DATE}.xlsx`, bytes: 1024 };
    },

    async readFile() {
      const shift = options.fileAmountShift ?? 0;
      const date = new URL(url).searchParams.get('date') ?? DATE;

      return buildXlsx({
        name: '전표',
        rows: [
          [`${date} 전표 목록`, null, null, null, null],
          ['전표번호', '거래번호', '공급사', '금액', '전표일자'],
          ...ledgerRows(date).map((row) => [
            row.voucherNo,
            row.txId,
            row.vendor,
            Number(row.amount.replace(/,/g, '')) + shift,
            { date: row.date }
          ])
        ],
        merges: ['A1:E1'],
        columnFormats: { 3: 'money', 4: 'date' }
      });
    },

    async screenshot() {
      calls.push('screenshot');
      return null;
    },

    async wait() {
      // 가짜 IO 는 기다리지 않는다
    }
  };

  return { io, calls };
}

const context = { inputs: { date: DATE }, args: { date: DATE }, runId: 'test', stepId: 'fetch' };

describe('정산 어댑터 — network 우선', () => {
  it('API 가 답하면 source 는 network 이고 원본이 raw 에 담긴다', async () => {
    const { io, calls } = fakeIo();
    const result = await createSettleAdapter(io).run(context);

    expect(result.source).toBe('network');
    expect(result.value).toHaveLength(5);
    expect((result.raw as { rows: unknown[] }).rows).toHaveLength(5);

    // 도청을 조회 누르기 **전에** 켜야 응답을 놓치지 않는다.
    expect(calls.indexOf('tap /api/settlements')).toBeLessThan(calls.indexOf('click 조회'));
  });

  it('계약은 network 를 말하지만 API 가 죽으면 dom 으로 내려가고 그 사실이 기록된다', async () => {
    const { io } = fakeIo({ apiStatus: 503 });
    const result = await createSettleAdapter(io).run(context);

    expect(SETTLE_CONTRACT.source).toBe('network');
    expect(result.source).toBe('dom');
    expect(result.value).toHaveLength(5);
    expect(result.note).toContain('폴백');
    expect((result.raw as { apiStatus: number }).apiStatus).toBe(503);
  });

  it('폴백 값은 API 값과 같은 거래번호를 준다', async () => {
    const viaApi = await createSettleAdapter(fakeIo().io).run(context);
    const viaDom = await createSettleAdapter(fakeIo({ apiStatus: 503 }).io).run(context);

    const ids = (rows: unknown) => (rows as { txId: string }[]).map((row) => row.txId);
    expect(ids(viaDom.value)).toEqual(ids(viaApi.value));
  });

  it('폴백 행에도 뒤 단계가 쓰는 항목이 다 있다 — 모양이 달라지면 판정이 바뀐다', async () => {
    // 실측으로 잡은 결함: 화면 표에 날짜 칸이 없어 `date` 가 빠지면 normalize 가 터져
    // 정상인 날이 FAIL 로 나왔다. 폴백은 경로만 바꾸고 판정은 바꾸지 않아야 한다.
    const viaDom = await createSettleAdapter(fakeIo({ apiStatus: 503 }).io).run(context);
    const rows = viaDom.value as Record<string, unknown>[];

    for (const field of ['txId', 'date', 'vendor', 'amount']) {
      expect(rows.every((row) => row[field] !== undefined && row[field] !== ''), field).toBe(true);
    }
    expect(rows.every((row) => row['date'] === DATE)).toBe(true);

    // 화면에 정말 없는 항목은 만들어 내지 않는다.
    expect(rows.every((row) => row['approverNo'] === undefined)).toBe(true);
  });

  it('API 도 죽고 화면 구조도 바뀌면 FAIL 이 아니라 ADAPTER_BROKEN 이다', async () => {
    const { io } = fakeIo({ apiStatus: 503, text: () => '정산 포털\n점검 중입니다' });

    await expect(createSettleAdapter(io).run(context)).rejects.toThrow(AdapterBrokenError);
  });

  it('결재자 항목을 pii 로 선언한다 — 증거 팩이 가릴 근거다', () => {
    expect(SETTLE_CONTRACT.pii).toContain('rows[].approver');
    expect(SETTLE_CONTRACT.write).toBe(false);
  });
});

describe('회계 어댑터 — dom + xlsx', () => {
  it('화면에서 읽고(source: dom) 파일로 대조한다', async () => {
    const { io, calls } = fakeIo();
    const result = await createLedgerAdapter(io).run(context);

    expect(LEDGER_CONTRACT.source).toBe('dom');
    expect(result.source).toBe('dom');
    expect(result.value).toHaveLength(5);
    expect(result.note).toContain('xlsx');
    expect(calls.some((call) => call.startsWith('download'))).toBe(true);

    const file = (result.raw as { file: Record<string, number> }).file;
    expect(Object.keys(file)).toHaveLength(5);
  });

  it('화면과 파일 금액이 다르면 고르지 않고 sourceConflict 로 남긴다', async () => {
    const { io } = fakeIo({ fileAmountShift: 1000 });
    const result = await createLedgerAdapter(io).run(context);

    const rows = result.value as { sourceConflict?: { dom: string; file: string } }[];
    const conflicts = rows.filter((row) => row.sourceConflict !== undefined);

    expect(conflicts).toHaveLength(5);
    expect((result.raw as { conflicts: number }).conflicts).toBe(5);
    // 값은 화면 쪽을 그대로 쓴다 — 어댑터가 어느 쪽이 옳은지 판단하지 않는다.
    expect(result.source).toBe('dom');
  });

  it('파일을 못 받는 것은 깨진 것이 아니다 — 화면 값으로 진행한다', async () => {
    const { io } = fakeIo({ downloadFails: true });
    const result = await createLedgerAdapter(io).run(context);

    expect(result.value).toHaveLength(5);
    expect(result.note).toContain('건너뜀');
  });

  it('화면 표가 사라지면 ADAPTER_BROKEN 이다', async () => {
    const { io } = fakeIo({ text: () => '회계 시스템\n조회 결과가 없습니다' });

    await expect(createLedgerAdapter(io).run(context)).rejects.toThrow(AdapterBrokenError);
  });
});

describe('폴백 경로로 20일치를 돌려도 판정이 같다', () => {
  it('정산 API 가 죽은 채 골든셋을 돌려도 정답표와 일치한다', async () => {
    // 폴백은 경로만 바꾸고 판정은 바꾸지 않아야 한다. 이 테스트가 없으면
    // "API 켜진 채로만 맞는 워크플로우" 를 통과시킨다(실측으로 그런 상태였다).
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { Engine } = await import('../src/main/workflow/Engine');
    const { loadWorkflow } = await import('../src/main/workflow/schema');
    const { SETTLE_DATES, expectedAll } = await import('../src/main/browser/portals/settleData');

    const workflow = loadWorkflow(
      readFileSync(join(process.cwd(), 'workflows', 'settle_vs_ledger_daily.yaml'), 'utf-8'),
      'settle_vs_ledger_daily.yaml'
    );

    const { io } = fakeIo({ apiStatus: 503 });
    const settle = createSettleAdapter(io);
    const ledger = createLedgerAdapter(io);

    const engine = new Engine({
      adapters: { [settle.contract.name]: settle, [ledger.contract.name]: ledger },
      sleep: async () => undefined
    });

    const expected = new Map(expectedAll().map((day) => [day.date, day.verdict]));

    for (const date of SETTLE_DATES) {
      const result = await engine.run(workflow, { date }, `fallback-${date}`);

      const settleStep = result.state.steps.find((step) => step.name === settle.contract.name);
      expect(settleStep?.source, `${date} 획득 경로`).toBe('dom');
      expect(result.verdict, `${date} 판정`).toBe(expected.get(date));
    }
  });
});

describe('표 파서', () => {
  it('머리글을 못 찾으면 빈 배열이 아니라 null 이다', () => {
    expect(parseTextTable('아무 글', ['거래번호'])).toBeNull();
  });

  it('데이터가 없는 표는 빈 배열이다 — "구조가 바뀜" 과 구별된다', () => {
    expect(parseTextTable('거래번호\t공급사', ['거래번호', '공급사'])).toEqual([]);
  });

  it('같은 머리글이 두 번 나오면 뒤쪽 머리글을 데이터로 읽지 않는다', () => {
    const rows = parseTextTable(settleText(DATE), ['거래번호', '공급사', '정산금액', '결재자']);

    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(5);
    expect(rows?.every((row) => row['거래번호'] !== '거래번호')).toBe(true);
  });

  it('칸 수가 다른 줄은 건너뛴다', () => {
    const text = ['가\t나', '1\t2', '합계', '3\t4'].join('\n');
    expect(parseTextTable(text, ['가', '나'])).toEqual([
      { 가: '1', 나: '2' },
      { 가: '3', 나: '4' }
    ]);
  });
});
