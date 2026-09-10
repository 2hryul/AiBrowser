import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLANTED,
  ROWS_PER_DAY,
  SETTLE_DATES,
  expectedAll,
  ledgerRows,
  settleRows,
  won
} from '../src/main/browser/portals/settleData';
import { routePortalSettle, setSettleApi } from '../src/main/browser/portals/settle';
import { routePortalLedger } from '../src/main/browser/portals/ledger';
import { readXlsx, sheetToRecords } from '../src/main/workflow/xlsx/read';
import { findPii, maskText } from '../src/main/control/Masking';

/**
 * 모의 포털 H 의 불변식과 정답표 (GOAL-M5 PRECONDITIONS).
 *
 * 시나리오 H 의 성공 조건("6일치는 FAIL/REVIEW, 14일치는 PASS, 오탐 0")은 이 fixture 가
 * 정확히 그만큼 어긋난다는 전제 위에 있다. 전제가 틀리면 오탐 0을 달성해도 아무 의미가 없다.
 */

const GOLDEN = path.resolve(__dirname, '..', 'golden', 'settle_vs_ledger_daily');

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function bodyOf(response: Response): Promise<string> {
  return response.text();
}

describe('20일치 데이터', () => {
  it('평일 20일, 하루 5건이 기본이다', () => {
    expect(SETTLE_DATES).toHaveLength(20);
    expect(new Set(SETTLE_DATES).size).toBe(20);

    // 주말이 섞이지 않았는지 — 대사는 영업일 기준이다.
    for (const date of SETTLE_DATES) {
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      expect(day, `${date} 는 주말이다`).toBeGreaterThan(0);
      expect(day).toBeLessThan(6);
    }

    for (const date of SETTLE_DATES) {
      expect(settleRows(date), date).toHaveLength(ROWS_PER_DAY);
    }
  });

  it('금액은 쉼표 문자열이라 사번 마스킹에 걸리지 않는다', () => {
    // 이 fixture 설계의 핵심 이유. 숫자로 두면 7자리 연속 숫자가 사번으로 오인된다.
    const raw = 1_250_000;
    expect(maskText(String(raw)).text, '숫자 금액은 마스킹된다').toBe('12*****');
    expect(maskText(won(raw)).text, '쉼표 금액은 그대로 남는다').toBe('1,250,000');

    // 실제 데이터 전체에서 확인한다.
    for (const date of SETTLE_DATES) {
      for (const row of settleRows(date)) {
        expect(maskText(row.amount).text, `${row.txId} 금액이 마스킹된다`).toBe(row.amount);
        expect(maskText(row.txId).text, `${row.txId} 가 마스킹된다`).toBe(row.txId);
      }
    }
  });

  it('결재자 사번은 개인정보라 마스킹 대상이다 — 어댑터가 pii 로 선언할 값이다', () => {
    const row = settleRows('2026-03-02')[0];
    expect(row).toBeDefined();
    expect(findPii(row?.approverNo ?? '')).toHaveLength(1);
  });
});

describe('의도된 불일치 6건', () => {
  it('종류별 개수가 명세와 맞는다 — 금액 3 · 누락 2 · 오타 1', () => {
    expect(PLANTED).toHaveLength(6);
    expect(PLANTED.filter((item) => item.kind === 'amount')).toHaveLength(3);
    expect(
      PLANTED.filter((item) => item.kind === 'missing_ledger' || item.kind === 'missing_settle')
    ).toHaveLength(2);
    expect(PLANTED.filter((item) => item.kind === 'typo_id')).toHaveLength(1);

    // 6일에 흩어져 있다(한 날에 몰리면 14일 PASS 가 성립하지 않는다).
    expect(new Set(PLANTED.map((item) => item.date)).size).toBe(6);
  });

  it('금액 차이 3건은 선언한 delta 만큼 정확히 어긋난다', () => {
    for (const planted of PLANTED.filter((item) => item.kind === 'amount')) {
      const settle = settleRows(planted.date).find((row) => row.txId === planted.txId);
      const ledger = ledgerRows(planted.date).find((row) => row.txId === planted.txId);

      expect(settle, planted.txId).toBeDefined();
      expect(ledger, planted.txId).toBeDefined();
      expect(planted.delta, `${planted.txId} delta 선언 없음`).toBeDefined();
      expect(planted.delta, `${planted.txId} delta 가 0`).not.toBe(0);

      const settleAmount = Number(settle?.amount.replace(/,/g, ''));
      const ledgerAmount = Number(ledger?.amount.replace(/,/g, ''));

      // 차이가 값으로 못박혀 있어야 "조용히 같아지는" 일이 없다.
      expect(ledgerAmount - settleAmount, `${planted.date} 차이가 다르다`).toBe(planted.delta);
      expect(ledger?.amount).not.toBe(settle?.amount);
    }
  });

  it('누락 2건은 한쪽에만 있다', () => {
    const missingLedger = PLANTED.find((item) => item.kind === 'missing_ledger');
    expect(missingLedger).toBeDefined();
    const ledgerDay = ledgerRows(missingLedger?.date ?? '');
    expect(ledgerDay.some((row) => row.txId === missingLedger?.txId)).toBe(false);
    expect(ledgerDay).toHaveLength(ROWS_PER_DAY - 1);

    const missingSettle = PLANTED.find((item) => item.kind === 'missing_settle');
    expect(missingSettle).toBeDefined();
    const settleDay = settleRows(missingSettle?.date ?? '');
    expect(settleDay.some((row) => row.txId === missingSettle?.txId)).toBe(false);
    expect(ledgerRows(missingSettle?.date ?? '')).toHaveLength(ROWS_PER_DAY + 1);
  });

  it('식별자 오타 1건은 0 이 O 로 바뀌었을 뿐 금액은 같다 — 그래서 REVIEW 다', () => {
    const typo = PLANTED.find((item) => item.kind === 'typo_id');
    expect(typo).toBeDefined();

    const date = typo?.date ?? '';
    const settle = settleRows(date).find((row) => row.txId === typo?.txId);
    const ledger = ledgerRows(date).find((row) => row.txId !== undefined && /O/.test(row.txId));

    expect(settle).toBeDefined();
    expect(ledger, '오타 전표가 없다').toBeDefined();
    expect(ledger?.txId).not.toBe(settle?.txId);
    expect(ledger?.txId?.replace(/O/g, '0')).toBe(settle?.txId);
    // 금액이 같아야 sum_equal 은 통과하고 매칭 규칙만 걸린다.
    expect(ledger?.amount).toBe(settle?.amount);
  });

  it('정상 14일은 두 시스템이 완전히 같다', () => {
    const plantedDates = new Set(PLANTED.map((item) => item.date));
    const cleanDates = SETTLE_DATES.filter((date) => !plantedDates.has(date));
    expect(cleanDates).toHaveLength(14);

    for (const date of cleanDates) {
      const settle = settleRows(date);
      const ledger = ledgerRows(date);

      expect(ledger, date).toHaveLength(settle.length);

      for (const row of settle) {
        const match = ledger.find((item) => item.txId === row.txId);
        expect(match, `${date} ${row.txId} 짝이 없다`).toBeDefined();
        expect(match?.amount, `${date} ${row.txId} 금액이 다르다`).toBe(row.amount);
      }
    }
  });
});

describe('정답표', () => {
  it('커밋된 파일이 PLANTED 선언과 일치한다', () => {
    const index = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'index.json'), 'utf-8')) as {
      total: number;
      verdicts: Record<string, number>;
    };

    expect(index.total).toBe(20);
    expect(index.verdicts).toEqual({ PASS: 14, FAIL: 5, REVIEW: 1 });

    for (const expected of expectedAll()) {
      const file = path.join(GOLDEN, 'expected', `${expected.date}.json`);
      expect(fs.existsSync(file), `${expected.date} 정답표 없음`).toBe(true);

      const committed = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof expected;
      expect(committed, `${expected.date} 정답표가 어긋났다`).toEqual(expected);
    }
  });

  it('금액·누락은 FAIL, 오타는 REVIEW 다', () => {
    const byDate = new Map(expectedAll().map((day) => [day.date, day]));

    expect(byDate.get('2026-03-04')?.verdict).toBe('FAIL');
    expect(byDate.get('2026-03-06')?.verdict).toBe('FAIL');
    expect(byDate.get('2026-03-11')?.verdict).toBe('FAIL');
    expect(byDate.get('2026-03-17')?.verdict).toBe('FAIL');
    expect(byDate.get('2026-03-19')?.verdict).toBe('FAIL');
    expect(byDate.get('2026-03-25')?.verdict).toBe('REVIEW');
    expect(byDate.get('2026-03-02')?.verdict).toBe('PASS');
    expect(byDate.get('2026-03-02')?.findings).toEqual([]);
  });
});

describe('정산 포털 (H-1)', () => {
  it('API 가 JSON 그리드를 준다', async () => {
    setSettleApi(true);
    const response = routePortalSettle(new URL('app://portal-h-settle/api/settlements?date=2026-03-02'));
    expect(response.status).toBe(200);

    const payload = await jsonOf<{ total: number; rows: { txId: string; amount: string }[] }>(response);
    expect(payload.total).toBe(5);
    expect(payload.rows[0]?.txId).toBe('TX-20260302-01');
    expect(payload.rows[0]?.amount).toMatch(/^[\d,]+$/);
  });

  it('화면은 조회 전까지 비어 있고 XHR 로 채운다', async () => {
    const body = await bodyOf(routePortalSettle(new URL('app://portal-h-settle/')));
    expect(body).toMatch(/<tbody id="settle-body"><\/tbody>/);
    // 스크립트 없이 보는 정적 표는 접혀 있다(폴백 경로).
    expect(body).toContain('id="fallback-table"');
  });

  it('API 를 끄면 503 — 어댑터가 dom 으로 내려가야 한다', async () => {
    setSettleApi(false);
    const response = routePortalSettle(new URL('app://portal-h-settle/api/settlements?date=2026-03-02'));
    expect(response.status).toBe(503);

    // 화면의 정적 표에는 여전히 데이터가 있다.
    const body = await bodyOf(routePortalSettle(new URL('app://portal-h-settle/?date=2026-03-02')));
    expect(body).toContain('TX-20260302-01');
    setSettleApi(true);
  });

  it('모르는 날짜는 빈 결과다', async () => {
    const payload = await jsonOf<{ rows: unknown[] }>(
      routePortalSettle(new URL('app://portal-h-settle/api/settlements?date=1999-01-01'))
    );
    expect(payload.rows).toEqual([]);
  });
});

describe('회계 시스템 (H-2)', () => {
  it('조회해야 표가 나온다 — 주소만으로는 비어 있다', async () => {
    const before = await bodyOf(routePortalLedger(new URL('app://portal-h-ledger/?date=2026-03-02')));
    expect(before).toMatch(/<tbody id="ledger-body"><\/tbody>/);
    expect(before).toContain('조회 전');

    const after = await bodyOf(
      routePortalLedger(new URL('app://portal-h-ledger/?date=2026-03-02&q=1'))
    );
    expect(after).toContain('V-20260302-01');
    expect(after).toContain('조회 완료 5건');
  });

  it('Excel 다운로드가 화면과 같은 데이터를 준다', async () => {
    const response = routePortalLedger(
      new URL('app://portal-h-ledger/download.xlsx?date=2026-03-04')
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('spreadsheetml');

    const buffer = Buffer.from(await response.arrayBuffer());
    const sheet = readXlsx(buffer).sheet;

    // 제목 행 병합 + 2행 헤더
    expect(sheet.merges[0]?.ref).toBe('A1:E1');
    expect(sheet.valueAt(0, 2)?.text).toBe('2026-03-04 전표 목록');

    const records = sheetToRecords(sheet, 1);
    const ledger = ledgerRows('2026-03-04');
    expect(records).toHaveLength(ledger.length);

    // 금액은 숫자로, 날짜는 YYYY-MM-DD 로 읽힌다
    const first = records[0];
    expect(first?.['전표번호']).toBe(ledger[0]?.voucherNo);
    expect(first?.['금액']).toBe(String(Number(ledger[0]?.amount.replace(/,/g, ''))));
    expect(first?.['전표일자']).toBe('2026-03-04');

    // 금액 차이가 심긴 거래는 파일에서도 다르다
    const diff = records.find((row) => row['거래번호'] === 'TX-20260304-02');
    const settle = settleRows('2026-03-04').find((row) => row.txId === 'TX-20260304-02');
    expect(diff?.['금액']).not.toBe(String(Number(settle?.amount.replace(/,/g, ''))));
  });

  it('모르는 날짜의 다운로드는 404 다', () => {
    expect(
      routePortalLedger(new URL('app://portal-h-ledger/download.xlsx?date=1999-01-01')).status
    ).toBe(404);
  });
});
