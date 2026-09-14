# GOAL.md — Helm(가칭) M4 지속성 + 내장 에이전트(로컬 LLM)

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`, 시나리오 문서(A·B·E·G)와 함께 읽는다. 범위가 크므로 **두 세션(M4a 지속성, M4b 에이전트)** 으로 나누어 실행해도 된다 — 각 세션은 아래 해당 절만 목표로 삼는다.

---

## PRECONDITIONS

- `artifacts/m3/REPORT.md` 전부 PASS
- **M4b 전용**: 개발 PC에 Ollama가 설치되어 `http://localhost:11434/v1/chat/completions`이 응답하고 `qwen2.5:7b-instruct`(FIXED DECISIONS 의 2026-09-12 대체 결정)가 pull 되어 있음. 없으면 M4b는 STOP. 개발 초기 검증용으로 `ANTHROPIC_API_KEY`가 있으면 Anthropic 어댑터 경로도 함께 검증(선택)
- 모의 포털에 E(위키형: 지연 로딩 트리 400페이지, 깨진 링크 30개, 구 도메인 링크 20개)와 G(메신저형: 가상 스크롤 메시지, 스레드 접힘, `/messages` JSON)를 추가한다

## OBJECTIVE

**M4a**: 중단이 정상인 장시간 작업을 위해 스레드·이름 붙인 세션·체크포인트·받은편지함·메모·에이전트 북마크·페이지 변경 이력을 구현하고, 앱을 종료해도 이어 말할 수 있게 한다.
**M4b**: 사내 로컬 LLM으로 도는 내장 에이전트가 ToolSurface만 써서 사이드바 지시를 수행하고, MacroCache로 반복 작업의 LLM 호출을 줄인다.

## IN SCOPE — M4a 지속성

- `SessionStore`: Named Sessions `persist:helm:<name>`, safeStorage 메타(로그인 경로·시각), 탭에 SessionBadge, `session_list/session_use`
- `ThreadStore`(SQLite better-sqlite3): 메시지·도구 호출·상태(`running|paused|waiting_approval|waiting_login|done|failed`), 재시작 시 `running→paused`
- `CheckpointStore`: 자동(10단계·페이지 전환·ask_user 직전)+수동, 내용=AI 탭(URL·세션·스크롤)·ResultsTable·스레드 index·메모 버전, `checkpoint_save/list/restore`
- `Inbox`: `{kind: result|approval|login_required|done|failed, threadId, title, summary, evidencePath}`, 미읽음 배지, M3의 승인 임시 목록을 여기로 통합, `inbox_post`
- `NoteStore`: `thread:<id>` / `site:<host>`, 자격증명·PII 패턴 저장 거부, `note_read/note_append`
- `BookmarkMeta`: `{intent, expectedContent, keyFields[], agentHints}` 편집 UI + `bookmark_list/bookmark_get`
- `ChangeTracker`: 북마크 URL 방문 시 Reader 본문 스냅샷(200KB 상한), `page_history/page_diff`(단어 diff), 이력 뷰
- UndoManager를 runId → threadId 스택으로 승격
- 장시간 모드: 스텝 상한 2,000 + 체크포인트 필수, 재개 로직
- 사이드바: ThreadList/ThreadView/InboxView/NotesPanel, ResultsTable(출처 URL·단계 번호, CSV/MD/JSON 내보내기)

## IN SCOPE — M4b 내장 에이전트

- `LLMClient`: OpenAI 호환 `/v1/chat/completions` + tools + `response_format: json_schema`, 설정 `{provider, baseUrl, apiKey, model}`, Anthropic 어댑터, 8k 토큰 상한, 모든 호출 AuditLog
- `Agent`: ToolSurface만 사용(CDP 직접 호출 lint 금지). 시작 시 `session_use → bookmark_list → note_read(site)`. 읽기 우선순위 프롬프트 고정(read_network_requests → get_page_text → read_page → screenshot). `<page_content>` 격리. 루프 상한 60(장시간 2,000). 동일 도구+인자 3회 → ask_user. 완료 시 `inbox_post(done)` + site 메모 제안(사람 확인 후 저장)
- `find` 2차(LLM 선택) 추가
- `MacroCache`: 같은 사이트·같은 단계 2회 성공 시 캐시, 실패 시 무효화·LLM 복구
- `Extract`: 표/스키마 추출 → ResultsTable
- Composer(사이드바 입력칸): 가벼운 요청(현재 페이지 질문·요약)과 작업 지시 동일 입력

## OUT OF SCOPE

LoginBroker·임포트 마법사(M5로 이동 — 아래 참고), 검증 계층(워크플로우·오라클), 서명·배포, 실제 포털.
(참고: 로드맵상 LoginBroker·임포트는 M0에 있었으나 자율 실행 순서에서는 사람 협의(정보보호)가 필요해 M5 앞의 별도 세션 **GOAL-M4c**로 분리한다.)

## FIXED DECISIONS

- 저장은 SQLite(better-sqlite3) 단일 파일 + 대용량(본문·스크린샷)은 파일. 스키마 마이그레이션은 `migrations/` 번호 파일
- 로컬 모델 기본 `qwen2.5:7b-instruct`. 툴 호출 미지원 모델은 기동 시 경고
  - **2026-09-12 사람 결정 — 모델 대체**: 원래 지정은 `qwen3.6:27b`(폴백 `qwen3-coder:30b`)였으나
    개발 PC(RAM 31GB · RTX 5060 Laptop)에서 27B Q4 는 VRAM 을 넘겨 CPU 오프로드가 되고,
    두 모델 모두 확보되지 않았다. `qwen2.5:7b-instruct` 로 대체한다 — 능력 4종(도구 호출 ·
    다단계 · 구조화 출력 · 주입 저항)이 `npm run probe:llm` 에서 PASS 했다(`docs/eval.md`).
    성공 판정 기준(3회 중 2회)은 낮추지 않는다. 7B 로 기준에 못 미치면 STOP CONDITIONS 대로
    멈추고 `eval.md` 에 실패 패턴을 적는다
- M4b 성공 판정은 **3회 실행 중 2회 성공**(LLM 비결정성 감안). 5회 중 3회 미만이면 프롬프트·MacroCache를 개선하되, 도구 표면을 우회하는 방식으로 성공률을 올리지 않는다
- **2026-09-14 사람 결정 — 범위를 나눈다(선택지 2)**: `docs/eval.md` 2026-09-13 이 남긴 두 선택지 중
  "7B 로 가되 범위를 나눈다" 를 택했다. 한 화면 수집·요약·질의는 에이전트가, **여러 화면 순회는
  M5 워크플로우**(사람이 승격한 결정적 절차)가 맡는다. 그에 맞춰 성공 조건 2·3을 아래와 같이 다시 썼다.
  - 원안(개정 전)은 이랬다: 2 = "시나리오 A 3회 중 2회 성공(행 수 200·중복 0·날짜 형식), 2회차 LLM 호출 50% 이상 감소",
    3 = "시나리오 B 3회 중 2회 성공, DOM 파싱 스텝 0". 기록으로 남겨 둔다 — 무엇을 옮겼는지 보이지 않으면
    기준을 낮춘 것과 구별되지 않는다
  - **기준을 낮추는 것이 아니라 경계를 옮기는 것이다.** 개정안은 "한 화면은 온전히 해냈는가" 를 새로 요구한다
    (중복 0 · 형식 오류 0 · 화면 소진). 그리고 경계에서 멈출 때 **실패가 아니라 `handoff`** 로 끝나
    사람에게 다음 수단(워크플로우 승격)이 도달해야 한다. 헛돌다 죽는 것은 여전히 실패다
  - 200행·137행 **전량 수집은 M5 가 이미 결정적으로 해낸다**(`npm run eval`, 오탐 0). 같은 일을 두 계층이
    각자 하려다 둘 다 어설퍼지는 것을 피한다
- 메모·북마크 메타 저장 전 PII·자격증명 패턴 검사(M3 규칙 재사용)

## CONSTRAINTS

CLAUDE.md 보안 기본값. LLM 엔드포인트는 설정된 하나만. 자격증명·쿠키·토큰을 스레드·체크포인트·메모·북마크에 쓰지 않는다. `LLMClient` import는 `Extractor`·`ops/classify|normalize`·`recorder/Compiler`·`Agent`·`find` 2차 외에는 lint 에러.

## SUCCESS CRITERIA — M4a (전부 통과)

1. 회귀: `typecheck && lint && build && smoke && test:tools && test:mcp && test:policy`
2. `npm run test:persistence` — 각 스토어 CRUD, 마이그레이션, 재시작 시 `running→paused`, 체크포인트 저장/복원 라운드트립, Inbox 미읽음 카운트, NoteStore PII 거부, ChangeTracker diff 골든 3건
3. **시나리오 E**(MCP 스크립트, LLM 없음): 400페이지 순회 중 200페이지 지점에서 **앱 강제 종료** → 재실행 → 스레드 `paused` → "이어서" → 마지막 체크포인트에서 재개 → 완주. 결함 목록 50건(30+20) 정확, 방문 페이지 수 = 400, 중복 방문 0, 탭 누수 0(종료 시 AI 탭 수 ≤ 3)
4. Named Session: 두 세션(`itsm`, `gw`)에 각기 다른 쿠키 → 재시작 → 각 파티션 쿠키 유지·교차 없음. 탭 배지 표시(스크린샷)
5. 스레드 이어 말하기: 스레드 생성 → 앱 종료 → 재실행 → 같은 스레드에 메시지 추가 → 히스토리 연속
6. ResultsTable CSV/MD/JSON 내보내기 파일 내용 검증
7. `artifacts/m4a/REPORT.md`

## SUCCESS CRITERIA — M4b (전부 통과)

1. M4a 회귀 + `test:agent`(프롬프트 격리 테스트: `<page_content>` 안의 지시문이 도구 호출로 이어지지 않음 — 인젝션 fixture 10건 전부 무시)
2. **시나리오 A를 Ollama로 — 한 화면은 온전히, 규모에서는 넘긴다** (2026-09-14 개정):
   3회 중 2회가 아래를 **전부** 만족한다.
   - **수집한 행이 정확하다**: 중복 0(고유 id 수 = 행 수), 날짜 형식 오류 0.
     한 화면을 어설프게 뽑고 넘어가는 것을 막는 조건이다
   - **서로 다른 화면을 둘 이상 돌았다**: 순회 자체는 되어야 한다
   - 목표(200행)에 못 미치면 **`handoff`(`needs_workflow`)로 끝난다**. 헛돌다 `incomplete`·
     `no_progress` 로 죽으면 실패다
   - 넘길 때 **사람에게 다음 수단이 도달한다**: 받은편지함에 부분 결과와 승격 안내,
     ResultsTable 에 모은 행 보존
   - MacroCache: 2회차에 캐시가 실제로 단계를 대신한다(`macroHits > 0`).
     원안의 "LLM 호출 50% 감소" 는 뺀다 — 실행이 예산 벽에서 **서로 다른 지점에 멈추므로**
     회차 간 호출 수가 비교 가능한 양이 아니다(실측 18/22/15, 멈춘 화면 4~4.5개).
     대신 회차별 호출 수·캐시 적중을 `eval.md` 에 그대로 남긴다
   - **200행 전량 수집은 M5 워크플로우의 몫이다** — `npm run eval` 이 이미 결정적으로,
     오탐 0 으로 해낸다. 같은 일을 두 계층이 각자 하려다 둘 다 어설퍼지는 것을 피한다
3. **시나리오 B를 Ollama로 — 구조화된 응답을 표의 출처로** (2026-09-14 개정):
   XHR 응답에서 **첫 응답 분량(50건)을 정확히** 뽑는다(3회 중 2회, 중복 0).
   137건 전량은 요구하지 않는다 — 그것도 여러 화면(스크롤 페이지) 몫이다.
   `read_network_requests` 를 실제로 쓰고, 같은 화면을 DOM 으로 다시 긁지 않는다.
   - 이 조건은 **경계로 바꿔 쓸 수 없다.** B 가 못 하는 것은 순회가 아니라 **한 화면**이고,
     한 화면을 못 한 것을 넘김으로 부르면 실패를 위장하는 것이다
4. **시나리오 G**: 별도 탭 협상(ask_user) → 스크롤 누적 → 결정사항 추출 → 주간보고 초안(근거 링크 100% 유효). 진행 중 smoke가 키 입력 주입 → paused → 이어서 → 중복 수집 0
5. 사이드패널 가벼운 요청: `app://fixtures/article.html`에서 "요약해줘" → 응답에 기대 키워드 3개 포함
6. 완료 시 Inbox `done` 항목 + site 메모 제안 다이얼로그 표시(자동 저장 아님)
7. `docs/eval.md`에 모델·시나리오별 성공률·평균 스텝·LLM 호출 수 표 기록
8. `artifacts/m4b/REPORT.md`

## AUTONOMY LOOP

M4a: 스토어 → 사이드바 → 시나리오 E → 세션/스레드 재시작 테스트. M4b: LLMClient → Agent → MacroCache → 시나리오 A·B → G → eval.md. 각 단계 테스트 통과 후 다음. `[M4a]`/`[M4b]` 커밋.

## STOP CONDITIONS

- PRECONDITIONS 미충족(특히 M4b의 Ollama 미기동) / 같은 근본 원인 5회 실패 / OUT OF SCOPE 결정 필요
- M4b에서 5회 중 3회 미만 성공이 프롬프트·캐시 개선 3라운드 후에도 지속 → STOP, `eval.md`에 실패 패턴 기록(모델 교체는 사람 결정)

## DONE

M4a: 앱을 죽여도 스레드·체크포인트에서 이어가고, 받은편지함에 결과가 모이고, 세션이 이름별로 유지된다.
M4b(2026-09-14 개정): 사내 GPU 없이 개발 PC의 Ollama만으로 **한 화면 수집이 정확하고**, 여러 화면이 필요한 일은 스스로 알아채 워크플로우로 넘긴다. 넘긴 자리에 부분 결과와 다음 수단이 사람에게 남는다. 전량 수집은 M5 워크플로우가 맡는다.
