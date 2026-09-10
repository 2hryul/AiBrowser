import { normalizeAmount, normalizeId } from './normalize';

/**
 * reconcile — 두 목록을 짝지어 맞는지 본다.
 *
 * 3단계로 내려간다. **위 단계에서 짝을 찾으면 아래로 내려가지 않는다.**
 *
 *   1. `exact`     키가 정확히 같다 → 그대로 믿는다
 *   2. `tolerance` 키는 같고 금액이 허용 오차 안 → 반올림 차이 등. 여전히 매칭이지만 표시한다
 *   3. `fuzzy`     키가 한 글자쯤 다르다(편집 거리 1) → 짝일 **가능성**이다. 사람이 봐야 한다
 *
 * 3단계는 매칭이라고 부르되 `review: true` 를 달아 돌려준다. 퍼지 매칭을 조용히 정답으로
 * 삼으면 서로 다른 거래를 같다고 말하게 된다 — 오탐이 정확히 여기서 난다.
 */

export type MatchTier = 'exact' | 'tolerance' | 'fuzzy';

export interface ReconcileOptions {
  /** 매칭 키 항목 */
  key: string;
  /** 금액 항목 — 있으면 값 비교와 허용 오차 판정을 한다 */
  amountField?: string;
  /** 허용 오차(원). 0 이면 완전 일치만 tolerance 단계를 통과한다. */
  tolerance?: number;
  /** 퍼지 매칭 허용 편집 거리. 0 이면 퍼지 단계를 쓰지 않는다. */
  fuzzyDistance?: number;
}

export interface Match {
  key: string;
  tier: MatchTier;
  left: Record<string, unknown>;
  right: Record<string, unknown>;
  /** 금액 차이(오른쪽 - 왼쪽). 금액 항목이 없으면 null */
  diff: number | null;
  /** 사람 확인이 필요한 매칭인가 */
  review: boolean;
  /** 퍼지 매칭일 때 어떤 키끼리 붙었는지 */
  matchedWith?: string;
}

export interface ReconcileResult {
  matches: Match[];
  /** 왼쪽에만 있는 행 */
  onlyLeft: Record<string, unknown>[];
  /** 오른쪽에만 있는 행 */
  onlyRight: Record<string, unknown>[];
  /** 금액이 어긋난 매칭(허용 오차 밖) */
  mismatched: Match[];
  counts: {
    left: number;
    right: number;
    exact: number;
    tolerance: number;
    fuzzy: number;
    onlyLeft: number;
    onlyRight: number;
    mismatched: number;
  };
}

/** 편집 거리. 식별자는 짧아서 단순 DP 로 충분하다. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      );
    }

    previous = current;
  }

  return previous[b.length] ?? 0;
}

function keyOf(row: Record<string, unknown>, field: string): string {
  return normalizeId(row[field]);
}

function amountOf(row: Record<string, unknown>, field: string | undefined): number | null {
  if (field === undefined) return null;
  try {
    return normalizeAmount(row[field]);
  } catch {
    return null;
  }
}

export function reconcile(
  left: readonly Record<string, unknown>[],
  right: readonly Record<string, unknown>[],
  options: ReconcileOptions
): ReconcileResult {
  const tolerance = options.tolerance ?? 0;
  const fuzzyDistance = options.fuzzyDistance ?? 0;

  const rightByKey = new Map<string, Record<string, unknown>>();
  for (const row of right) rightByKey.set(keyOf(row, options.key), row);

  const matches: Match[] = [];
  const onlyLeft: Record<string, unknown>[] = [];
  const usedRight = new Set<string>();

  // ── 1·2단계: 정확 키 매칭 ──
  const unmatchedLeft: Record<string, unknown>[] = [];

  for (const row of left) {
    const key = keyOf(row, options.key);
    const other = rightByKey.get(key);

    if (!other) {
      unmatchedLeft.push(row);
      continue;
    }

    usedRight.add(key);
    matches.push(makeMatch(key, 'exact', row, other, options, tolerance));
  }

  // ── 3단계: 남은 것끼리 퍼지 매칭 ──
  const leftoverRight = [...rightByKey.entries()].filter(([key]) => !usedRight.has(key));

  for (const row of unmatchedLeft) {
    const key = keyOf(row, options.key);

    if (fuzzyDistance <= 0) {
      onlyLeft.push(row);
      continue;
    }

    let best: { key: string; row: Record<string, unknown>; distance: number } | null = null;

    for (const [otherKey, otherRow] of leftoverRight) {
      if (usedRight.has(otherKey)) continue;

      const distance = editDistance(key, otherKey);
      if (distance > fuzzyDistance) continue;
      if (best === null || distance < best.distance) {
        best = { key: otherKey, row: otherRow, distance };
      }
    }

    if (!best) {
      onlyLeft.push(row);
      continue;
    }

    usedRight.add(best.key);
    const match = makeMatch(key, 'fuzzy', row, best.row, options, tolerance);
    match.matchedWith = best.key;
    // 퍼지는 언제나 사람 확인 대상이다 — 금액이 맞아도 마찬가지다.
    match.review = true;
    matches.push(match);
  }

  const onlyRight = [...rightByKey.entries()]
    .filter(([key]) => !usedRight.has(key))
    .map(([, row]) => row);

  const mismatched = matches.filter(
    (match) => match.diff !== null && Math.abs(match.diff) > tolerance
  );

  return {
    matches,
    onlyLeft,
    onlyRight,
    mismatched,
    counts: {
      left: left.length,
      right: right.length,
      exact: matches.filter((match) => match.tier === 'exact').length,
      tolerance: matches.filter((match) => match.tier === 'tolerance').length,
      fuzzy: matches.filter((match) => match.tier === 'fuzzy').length,
      onlyLeft: onlyLeft.length,
      onlyRight: onlyRight.length,
      mismatched: mismatched.length
    }
  };
}

function makeMatch(
  key: string,
  tier: MatchTier,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  options: ReconcileOptions,
  tolerance: number
): Match {
  const leftAmount = amountOf(left, options.amountField);
  const rightAmount = amountOf(right, options.amountField);
  const diff = leftAmount === null || rightAmount === null ? null : rightAmount - leftAmount;

  // 금액이 정확히 같지 않지만 허용 오차 안이면 2단계로 표시한다 —
  // "맞다" 와 "허용 범위라 넘어간다" 는 다른 말이고, 증거에 그렇게 남아야 한다.
  const withinTolerance = diff !== null && diff !== 0 && Math.abs(diff) <= tolerance;
  const finalTier: MatchTier = tier === 'exact' && withinTolerance ? 'tolerance' : tier;

  return {
    key,
    tier: finalTier,
    left,
    right,
    diff,
    review: finalTier === 'fuzzy'
  };
}
