/**
 * lookup — 코드표를 붙인다(공급사 코드 → 이름, 계정 코드 → 계정명).
 *
 * 못 찾은 값을 조용히 비워 두지 않는다. `missing` 에 모아 돌려주면 `empty` 오라클이
 * 그것만 보고 판정할 수 있다 — "표에 없는 코드가 나왔다" 는 사실이 대사 결과보다
 * 먼저 드러나야 한다.
 */

export interface LookupSpec {
  /** 찾을 항목 이름 */
  field: string;
  /** 붙일 항목 이름 */
  as: string;
  /** 코드 → 값 */
  table: Record<string, string>;
  /** 못 찾았을 때 넣을 값. 생략하면 항목을 만들지 않는다. */
  fallback?: string;
}

export interface LookupResult {
  rows: Record<string, unknown>[];
  /** 표에 없던 코드(중복 제거) */
  missing: string[];
  found: number;
}

export function lookup(
  rows: readonly Record<string, unknown>[],
  spec: LookupSpec
): LookupResult {
  const missing = new Set<string>();
  let found = 0;

  const out = rows.map((row) => {
    const code = String(row[spec.field] ?? '');
    const value = spec.table[code];

    if (value === undefined) {
      missing.add(code);
      return spec.fallback === undefined ? { ...row } : { ...row, [spec.as]: spec.fallback };
    }

    found += 1;
    return { ...row, [spec.as]: value };
  });

  return { rows: out, missing: [...missing].sort(), found };
}
