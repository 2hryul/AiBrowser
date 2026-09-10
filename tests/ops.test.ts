import { describe, expect, it } from 'vitest';
import {
  NormalizeError,
  normalizeAmount,
  normalizeDate,
  normalizeId,
  normalizeRows,
  normalizeText
} from '../src/main/workflow/ops/normalize';
import { editDistance, reconcile } from '../src/main/workflow/ops/reconcile';
import { UNKNOWN_LABEL, classify } from '../src/main/workflow/ops/classify';
import { lookup } from '../src/main/workflow/ops/lookup';

/**
 * 연산 단위 테스트 (`npm run test:ops`, GOAL-M5 성공 조건 3).
 *
 *   - reconcile 매칭 3단계(정확·허용오차·퍼지) 골든 10건
 *   - normalize 결정성 — 같은 입력 100회 동일 출력
 *   - classify enum 제한 — 허용 외 출력은 REVIEW
 */

// ─────────────────────────────────────────────────────────────
// reconcile 골든 10건
// ─────────────────────────────────────────────────────────────

interface Row {
  txId: string;
  amount: string;
  [key: string]: unknown;
}

const row = (txId: string, amount: string): Row => ({ txId, amount });

describe('reconcile — 매칭 3단계 골든 10건', () => {
  const options = { key: 'txId', amountField: 'amount', tolerance: 100, fuzzyDistance: 1 };

  it('골든 1 — 정확 매칭: 키도 금액도 같다', () => {
    const result = reconcile([row('TX-1', '1,000')], [row('TX-1', '1,000')], options);

    expect(result.counts).toMatchObject({ exact: 1, tolerance: 0, fuzzy: 0, onlyLeft: 0, onlyRight: 0 });
    expect(result.matches[0]?.tier).toBe('exact');
    expect(result.matches[0]?.diff).toBe(0);
    expect(result.matches[0]?.review).toBe(false);
    expect(result.mismatched).toHaveLength(0);
  });

  it('골든 2 — 정규화 후 정확 매칭: 대소문자·구분자·쉼표가 달라도 같다', () => {
    const result = reconcile([row('tx-1', '1,000')], [row('TX_1', '1000')], options);

    expect(result.counts.exact).toBe(1);
    expect(result.matches[0]?.diff).toBe(0);
  });

  it('골든 3 — 허용오차 매칭: 금액이 오차 안에서 다르다', () => {
    const result = reconcile([row('TX-1', '1,000')], [row('TX-1', '1,050')], options);

    expect(result.counts).toMatchObject({ exact: 0, tolerance: 1, fuzzy: 0 });
    expect(result.matches[0]?.tier).toBe('tolerance');
    expect(result.matches[0]?.diff).toBe(50);
    // 오차 안이므로 불일치는 아니다
    expect(result.mismatched).toHaveLength(0);
  });

  it('골든 4 — 오차 밖: 매칭은 되지만 금액 불일치로 잡힌다', () => {
    const result = reconcile([row('TX-1', '1,000')], [row('TX-1', '1,500')], options);

    expect(result.counts.mismatched).toBe(1);
    expect(result.mismatched[0]?.diff).toBe(500);
  });

  it('골든 5 — 퍼지 매칭: 한 글자 다른 키를 짝짓되 review 를 단다', () => {
    const result = reconcile([row('TX-20260325-03', '1,000')], [row('TX-2026O325-03', '1,000')], options);

    expect(result.counts).toMatchObject({ exact: 0, fuzzy: 1, onlyLeft: 0, onlyRight: 0 });
    expect(result.matches[0]?.tier).toBe('fuzzy');
    expect(result.matches[0]?.review, '퍼지 매칭은 언제나 사람 확인 대상이다').toBe(true);
    expect(result.matches[0]?.matchedWith).toBe('TX2026O32503');
    // 금액이 같아도 review 는 유지된다
    expect(result.matches[0]?.diff).toBe(0);
  });

  it('골든 6 — 편집 거리 초과: 짝짓지 않고 양쪽 미매칭으로 남긴다', () => {
    const result = reconcile([row('TX-1000', '1,000')], [row('TX-9999', '1,000')], options);

    expect(result.counts).toMatchObject({ exact: 0, fuzzy: 0, onlyLeft: 1, onlyRight: 1 });
  });

  it('골든 7 — 왼쪽에만 있는 행(회계 누락)', () => {
    const result = reconcile([row('TX-1', '1,000'), row('TX-2', '2,000')], [row('TX-1', '1,000')], options);

    expect(result.counts).toMatchObject({ exact: 1, onlyLeft: 1, onlyRight: 0 });
    expect((result.onlyLeft[0] as Row).txId).toBe('TX-2');
  });

  it('골든 8 — 오른쪽에만 있는 행(정산 누락)', () => {
    const result = reconcile([row('TX-1', '1,000')], [row('TX-1', '1,000'), row('TX-9', '900')], options);

    expect(result.counts).toMatchObject({ exact: 1, onlyLeft: 0, onlyRight: 1 });
    expect((result.onlyRight[0] as Row).txId).toBe('TX-9');
  });

  it('골든 9 — 퍼지를 끄면 오타는 미매칭이다', () => {
    const strict = { ...options, fuzzyDistance: 0 };
    const result = reconcile([row('TX-1', '1,000')], [row('TX-I', '1,000')], strict);

    expect(result.counts).toMatchObject({ fuzzy: 0, onlyLeft: 1, onlyRight: 1 });
  });

  it('골든 10 — 같은 오른쪽 행을 두 번 쓰지 않는다', () => {
    // 왼쪽 두 행이 모두 오른쪽 한 행과 편집 거리 1 이다.
    const result = reconcile(
      [row('TX-1', '1,000'), row('TX-2', '1,000')],
      [row('TX-3', '1,000')],
      options
    );

    expect(result.counts.fuzzy, '한 행에 두 번 붙으면 안 된다').toBe(1);
    expect(result.counts.onlyLeft).toBe(1);
    expect(result.counts.onlyRight).toBe(0);
  });

  it('편집 거리는 대칭이고 경계값이 맞는다', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abc', 'abd')).toBe(1);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abd', 'abc')).toBe(editDistance('abc', 'abd'));
  });
});

// ─────────────────────────────────────────────────────────────
// normalize
// ─────────────────────────────────────────────────────────────

describe('normalize — 결정성과 형식', () => {
  it('같은 입력을 100회 넣어도 같은 값이 나온다', () => {
    const inputs = ['2026.03.04', '1,250,000', 'tx-20260304-02', '  여러   공백  '];

    for (const input of inputs) {
      const first = [
        normalizeDate('2026.03.04'),
        normalizeAmount('1,250,000'),
        normalizeId('tx-20260304-02'),
        normalizeText('  여러   공백  ')
      ];

      for (let round = 0; round < 100; round += 1) {
        expect([
          normalizeDate('2026.03.04'),
          normalizeAmount('1,250,000'),
          normalizeId('tx-20260304-02'),
          normalizeText('  여러   공백  ')
        ], `${input} ${round}회차`).toEqual(first);
      }
    }
  });

  it('날짜: 여러 표기를 YYYY-MM-DD 로 모은다', () => {
    for (const input of ['2026-03-04', '2026.03.04', '2026/03/04', '20260304', '2026년 3월 4일']) {
      expect(normalizeDate(input), input).toBe('2026-03-04');
    }

    expect(normalizeDate('2026-3-4')).toBe('2026-03-04');
  });

  it('날짜: 두 자리 연도는 받지 않는다 — 추측하면 결정적이지 않다', () => {
    expect(() => normalizeDate('26-03-04')).toThrow(NormalizeError);
    expect(() => normalizeDate('')).toThrow(/빈 값/);
    expect(() => normalizeDate('2026-13-01')).toThrow(/월/);
    expect(() => normalizeDate('2026-03-32')).toThrow(/일/);
  });

  it('금액: 쉼표·통화기호·단위·괄호 음수를 처리한다', () => {
    expect(normalizeAmount('1,250,000')).toBe(1_250_000);
    expect(normalizeAmount('1250000')).toBe(1_250_000);
    expect(normalizeAmount('₩1,250,000')).toBe(1_250_000);
    expect(normalizeAmount('1,250,000원')).toBe(1_250_000);
    expect(normalizeAmount('1 250 000')).toBe(1_250_000);
    expect(normalizeAmount('(1,250)')).toBe(-1250);
    expect(normalizeAmount('-1,250')).toBe(-1250);
    expect(normalizeAmount('1250.5')).toBe(1250.5);
    expect(normalizeAmount(1_250_000)).toBe(1_250_000);

    expect(() => normalizeAmount('금액없음')).toThrow(NormalizeError);
    expect(() => normalizeAmount('')).toThrow(/빈 값/);
  });

  it('식별자: 대문자·구분자 제거는 하되 혼동 문자는 접지 않는다', () => {
    expect(normalizeId('tx-20260304-02')).toBe('TX2026030402');
    expect(normalizeId('TX_2026 0304 02')).toBe('TX2026030402');

    // O 를 0 으로 바꾸면 서로 다른 식별자가 같아진다 — 오탐의 지름길이다.
    expect(normalizeId('TX-2026O325-03')).not.toBe(normalizeId('TX-20260325-03'));
  });

  it('행 단위 정규화는 원본을 남기고 값을 더한다', () => {
    const rows = normalizeRows([{ date: '2026.03.04', amount: '1,250,000', txId: 'tx-1' }], {
      fields: { date: 'date', amount: 'amount', txId: 'id' }
    });

    expect(rows[0]).toEqual({
      date: '2026.03.04',
      amount: '1,250,000',
      txId: 'tx-1',
      date_n: '2026-03-04',
      amount_n: 1_250_000,
      txId_n: 'TX1'
    });
  });

  it('정규화 실패는 몇 행 어느 항목인지 알려준다', () => {
    expect(() => normalizeRows([{ date: 'ㅁㄴㅇㄹ' }], { fields: { date: 'date' } })).toThrow(
      /0행 date/
    );
  });
});

// ─────────────────────────────────────────────────────────────
// classify
// ─────────────────────────────────────────────────────────────

describe('classify — enum 제한과 폴백', () => {
  const allowed = ['정상', '금액상이', '일방누락'] as const;

  it('규칙으로 정해지면 LLM 을 부르지 않는다', async () => {
    let called = 0;

    const outcome = await classify('금액이 다릅니다', {
      allowed,
      rules: [{ label: '금액상이', keywords: ['금액'] }],
      fallback: async () => {
        called += 1;
        return '정상';
      }
    });

    expect(outcome.label).toBe('금액상이');
    expect(outcome.source).toBe('const');
    expect(outcome.review).toBe(false);
    expect(called, '규칙으로 정해졌는데 폴백을 불렀다').toBe(0);
  });

  it('허용 목록 밖 응답은 unknown + REVIEW 다', async () => {
    const outcome = await classify('알 수 없는 상황', {
      allowed,
      fallback: async () => '내가 만든 새 분류'
    });

    expect(outcome.label).toBe(UNKNOWN_LABEL);
    expect(outcome.review).toBe(true);
    expect(outcome.source).toBe('llm');
    expect(outcome.reason).toContain('허용 목록 밖');
  });

  it('허용 목록 안 응답이라도 LLM 출처면 REVIEW 다', async () => {
    const outcome = await classify('애매한 값', {
      allowed,
      fallback: async () => '정상'
    });

    expect(outcome.label).toBe('정상');
    expect(outcome.source, 'PASS 근거로 쓰이면 Verifier 가 강등한다').toBe('llm');
    expect(outcome.review).toBe(true);
  });

  it('폴백이 없으면 기본값을 고르지 않고 unknown 이다', async () => {
    const outcome = await classify('규칙에 없는 값', { allowed });

    expect(outcome.label).toBe(UNKNOWN_LABEL);
    expect(outcome.review).toBe(true);
    expect(outcome.reason).toContain('폴백이 없습니다');
  });

  it('폴백이 실패해도 분류를 지어내지 않는다', async () => {
    const outcome = await classify('값', {
      allowed,
      fallback: async () => {
        throw new Error('연결 실패');
      }
    });

    expect(outcome.label).toBe(UNKNOWN_LABEL);
    expect(outcome.review).toBe(true);
    expect(outcome.reason).toContain('연결 실패');
  });

  it('허용 목록 밖을 가리키는 규칙은 무시한다 — 설정 오류가 통과하면 안 된다', async () => {
    const outcome = await classify('아무거나', {
      allowed,
      rules: [{ label: '존재하지않는분류', keywords: ['아무'] }]
    });

    expect(outcome.label).toBe(UNKNOWN_LABEL);
  });
});

// ─────────────────────────────────────────────────────────────
// lookup
// ─────────────────────────────────────────────────────────────

describe('lookup — 코드표', () => {
  it('찾은 값은 붙이고 못 찾은 코드는 모아 돌려준다', () => {
    const result = lookup(
      [{ code: 'A1' }, { code: 'B2' }, { code: 'ZZ' }, { code: 'ZZ' }],
      { field: 'code', as: 'name', table: { A1: '가온', B2: '나래' } }
    );

    expect(result.found).toBe(2);
    expect(result.rows[0]).toEqual({ code: 'A1', name: '가온' });
    // 못 찾으면 항목을 만들지 않는다(빈 문자열로 덮어 조용히 넘어가지 않는다)
    expect(result.rows[2]).toEqual({ code: 'ZZ' });
    expect(result.missing).toEqual(['ZZ']);
  });

  it('fallback 을 주면 그 값을 넣는다', () => {
    const result = lookup([{ code: 'ZZ' }], {
      field: 'code',
      as: 'name',
      table: {},
      fallback: '(미등록)'
    });

    expect(result.rows[0]).toEqual({ code: 'ZZ', name: '(미등록)' });
    expect(result.missing).toEqual(['ZZ']);
  });
});
