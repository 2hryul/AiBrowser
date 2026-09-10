import fs from 'node:fs';
import path from 'node:path';
import { PLANTED, SETTLE_DATES, expectedAll } from '../src/main/browser/portals/settleData';

/**
 * 골든셋 정답표 생성 — `golden/settle_vs_ledger_daily/expected/<날짜>.json`
 *
 * 정답표는 **`PLANTED` 선언에서만** 만든다. 대사를 돌려서 만들면 "파이프라인이 낸 답을
 * 파이프라인의 정답으로 쓰는" 순환이 되어 아무것도 검증하지 못한다.
 *
 * 한 번 만들고 커밋한 뒤에는 이 파일들이 기준이다. `tests/portal-h.test.ts` 가
 * 커밋된 파일과 `PLANTED` 가 계속 일치하는지 지키고, 실제 검증은 eval 러너가
 * 포털 → 어댑터 → 대사 → 오라클을 거쳐 같은 판정에 도달하는지로 한다.
 *
 *   npm run fixtures:golden
 */

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'golden', 'settle_vs_ledger_daily', 'expected');

fs.mkdirSync(OUT, { recursive: true });

for (const expected of expectedAll()) {
  const file = path.join(OUT, `${expected.date}.json`);
  fs.writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`, 'utf-8');
}

// 목록 파일 — 러너가 무엇을 돌려야 하는지 한 곳에서 읽는다.
const index = {
  workflowId: 'settle_vs_ledger_daily',
  dates: SETTLE_DATES,
  total: SETTLE_DATES.length,
  planted: PLANTED.length,
  verdicts: {
    PASS: expectedAll().filter((day) => day.verdict === 'PASS').length,
    FAIL: expectedAll().filter((day) => day.verdict === 'FAIL').length,
    REVIEW: expectedAll().filter((day) => day.verdict === 'REVIEW').length
  }
};

fs.writeFileSync(
  path.join(ROOT, 'golden', 'settle_vs_ledger_daily', 'index.json'),
  `${JSON.stringify(index, null, 2)}\n`,
  'utf-8'
);

console.warn(
  `[make-golden] ${SETTLE_DATES.length}일치 정답표 생성: ${OUT} ` +
    `(PASS ${index.verdicts.PASS} · FAIL ${index.verdicts.FAIL} · REVIEW ${index.verdicts.REVIEW})`
);
