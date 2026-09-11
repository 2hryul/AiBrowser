import type { Provenanced } from './types';

/**
 * 값 표 조회.
 *
 * 표의 키는 단계의 `as` 이름(`settle`, `recon`, `inputs.date` …)이고, 오라클과 치환은
 * 그 안쪽을 `recon.counts.exact` 처럼 점으로 가리킨다. 조회를 한 곳에 모아 둔 이유는
 * **출처를 잃지 않기 위해서**다.
 *
 * 경로로 꺼낸 값의 출처는 그 경로의 머리(`recon`)가 들고 있던 출처를 그대로 쓴다.
 * 이 규칙이 없으면 `llm` 에서 나온 목록의 한 항목을 가리킨 오라클이 출처를 `const` 로 보고
 * PASS 강등을 건너뛴다 — 오탐이 정확히 그 틈으로 들어온다.
 */

/** `recon.counts.exact` 처럼 점으로 이어진 경로를 따라간다. 없으면 undefined. */
export function resolvePath(
  values: Record<string, Provenanced<unknown>>,
  path: string
): unknown {
  return lookupProvenanced(values, path)?.value;
}

/**
 * 경로로 값을 꺼내면서 출처를 함께 돌려준다.
 *
 * 이름이 표에 그대로 있으면 그 항목이 답이다. 없으면 긴 쪽부터 머리를 잘라 가며
 * 표에 있는 이름을 찾고, 남은 조각으로 객체를 파고든다(`recon` + `counts.exact`).
 */
export function lookupProvenanced(
  values: Record<string, Provenanced<unknown>>,
  path: string
): Provenanced<unknown> | undefined {
  const direct = values[path];
  if (direct) return direct;

  const parts = path.split('.');

  for (let take = parts.length - 1; take >= 1; take -= 1) {
    const head = parts.slice(0, take).join('.');
    const entry = values[head];
    if (!entry) continue;

    let cursor: unknown = entry.value;
    for (const part of parts.slice(take)) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }

    if (cursor === undefined) return undefined;

    // 출처는 머리에서 물려받는다 — 안쪽 항목이라고 더 믿을 만해지지 않는다.
    return { ...entry, value: cursor };
  }

  return undefined;
}
