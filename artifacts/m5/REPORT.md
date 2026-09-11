# M5 검증 계층 — 검증 결과

작성 2026-09-11 · 목표 `goals/GOAL-M5.md` · 전 항목 PASS

자유 조작으로 한 번 성공한 대사 절차를 **결정적 워크플로우**로 승격하고, 오라클이
PASS / REVIEW / FAIL 을 판정하며, 20일치 골든셋에서 **오탐(잘못된 PASS) 0** 으로 회귀한다.
자유 조작은 그대로 막지 않는다(불변 조건 8).

---

## 성공 조건

| # | 조건 | 결과 | 근거 |
|---|---|---|---|
| 1 | M4 전체 회귀 | **PASS** | 아래 "회귀" 표 (단위 295 + E2E 44) |
| 2 | `npm run test:workflow` | **PASS** | 4파일 **59건** — 로드 거부·재개·규칙 단위·provenance 강등·합성·`ADAPTER_BROKEN` |
| 3 | `npm run test:ops` | **PASS** | **26건** — 매칭 3단계 골든 10건, 정규화 100회 동일, classify enum 제한 |
| 4 | 시나리오 H — 승격 UI → `settle_vs_ledger_daily.yaml` → `npm run eval` 20일치 | **PASS** | 판정 20/20 일치, **오탐 0 · 미탐 0**, 종료 코드 0, `docs/eval.md` 기록 |
| 5 | 어댑터 사다리 (network / dom+xlsx / 폴백) | **PASS** | 단위 15건 + E2E 2건. 정산 API 를 끄면 `dom` 폴백 + `source` 변경 기록 |
| 6 | Excel 파싱 골든 3건 | **PASS** | `npx vitest run tests/xlsx.test.ts` **12건** (병합·천단위·날짜 서식 포함) |
| 7 | 증거 팩 구조·규칙 버전·PII 마스킹 | **PASS** | 20 run 전부 검사 통과(러너 내장). 대표 3일치 `evidence-sample/` |
| 8 | 예약 실행 → 받은편지함 | **PASS** | cron 1분 → `result` 항목(`— PASS`, `evidencePath`) |
| 9 | 이 REPORT.md | **PASS** | — |

---

## 실행법

```powershell
npm run test:workflow        # 워크플로우·규칙·증거 팩·어댑터 단위 (59건)
npm run test:ops             # 정규화·대사·분류 (26건)
npm run eval -- settle_vs_ledger_daily   # 골든셋 20일치. 오탐 > 0 이면 종료 코드 1
npm run test:workflow-e2e    # 사다리 · 승격 UI · 예약 (Electron)
```

`npm run eval` 은 Playwright 테스트가 아니라 독립 스크립트다 — 오탐이 하나라도 있으면
종료 코드 1로 죽고 그 값이 CI 판정이 된다.

---

## 골든셋 회귀 (조건 4)

`docs/eval.md` 의 2026-09-11 표가 원본이고, 요지는 이렇다.

| 지표 | 값 |
|---|---|
| 정확도(판정 일치) | 100.0% (20/20) |
| 재현율(불일치 검출) | 100.0% (6/6) |
| REVIEW 비율 | 5.0% (1/20) |
| **오탐(잘못된 PASS)** | **0** |
| 오경보(정상인데 PASS 아님) | 0 |
| 검출 내용 불일치 | 0 |
| 증거 팩 결함 | 0 |
| 승인 요청(domain 응답) | 3 (첫 날에만) |

심긴 불일치 6건이 각각 어떤 규칙에 걸렸는가:

| 날짜 | 심은 것 | 기대 | 실제 | 걸린 오라클 |
|---|---|---|---|---|
| 2026-03-04 | 금액 -72,000 | FAIL | FAIL | `sum_equal`, `empty(recon.mismatched)` |
| 2026-03-06 | 회계 전표 누락 | FAIL | FAIL | `sum_equal`, `empty(recon.onlyLeft)`, `ratio_gte`(REVIEW) |
| 2026-03-11 | 금액 -90,000 | FAIL | FAIL | `sum_equal`, `empty(recon.mismatched)` |
| 2026-03-17 | 정산 내역 누락 | FAIL | FAIL | `sum_equal`, `empty(recon.onlyRight)` |
| 2026-03-19 | 금액 +500 (허용오차 밖) | FAIL | FAIL | `sum_equal`, `empty(recon.mismatched)` |
| 2026-03-25 | 거래번호 `0`→`O` 오타 | REVIEW | REVIEW | `ratio_gte`(severity: review) |

**오탐 0 을 규칙으로 만든 방법** — 신뢰도 조정이 아니라 판정을 낮추는 경로만 두었다.

- `Verifier` 에는 판정을 **올리는 길이 없다**. 규칙이 실패하면 심각도에 따라 FAIL/REVIEW 이고,
  통과해도 근거에 `source: 'llm'` 이 섞이면 PASS 가 REVIEW 로 내려간다(한 곳에서만 강등).
- 퍼지 매칭은 **언제나** `review: true`. 금액이 맞아도 마찬가지다.
- `normalizeId` 는 혼동 문자를 접지 않는다(`O`→`0` 치환 금지). 매칭률은 떨어지지만
  서로 다른 식별자를 같다고 말하지 않는다 — 2026-03-25 가 PASS 로 새지 않는 이유다.
- `ratio_gte` 는 분모 0 을 통과시키지 않는다("0건 중 0건 성공"이 PASS 가 되지 않게).
- 오라클이 하나도 돌지 않은 실행은 PASS 가 아니라 REVIEW 이고, `oracles` 가 빈 YAML 은
  **로드 자체가 거부**된다.
- 오라클을 5개 겹쳐 붙였다(최소 3개). 합계만 보면 서로 상쇄되는 두 오류를 놓친다.

`ratio_gte` 의 심각도를 `review` 로 둔 것이 REVIEW 비율 5%(1/20)의 전부다.
FIXED DECISIONS 대로 이 비율은 규칙을 더해 낮출 문제이고, LLM 신뢰도로 낮추지 않았다
(이 워크플로우에는 LLM 호출 지점이 아예 없다).

---

## 어댑터 사다리 (조건 5)

| 어댑터 | 계약 `source` | 실제 경로 | 확인 |
|---|---|---|---|
| `portal_settle_daily` v1 | `network` | `network` (`/api/settlements` XHR 본문) | E2E `[사다리]` 1번 |
| `portal_settle_daily` v1 | `network` | **`dom`** (API 503) | E2E `[사다리]` 2번 — `fellBack: true`, `raw.apiStatus: 503` |
| `portal_ledger_daily` v1 | `dom` | `dom` + xlsx 대조 | `note` 에 `xlsx 5건 대조` |

폴백은 조용히 일어나지 않는다. `AdapterResult.source` 가 바뀌고, 증거 팩
`extracted.json` 에 `contractSource: network / actualSource: dom / fellBack: true` 가 남는다.
화면 구조가 사라지면(머리글 없음) FAIL 이 아니라 `ADAPTER_BROKEN` 이다 —
판정할 수 없었다는 사실이 오답보다 먼저 알려져야 한다.

회계 어댑터는 화면과 파일 금액이 어긋나면 **어느 쪽도 고르지 않는다**. `sourceConflict` 를
행에 달아 돌려주고 판정은 오라클에 맡긴다. 어댑터가 "파일이 더 정확하니 파일을 쓰자" 고
혼자 정하면 두 시스템이 어긋난 사실이 사라진다.

---

## 승격 UI (조건 4 전반부)

E2E 가 실제 화면을 누른다: 스레드 패널 → `워크플로우로 승격` → 초안 편집기.

- 초안 YAML 에 최상위 7키(`id · version · inputs · steps · outputs · oracles · evidence`)가
  모두 있고 `prompt:` 는 없다. 수집 2단계 + 정규화 2단계 + 대사 1단계를 기록에서 만들어 낸다.
- 초안 id 는 수집 대상 이름에서 나온다 → `settle_vs_ledger_daily` (제목이 한국어라 id 규칙을
  통과할 수 없으므로 대조 대상 이름으로 짓는다).
- **`oracles` 는 비어 있다.** 검사를 누르면 빨간 줄로 거부된다:
  `oracles: oracles 가 비어 있는 워크플로우는 로드할 수 없습니다` → `promote-reject.png`
- 사람이 오라클 2개를 붙이면 검사 통과 → `workflows/` 에 저장 → 목록에 뜨고 실제로 돌아 PASS.

자동으로 오라클을 붙이지 않는 것이 이 계층의 핵심이다. 기록에서 짐작한 오라클은 첫 실행
결과를 그대로 "정답" 으로 굳힌다 — 그 실행이 틀렸으면 틀림이 기준이 된다.

| 화면 | 파일 |
|---|---|
| 승격 초안 편집기 | `promote-draft.png` |
| 오라클 없는 초안 거부 | `promote-reject.png` |
| 목록·판정·획득 경로 | `promote-panel.png` |
| 예약 결과가 도착한 받은편지함 | `schedule-inbox.png` |

---

## 증거 팩 (조건 7)

```
evidence/<runId>/
  steps/0001-fetch_settle-settle.png   단계 스크린샷 2장
  raw/fetch_settle.json                어댑터가 받은 원본
  raw/fetch_ledger.json
  extracted.json                       어댑터 값 + 출처·어댑터 버전·폴백 여부
  normalized.json                      정규화·대사 결과
  oracles.json                         규칙 ID·**버전**·판정·근거 값의 출처
  run.json                             워크플로우/어댑터/규칙 버전, 단계 기록, 출력 요약
```

20 run 전부를 러너가 검사한다: 필수 파일 4개, `steps/*.png` ≥ 1, `raw/*.json` ≥ 1,
모든 `outcome` 에 `rule`·`ruleVersion` ≥ 1, 그리고 PII.

**마스킹** — 어댑터 계약의 `pii` 경로(`rows[].approver`, `rows[].approverNo`)만 `***` 로 가린다.
전역 마스킹(`maskDeep`)을 쓰지 않은 것은 의도적이다: 사번 패턴(연속 7자리)이 `1250000` 같은
금액을 함께 가려 대사 근거를 지운다. 무엇이 개인정보인지는 어댑터가 선언하고 그 선언만 믿는다.
검사는 두 방향이다 — 선언 항목이 `***` 인지, 그리고 결재자 이름 5개가 파일 어디에도
남지 않았는지(`extracted`·`normalized`·`run`·`raw` 전부). run 당 `***` 30–32곳.

- 커밋된 대표 3일치: `evidence-sample/eval-2026-03-02`(PASS) · `eval-2026-03-04`(FAIL) ·
  `eval-2026-03-25`(REVIEW)
- 20일치 전체와 E2E 팩은 `.gitignore` — `npm run eval` / `npm run test:workflow-e2e` 가 다시 만든다

---

## 예약 실행 (조건 8)

`node-cron` 으로 1분 뒤 분·시를 지정해 등록하고, 실제로 뜰 때까지 기다렸다("지금 실행"
버튼으로 대체하지 않았다 — 예약의 값은 사람이 없을 때 도는 것이다).

```json
{
  "cron": "0 41 15 * * *",
  "kind": "result",
  "title": "settle_vs_ledger_daily 2026-03-02 — PASS",
  "evidencePath": "...\\artifacts\\m5\\e2e\\evidence\\settle_vs_ledger_daily-m5-eval-minute-...",
  "runCount": 1
}
```

`evidencePath/oracles.json` 이 실제로 존재하는지까지 확인한다. `ADAPTER_BROKEN` 이나 실행
오류는 `failed` 종류로 들어간다 — 조용히 빠지면 "어제 안 돌았다" 를 아무도 모른다.
종료 중에 cron 이 새 실행을 시작하지 않도록 `will-quit` 에서 예약을 먼저 세운다.

---

## 승인 게이트 (CONSTRAINTS)

워크플로우도 사람과 같은 문(ToolSurface)을 지난다. 첫 실행에서 승인 3건이 실제로 올라왔고,
러너가 사람 역할로 `domain` 범위로 답했다:

```
site:portal-h-settle@portal-h-settle
site:portal-h-ledger@portal-h-ledger
download@portal-h-ledger
```

이후 19일치는 승인 요청이 **0건**이다(도메인 승인이 기록에 남았기 때문). 허용 목록 밖의
주체에는 답하지 않고 경고만 찍는다 — 답이 없으면 그 실행은 대기 상태로 멈춘 뒤 실패한다.
자동 승인 플래그는 없고(불변 조건 4), 개발 편의로 게이트를 우회하는 경로도 만들지 않았다.
이 대사 워크플로우의 두 어댑터는 `write: false` 다.

---

## 회귀 (조건 1)

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` (`--max-warnings=0`) | PASS |
| `npm run build` | PASS |
| `npm run smoke` | 13/13 |
| `npm run test:unit` (전체) | **295/295** (16파일) |
| `npm run test:tools` | 10/10 |
| `npm run test:mcp` | 6/6 |
| `npm run test:policy` | 81/81 |
| `npm run test:persistence` | 45/45 |
| `npm run test:scenarios` (M3 D·F) | 6/6 |
| `npm run test:undo` | 4/4 |
| `npm run test:scenario-e` | 1/1 (400페이지 강제 종료 후 완주) |
| `npm run test:persistence-e2e` | 3/3 |
| `npm run test:workflow-e2e` | 5/5 |
| `npm run eval -- settle_vs_ledger_daily` | 20/20 · 오탐 0 · 종료 코드 0 |

라이선스: `license-checker --production` 126개 — MIT 98 · BSD-2 13 · ISC 12 · BSD-3 2 ·
Apache-2.0 1. 허용 목록 밖 0건. M5 에서 새 의존성을 넣지 않았다(xlsx 는 의존성 없이 직접 구현).

첫 `npm run smoke` 실행에서 `[M1] 탭 고급` 이 한 번 실패했다가 재실행에서 통과했다 —
앞선 Electron 프로세스가 단일 인스턴스 잠금을 쥐고 있던 것이고, 코드 문제는 아니었다.
(`scripts/eval.ts` 는 그래서 시작할 때 남은 `electron.exe` 를 먼저 정리한다.)

---

## 실측으로 잡은 것

### 1. 폴백 경로가 계약과 다른 모양을 내면 판정이 바뀐다

정산 API 를 끄고 돌린 첫 E2E 에서 **정상인 날(2026-03-03)이 FAIL** 로 나왔다.
원인은 화면 표에 날짜 칸이 없다는 것이었다(페이지 전체가 하루치다). `dom` 폴백 행에 `date` 가
빠지고, `normalize` 의 날짜 정규화가 빈 값에서 터져 단계가 실패 → FAIL.

경로가 달라져도 **뒤 단계가 쓰는 항목은 같아야 한다.** 어댑터가 요청 날짜를 그 자리에 채우게
고쳤다. 반대로 화면에 정말 없는 항목(`approverNo`)은 만들어 내지 않는다 — 빈 문자열로 채우면
"값이 없다" 와 "빈 값이다" 가 구별되지 않는다.

고정한 테스트 2개: 폴백 행의 필수 항목 검사, 그리고 **API 가 죽은 채로 20일치 골든셋을 돌려도
판정이 같다**(`tests/adapters.test.ts`). 두 번째가 없으면 "API 켜진 채로만 맞는 워크플로우" 를
통과시킨다.

### 2. 출력 요약에 결재자 이름이 새어 나갔다

`run.json` 의 출력 요약에는 대사 매칭(`matches[].left/right`)이 들어가고, 거기에 어댑터 행이
그대로 들어 있었다. 경로 기반 마스킹(`rows[].approver`)은 그 깊이를 알 수 없다.
연산 결과와 출력 요약은 `pii` 경로의 마지막 조각을 **이름으로 보고 트리 전체에서** 가리도록
바꿨다(`maskFieldsDeep`). 덜 가리는 쪽보다 더 가리는 쪽이 안전하다.
`tests/evidence.test.ts` 가 결재자 이름 5개를 파일 4종에서 찾아 이 회귀를 막는다.

### 3. 경로로 꺼낸 값이 출처를 잃으면 provenance 규칙이 헛돈다

오라클은 `recon.onlyLeft` 처럼 값 표의 **안쪽**을 가리킨다. 처음 구현은 `values[name]` 직접
조회라 그런 이름의 출처가 `const` 로 잡혔고, `llm` 에서 나온 목록의 한 항목을 가리킨 오라클이
PASS 강등을 건너뛸 수 있었다. 조회를 `values.ts` 한 곳에 모으고 **경로의 머리에서 출처를
물려받게** 했다(`recon.onlyLeft` → `recon` 의 출처). 오탐은 정확히 이런 틈으로 들어온다.

### 4. 정산 화면에는 표가 둘이다

XHR 로 그리는 표와 서버 렌더링 정적 표가 같은 머리글을 쓴다. 첫 파서는 두 번째 머리글 줄을
데이터 행으로 읽어 `거래번호`가 `"거래번호"` 인 행을 만들었다. 같은 머리글이 다시 나오면
건너뛴다 — 그리고 머리글을 아예 못 찾으면 빈 배열이 아니라 `null` 을 돌려준다.
"데이터가 0건" 과 "화면이 바뀜" 을 구별해야 하고, 0건은 오라클을 통과해 버린다.

### 5. 규칙에도 버전이 필요하다

증거 팩이 "어느 판단 기준으로 낸 판정인가" 를 말할 수 있어야 한다. `Rule` 에 `version` 을
넣고 `OracleOutcome`·`oracles.json`·`run.json` 에 실었다. 규칙을 고치면 같은 데이터가 다른
판정을 낼 수 있으므로, 과거 판정을 되짚을 때 이 숫자가 필요하다.

---

## 남은 것 (M5 범위 밖)

- **M4b 로컬 LLM**: `artifacts/m4b/REPORT.md` 는 아직 없다(지정 모델 `gemma3:27b` 부재,
  `qwen2.5:7b-instruct` 대체 가능성은 `docs/eval.md` 2026-09-10 항목에 실측으로 기록).
  M5 는 이 선행조건에 의존하지 않는다 — `settle_vs_ledger_daily` 에는 LLM 호출 지점이 없고,
  `classify` 의 LLM 폴백은 주입식이라 없으면 규칙만 쓴다. provenance 강등은 단위 테스트로
  검증했다(`llm` 출처 값으로 `sum_equal` PASS 시도 → REVIEW).
- **레코더**(시연 → 자동 컴파일): OUT OF SCOPE, M7 후보.
- **M4c 로그인·임포트**: 정보보호 협의 대기.
- `git push origin --delete master`: 원격 기본 브랜치는 `main` 으로 바꿨고 남은 `master`
  삭제는 사용자 손에 남겨 두었다.
