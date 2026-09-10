# GOAL.md — Helm(가칭) M5 검증 계층 (워크플로우 승격 · 오라클 · 골든셋)

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`, 기획서 4.7장·v0.2 6장(워크플로우 YAML 예시), 시나리오 H와 함께 읽는다.

---

## PRECONDITIONS

- `artifacts/m4a/REPORT.md`, `artifacts/m4b/REPORT.md` 전부 PASS
- 모의 포털 H 2종을 이 세션에서 만든다: 정산 포털형(날짜 입력 → 조회 → `/api/settlements?date=` JSON 그리드), 회계 시스템형(날짜 입력 → 조회 → 서버 렌더링 테이블 + "Excel 다운로드" xlsx). 20일치 fixture 데이터를 생성하되 그중 6일치에 의도된 불일치(금액 차이 3건, 한쪽 누락 2건, 식별자 오타 1건)를 심고 정답표를 `golden/settle_vs_ledger_daily/expected/`에 둔다

## OBJECTIVE

자유 조작으로 성공한 절차를 결정적 워크플로우로 승격하고, 오라클이 PASS/FAIL/REVIEW를 판정하며, 골든셋 회귀에서 **오탐(잘못된 PASS) 0**을 보장하는 선택 계층을 만든다. 자유 조작은 막지 않는다.

## IN SCOPE

- `workflow/Engine.ts`: YAML(`id, version, inputs, steps, outputs, oracles, evidence` 필수) 로드(zod), `tool:`(ToolSurface/어댑터) 또는 `op:`(내장) step, 상태머신·재시도·재개, 증거 수집. `prompt:` 키는 존재하지 않음 — 로드 시 거부
- `workflow/ops/`: `reconcile`(키 정규화 → 정확·허용오차·퍼지 매칭), `normalize`(날짜·금액·식별자, 결정적), `classify`(enum, 규칙 우선·LLM 폴백), `lookup`
- `workflow/Verifier.ts` + `rules/`: `sum_equal`, `ratio_gte`, `empty`, `required_fields`, `format`, `cross_equal`, `date_order`. 판정 합성 = 최악값(FAIL > REVIEW > PASS), `ADAPTER_BROKEN` 우선
- **provenance 규칙**: `source: 'llm'`로 얻은 값이 PASS 근거에 쓰이면 자동 REVIEW 강등. LLM은 PASS를 만들 수 없다
- 어댑터 계약(`ToolContract` — `name, input, output, write, source, pii`)과 구조화 우선 사다리(`api → network → dom → llm`) — 이번엔 어댑터 2개를 손으로 작성(정산·회계)
- **승격 UI**: 스레드(M4a)의 도구 호출 기록에서 "워크플로우로 승격" → 단계·입출력 스키마 초안 YAML 생성 → 사람이 오라클 추가 → 저장(`workflows/`)
- 골든셋 러너 `npm run eval -- <workflowId>`: `golden/<id>/` 실행 → 정확도·재현율·REVIEW 비율·**오탐 수** → `docs/eval.md` append. 오탐 > 0이면 종료 코드 1
- 증거 팩 `evidence/<runId>/`: `steps/*.png`, `raw/*.json`, `extracted.json`, `normalized.json`, `oracles.json`, `run.json`. PII 마스킹(어댑터 `pii` 경로)
- Excel 다운로드 파싱(exceljs 또는 SheetJS 커뮤니티판 — 라이선스 확인)
- Scheduler: 워크플로우 예약 실행 → 결과 Inbox

## OUT OF SCOPE

레코더(시연 → 자동 컴파일)는 M5에서 제외(후속 M7 후보), 서명·배포, 실제 포털, 심사 전처리·문서 QC 도메인(대사 1개만).

## FIXED DECISIONS

- **오탐 0은 타협하지 않는다.** REVIEW 비율이 높으면 규칙을 추가해 낮추고, LLM 신뢰도로 낮추지 않는다
- 워크플로우 버전은 정수 단조 증가, 실행 기록에 워크플로우·어댑터 버전 동봉
- `oracles`가 빈 워크플로우는 로드 거부
- 대상 사이트 DOM 변경으로 어댑터가 깨지면 FAIL이 아니라 `ADAPTER_BROKEN`으로 구분

## CONSTRAINTS

CLAUDE.md 보안 기본값. 워크플로우 `write: true` 도구는 M3 Policy 승인 대상(자동 승인 없음). LLM 호출 지점 lint 규칙 유지(`Extractor`, `ops/classify|normalize`만 추가 허용).

## SUCCESS CRITERIA (전부 통과)

1. 회귀: M4 전체 테스트
2. `npm run test:workflow`: YAML 로드 검증(필수 키 누락·`prompt:` 키·빈 oracles 거부), 상태머신 재개, 각 rule 단위 테스트(경계값 포함), provenance 강등 테스트(llm 출처 값으로 sum_equal PASS 시도 → REVIEW), 판정 합성 최악값, `ADAPTER_BROKEN` 우선
3. `npm run test:ops`: reconcile 매칭 3단계(정확·허용오차·퍼지) 골든 10건, normalize 결정성(같은 입력 100회 동일 출력), classify enum 제한(허용 외 출력 → REVIEW)
4. **시나리오 H**: 승격 UI로 정산·회계 스레드 기록 → `settle_vs_ledger_daily.yaml` 생성(기획서 v0.2 6장 형식과 동형) → 오라클 3개 부착 → `npm run eval -- settle_vs_ledger_daily` 20일치:
   - 불일치가 심긴 6일치는 전부 FAIL 또는 REVIEW(정답표와 일치), 정상 14일치는 PASS
   - **오탐(잘못된 PASS) 0**, 미탐(불일치인데 PASS) 0
   - `docs/eval.md`에 표 기록, 종료 코드 0
5. 어댑터 사다리 테스트: 정산 어댑터는 `network`로 획득(`source:'network'` 기록), 회계 어댑터는 `dom`(+xlsx). 정산 API를 fixture에서 끄면 `dom` 폴백 동작·`source` 변경 기록
6. Excel 파싱 골든 3건(병합 셀·천단위 콤마·날짜 서식)
7. 증거 팩 검사: 20일치 run마다 폴더 구조·`oracles.json` 규칙 ID·버전 존재, PII 마스킹 필드 `***`
8. 예약 실행: 1분 후 cron → 실행 → Inbox `result` 항목(verdict·evidencePath 포함)
9. `artifacts/m5/REPORT.md`

## AUTONOMY LOOP

fixture(H 포털·20일치·정답표) → Engine/ops/rules → 어댑터 2개 → 승격 UI → eval 러너 → 예약. 오탐 발견 시 규칙·정규화 수정(LLM 신뢰도 조정 금지). `[M5]` 커밋.

## STOP CONDITIONS

- PRECONDITIONS 미충족 / 같은 근본 원인 5회 실패 / OUT OF SCOPE 결정 필요
- 오탐이 규칙 개선 5라운드 후에도 0이 되지 않으면 STOP — "LLM 추출 비중이 큰 도메인"일 가능성을 REPORT에 기록(도메인 교체는 사람 결정)
- xlsx 라이브러리가 라이선스 허용 목록 밖이면 STOP

## DONE

`artifacts/m5/REPORT.md` 전부 PASS. 자유 조작으로 한 대사 절차가 YAML 워크플로우로 승격되어 20일치 골든셋에서 오탐 0으로 판정되고, 예약 실행 결과가 증거 팩과 함께 받은편지함에 도착한다.
