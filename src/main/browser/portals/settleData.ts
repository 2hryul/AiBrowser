/**
 * 모의 포털 H 의 원천 데이터 — 정산 포털과 회계 시스템이 같은 20일치를 서로 다르게 보여준다.
 *
 * 대사(reconciliation)의 시험대다. 두 시스템이 **같아야 하는데 다른** 6일치를 일부러 심었고,
 * 그 목록(`PLANTED`)이 정답표의 출처다. 정답표를 reconcile 결과에서 뽑으면 순환이 되므로
 * 여기 손으로 적은 선언에서만 만든다.
 *
 * ## 금액을 문자열로 두는 이유 (중요)
 *
 * 금액은 `"1,250,000"` 처럼 천 단위 쉼표가 붙은 **문자열**이다. 숫자로 두면
 * `1250000` 이 7자리 연속 숫자라 M3 의 사번 마스킹 패턴(`(?<!\d)\d{7}(?!\d)`)에 걸려
 * 도구 결과에서 `12*****` 로 바뀐다 — 대사가 성립하지 않는다.
 * 한국 사내 시스템이 실제로 서식 문자열을 주는 경우가 많아 현실적이기도 하고,
 * `normalize` 연산에 실제로 할 일을 준다. (이 상호작용은 tests/portal-h.test.ts 에 고정해 두었다.)
 *
 * `txId` 의 숫자 구간은 8자리(`20260304`)라 같은 패턴에 걸리지 않는다.
 */

/** 대사 대상 기간 — 2026년 3월 평일 20일 */
export const SETTLE_DATES: readonly string[] = [
  '2026-03-02',
  '2026-03-03',
  '2026-03-04',
  '2026-03-05',
  '2026-03-06',
  '2026-03-09',
  '2026-03-10',
  '2026-03-11',
  '2026-03-12',
  '2026-03-13',
  '2026-03-16',
  '2026-03-17',
  '2026-03-18',
  '2026-03-19',
  '2026-03-20',
  '2026-03-23',
  '2026-03-24',
  '2026-03-25',
  '2026-03-26',
  '2026-03-27'
];

/** 하루 거래 수(불일치를 심은 날은 달라진다) */
export const ROWS_PER_DAY = 5;

const VENDORS = ['가온클라우드', '나래정보', '다온시스템', '라온소프트', '마루네트웍스'];
const APPROVERS = ['김민준', '이서연', '박지호', '최수빈', '정예은'];

export interface SettleRow {
  /** 거래 식별자 — 두 시스템의 매칭 키 */
  txId: string;
  date: string;
  vendor: string;
  /** 천 단위 쉼표가 붙은 금액 문자열 */
  amount: string;
  /** 결재자 이름 — 어댑터가 pii 로 선언한다 */
  approver: string;
  /** 결재자 사번 7자리 — 어댑터가 pii 로 선언한다 */
  approverNo: string;
}

export interface LedgerRow {
  /** 전표 번호 */
  voucherNo: string;
  /** 정산의 txId 에 대응 — 오타가 심긴 행이 있다 */
  txId: string;
  date: string;
  vendor: string;
  amount: string;
  approver: string;
  approverNo: string;
}

export type PlantedKind = 'amount' | 'missing_ledger' | 'missing_settle' | 'typo_id';

export interface Planted {
  date: string;
  kind: PlantedKind;
  /** 어느 거래인가 */
  txId: string;
  /** 사람이 읽을 설명 — 정답표에 함께 적는다 */
  note: string;
  /** 기대 판정 */
  verdict: 'FAIL' | 'REVIEW';
  /**
   * `kind: 'amount'` 일 때 회계 금액이 정산보다 얼마 어긋나는가(원).
   *
   * 자릿수를 뒤바꾸는 식의 문자열 조작으로 만들지 않는다 — 자리에 같은 숫자가 오면
   * 조용히 "차이 없음" 이 되어 심은 불일치가 사라진다(실측으로 잡았다).
   * 차이를 값으로 못박아 두면 그런 일이 생기지 않는다.
   */
  delta?: number;
}

/**
 * 의도된 불일치 6건. **이 표가 정답표의 유일한 출처다.**
 *
 * 종류별 기대 판정이 다르다:
 *   - 금액 차이·한쪽 누락 → `FAIL` (합계가 어긋나거나 짝이 없다)
 *   - 식별자 오타 → `REVIEW` (퍼지 매칭으로 짝은 찾지만 사람이 확인해야 한다)
 */
export const PLANTED: readonly Planted[] = [
  {
    date: '2026-03-04',
    kind: 'amount',
    txId: 'TX-20260304-02',
    note: '회계 금액 자릿수 뒤바뀜 — 72,000원 적다',
    verdict: 'FAIL',
    delta: -72_000
  },
  {
    date: '2026-03-06',
    kind: 'missing_ledger',
    txId: 'TX-20260306-05',
    note: '정산에는 있으나 회계 전표가 없다',
    verdict: 'FAIL'
  },
  {
    date: '2026-03-11',
    kind: 'amount',
    txId: 'TX-20260311-04',
    note: '회계 금액이 90,000원 적다',
    verdict: 'FAIL',
    delta: -90_000
  },
  {
    date: '2026-03-17',
    kind: 'missing_settle',
    txId: 'TX-20260317-06',
    note: '회계에만 있는 전표 — 정산 내역이 없다',
    verdict: 'FAIL'
  },
  {
    date: '2026-03-19',
    kind: 'amount',
    txId: 'TX-20260319-01',
    note: '회계 금액이 500원 많다 — 허용오차 밖',
    verdict: 'FAIL',
    delta: 500
  },
  {
    date: '2026-03-25',
    kind: 'typo_id',
    txId: 'TX-20260325-03',
    note: '회계 전표의 거래번호에 0 대신 O — 퍼지 매칭 후 사람 확인 필요',
    verdict: 'REVIEW'
  }
];

// ─────────────────────────────────────────────────────────────
// 생성
// ─────────────────────────────────────────────────────────────

/** 천 단위 쉼표. 사내 화면이 보여주는 그대로. */
export function won(value: number): string {
  return value.toLocaleString('en-US');
}

function compact(date: string): string {
  return date.replace(/-/g, '');
}

/** 결정적 금액 — 날짜·순번에서만 나온다. 7자리 연속 숫자가 되어도 문자열이라 안전하다. */
function amountFor(date: string, index: number): number {
  const day = Number(date.slice(8, 10));
  return 500_000 + day * 25_000 + index * 90_000;
}

function plantedFor(date: string, kind: PlantedKind): Planted | undefined {
  return PLANTED.find((item) => item.date === date && item.kind === kind);
}

/** 정산 포털의 하루치. `/api/settlements?date=` 가 이 배열을 JSON 으로 준다. */
export function settleRows(date: string): SettleRow[] {
  const rows: SettleRow[] = [];

  for (let index = 1; index <= ROWS_PER_DAY; index += 1) {
    const txId = `TX-${compact(date)}-${String(index).padStart(2, '0')}`;

    rows.push({
      txId,
      date,
      vendor: VENDORS[(index - 1) % VENDORS.length] ?? '가온클라우드',
      amount: won(amountFor(date, index)),
      approver: APPROVERS[(index - 1) % APPROVERS.length] ?? '김민준',
      approverNo: String(1_000_000 + Number(compact(date).slice(4)) * 7 + index)
    });
  }

  return rows;
}

/**
 * 회계 시스템의 하루치. 정산과 같아야 하지만 심긴 불일치가 반영된다.
 * 서버 렌더링 표와 xlsx 다운로드가 모두 이 배열을 쓴다.
 */
export function ledgerRows(date: string): LedgerRow[] {
  const rows: LedgerRow[] = [];

  const missingLedger = plantedFor(date, 'missing_ledger');
  const amountDiff = plantedFor(date, 'amount');
  const typo = plantedFor(date, 'typo_id');
  const extra = plantedFor(date, 'missing_settle');

  for (const source of settleRows(date)) {
    // 한쪽 누락: 이 거래의 전표를 만들지 않는다.
    if (missingLedger && missingLedger.txId === source.txId) continue;

    const index = Number(source.txId.slice(-2));
    let amount = source.amount;
    let txId = source.txId;

    if (amountDiff && amountDiff.txId === source.txId) {
      amount = won(amountFor(date, index) + (amountDiff.delta ?? 0));
    }

    if (typo && typo.txId === source.txId) {
      // 0 을 대문자 O 로 잘못 입력한 전표. 사람 눈에는 같아 보인다.
      txId = source.txId.replace(/^TX-(\d{4})0/, 'TX-$1O');
    }

    rows.push({
      voucherNo: `V-${compact(date)}-${String(index).padStart(2, '0')}`,
      txId,
      date,
      vendor: source.vendor,
      amount,
      approver: source.approver,
      approverNo: source.approverNo
    });
  }

  // 회계에만 있는 전표(정산 누락).
  if (extra) {
    const index = Number(extra.txId.slice(-2));
    rows.push({
      voucherNo: `V-${compact(date)}-${String(index).padStart(2, '0')}`,
      txId: extra.txId,
      date,
      vendor: VENDORS[index % VENDORS.length] ?? '마루네트웍스',
      amount: won(amountFor(date, index)),
      approver: APPROVERS[index % APPROVERS.length] ?? '정예은',
      approverNo: String(1_000_000 + Number(compact(date).slice(4)) * 7 + index)
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────
// 정답표
// ─────────────────────────────────────────────────────────────

export interface ExpectedDay {
  date: string;
  verdict: 'PASS' | 'FAIL' | 'REVIEW';
  /** 이 날 심긴 불일치. PASS 인 날은 빈 배열. */
  findings: { kind: PlantedKind; txId: string; note: string }[];
}

/**
 * 날짜별 기대 판정. `PLANTED` 선언에서만 만들고, 대사 결과는 보지 않는다 —
 * 그래야 골든셋이 파이프라인을 실제로 검증한다.
 */
export function expectedDay(date: string): ExpectedDay {
  const planted = PLANTED.filter((item) => item.date === date);

  if (planted.length === 0) {
    return { date, verdict: 'PASS', findings: [] };
  }

  // 판정 합성은 최악값이다(FAIL > REVIEW > PASS).
  const verdict = planted.some((item) => item.verdict === 'FAIL') ? 'FAIL' : 'REVIEW';

  return {
    date,
    verdict,
    findings: planted.map((item) => ({ kind: item.kind, txId: item.txId, note: item.note }))
  };
}

export function expectedAll(): ExpectedDay[] {
  return SETTLE_DATES.map(expectedDay);
}

/** 테스트가 기대값을 얻는 통로. */
export const settleHooks = {
  dates: SETTLE_DATES,
  rowsPerDay: ROWS_PER_DAY,
  planted: PLANTED,
  settleRows,
  ledgerRows,
  expectedAll
};
