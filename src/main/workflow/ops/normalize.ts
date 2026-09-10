/**
 * normalize — 날짜·금액·식별자를 하나의 모양으로 맞춘다.
 *
 * **결정적이어야 한다.** 같은 입력이면 언제나 같은 출력이다(성공 조건 3: 100회 동일).
 * 그래서 여기에는 현재 시각·로케일·난수가 없다. `toLocaleString` 같은 함수도 쓰지 않는다 —
 * 실행 환경의 로케일에 따라 결과가 달라진다.
 *
 * 정규화가 대사의 절반이다. "1,250,000" 과 "1250000", "2026.03.04" 와 "2026-03-04",
 * "tx-20260304-02" 와 "TX-20260304-02" 를 같게 보지 못하면 멀쩡한 짝이 불일치로 잡힌다
 * (= 오탐의 주된 원인).
 */

export type NormalizeKind = 'date' | 'amount' | 'id' | 'text';

export class NormalizeError extends Error {
  constructor(message: string) {
    super(`[normalize] ${message}`);
    this.name = 'NormalizeError';
  }
}

/**
 * 날짜 → `YYYY-MM-DD`.
 *
 * 받는 모양: `2026-03-04`, `2026.03.04`, `2026/03/04`, `20260304`, `2026년 3월 4일`.
 * 두 자리 연도(`26-03-04`)는 **받지 않는다** — 1926 인지 2026 인지 추측하는 순간
 * 결정적이지 않게 된다. 모르면 던지는 편이 낫다.
 */
export function normalizeDate(input: unknown): string {
  const text = String(input ?? '').trim();
  if (text === '') throw new NormalizeError('빈 값은 날짜가 아닙니다');

  const korean = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/.exec(text);
  if (korean) return pad(korean[1], korean[2], korean[3]);

  const separated = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(text);
  if (separated) return pad(separated[1], separated[2], separated[3]);

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return pad(compact[1], compact[2], compact[3]);

  throw new NormalizeError(`날짜로 읽을 수 없습니다: "${text}"`);
}

function pad(year?: string, month?: string, day?: string): string {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  if (m < 1 || m > 12) throw new NormalizeError(`월이 범위를 벗어납니다: ${month}`);
  if (d < 1 || d > 31) throw new NormalizeError(`일이 범위를 벗어납니다: ${day}`);

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 금액 → 숫자.
 *
 * 받는 모양: `1,250,000`, `1250000`, `₩1,250,000`, `1,250,000원`, `(1,250)`(음수 회계 표기),
 * `-1,250`, `1 250 000`(공백 구분).
 * 소수점은 그대로 살린다. 통화 기호·단위는 떼고 값만 남긴다.
 */
export function normalizeAmount(input: unknown): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new NormalizeError(`금액이 유한수가 아닙니다: ${input}`);
    return input;
  }

  let text = String(input ?? '').trim();
  if (text === '') throw new NormalizeError('빈 값은 금액이 아닙니다');

  // 회계 표기: 괄호는 음수다.
  let negative = false;
  const parens = /^\((.*)\)$/.exec(text);
  if (parens) {
    negative = true;
    text = parens[1] ?? '';
  }

  // 통화 기호·단위·자릿수 구분자를 뗀다. 전각 공백까지 포함해 지운다.
  const cleaned = text
    .replace(/[₩$￦]/g, '')
    .replace(/원/g, '')
    .replace(/[,\s]/g, '');

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new NormalizeError(`금액으로 읽을 수 없습니다: "${String(input)}"`);
  }

  const value = Number(cleaned);
  return negative ? -value : value;
}

/**
 * 식별자 → 대문자·구분자 제거.
 *
 * **혼동 문자를 접지 않는다.** `O`→`0`, `l`→`1` 같은 치환은 매칭률을 올리지만 서로 다른
 * 식별자를 같다고 말하게 된다. 오타는 퍼지 매칭이 REVIEW 로 잡을 일이지 정규화가
 * 조용히 덮을 일이 아니다(= 오탐의 지름길).
 */
export function normalizeId(input: unknown): string {
  const text = String(input ?? '').trim();
  if (text === '') throw new NormalizeError('빈 값은 식별자가 아닙니다');

  return text.toUpperCase().replace(/[\s_-]/g, '');
}

/** 공백을 하나로, 앞뒤를 자른다. 표시용 문자열 비교에 쓴다. */
export function normalizeText(input: unknown): string {
  return String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeValue(kind: NormalizeKind, input: unknown): string | number {
  switch (kind) {
    case 'date':
      return normalizeDate(input);
    case 'amount':
      return normalizeAmount(input);
    case 'id':
      return normalizeId(input);
    case 'text':
      return normalizeText(input);
    default:
      throw new NormalizeError(`알 수 없는 종류: ${String(kind)}`);
  }
}

export interface NormalizeSpec {
  /** 항목 이름 → 정규화 종류 */
  fields: Record<string, NormalizeKind>;
  /** 정규화한 값을 어떤 이름으로 넣을지. 생략하면 원래 이름을 덮어쓴다. */
  suffix?: string;
}

/**
 * 목록의 각 행을 정규화한다. 원본 항목은 남기고 정규화 값을 **더한다**(기본 접미사 `_n`) —
 * 증거 팩에 원본과 정규화 결과가 같이 남아야 "왜 이렇게 판정했나" 를 되짚을 수 있다.
 */
export function normalizeRows(
  rows: readonly Record<string, unknown>[],
  spec: NormalizeSpec
): Record<string, unknown>[] {
  const suffix = spec.suffix ?? '_n';

  return rows.map((row, index) => {
    const out: Record<string, unknown> = { ...row };

    for (const [field, kind] of Object.entries(spec.fields)) {
      try {
        out[`${field}${suffix}`] = normalizeValue(kind, row[field]);
      } catch (error) {
        throw new NormalizeError(`${index}행 ${field}: ${(error as Error).message}`);
      }
    }

    return out;
  });
}
