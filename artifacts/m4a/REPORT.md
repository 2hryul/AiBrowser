# M4a 지속성 검증 리포트 — 스레드 · 세션 · 체크포인트 · 받은편지함 · 메모 · 북마크 메타 · 변경 이력

- 대상: `goals/GOAL-M4.md` 의 **M4a** 절 (범위가 커서 두 세션으로 나누는 것을 목표 파일이 허용한다)
- 환경: Windows 11 (26200), Electron 44.3.0 (Node 24.20 / Chromium 142), better-sqlite3 13
- 실행 일자: 2026-09-10
- 결과: **M4a SUCCESS CRITERIA 7건 전부 PASS**
- **M4b 는 STOP** — PRECONDITIONS 미충족(사유는 맨 아래)

---

## 실행 방법

```powershell
npm install
npm run fixtures
npm run typecheck
npm run lint
npm run build
npm run test:unit             # 181건 (정책 81 · 지속성 35 · 포털 10 · lint규칙 3 · 그 외)
npm run test:persistence      # 지속성 스토어 + 포털 fixture 45건
npm run smoke                 # M0·M1 회귀 13건
npm run test:tools            # 도구 단위 10건
npm run test:mcp              # M2 시나리오 A·B·C 6건
npm run test:policy           # M3 정책 81건
npm run test:scenarios        # M3 시나리오 D·F + 화면 6건
npm run test:undo             # M3 되돌리기 4건
npm run test:scenario-e       # M4a 시나리오 E (강제 종료 후 재개) 1건
npm run test:persistence-e2e  # M4a 세션·스레드·내보내기 3건
```

작업(스레드) 화면은 `Ctrl+Shift+K`, 받은편지함은 `Ctrl+Shift+M`. 결과표·메모·세션·변경 이력은
툴바 버튼(📊 📝 👤 🔀)으로 연다.

---

## SUCCESS CRITERIA 판정 (M4a)

### 1. 회귀 `typecheck && lint && build && smoke && test:tools && test:mcp && test:policy` — PASS

| 항목 | 결과 |
|---|---|
| `typecheck` | 통과 |
| `lint` | 통과 (`--max-warnings=0`, 커스텀 규칙 2종 포함) |
| `build` | 통과 (main 317KB · preload 15.6KB · renderer 362KB) |
| `smoke` | 13/13 |
| `test:tools` | 10/10 |
| `test:mcp` | 6/6 |
| `test:policy` | 81/81 (M3 79건 + 알려진 오탐 2건 추가) |
| (추가) `test:scenarios` · `test:undo` | 6/6 · 4/4 — M3 시나리오도 함께 재확인 |

### 2. `npm run test:persistence` — PASS (45건)

- **마이그레이션**: `user_version` = 마이그레이션 수, 표 11개 생성, 재연결 시 버전 불변·데이터 유지
- **ThreadStore**: CRUD, 메시지 seq, 특정 지점 이후 읽기, 스텝 상한(60/2000), 삭제 시 CASCADE
- **재시작 복구**: `running`·`waiting_approval` → `paused` 2건, `done` 은 그대로
- **CheckpointStore**: 탭(주소·세션·스크롤)·결과·메모 버전·커서 **라운드트립**, 스레드별 격리, CASCADE
- **Inbox**: 미읽음 카운트가 게시/읽음/전체읽음을 따라감, 재시작 후 유지, 보존 정리(안 읽은 항목은 남김)
- **NoteStore**: 버전 이력·되돌리기, 범위 형식 검사, 자격증명 6종 거부 / 값 없는 언급 통과,
  PII 3종 거부, site 2KB 상한(문자 경계 유지)
- **BookmarkMeta**: 부분 갱신, 질의 검색, 자격증명·PII 거부, 북마크 삭제 시 CASCADE
- **ChangeTracker**: 낱말 diff **골든 3건**(추가/삭제/변경) + 무변경 + 공백 정규화, 스냅샷 중복 방지,
  200KB 상한, 보존 정리(주소별 최신 1건 유지)
- **SessionStore**: 기본 `persist:helm` / 이름 있는 세션 `persist:helm:<name>`, 이름 규칙 6종 거부,
  safeStorage 암호화 저장·복원, 암호화 불가 환경 폴백 표시, 기본 세션 삭제 불가
- **포털 fixture 불변식 10건**: E 400문서·결함 50건(겹침 1)·404 링크, G 240메시지·결정 26건·커서 페이징

### 3. 시나리오 E — PASS

`npm run test:scenario-e`. 400페이지 순회 중 **200페이지에서 SIGKILL** → 재실행 → 재개 → 완주.

| 판정 항목 | 실측 |
|---|---|
| 1차 실행 방문 | 200 (강제 종료 지점) |
| 강제 종료 직전 상태 | `running`, 체크포인트 50개, 커서 `nextIndex: 200`, AI 탭 1개 |
| 재시작 후 상태 | **`paused`** (자동 복구) |
| 재개 지점 | 체크포인트 239 · 커서 200 · 복원된 결함 25건 |
| 복원된 탭 | 1개, `app://portal-e/page?id=200` (소유권 `ai` 유지) |
| 총 방문 | **400** |
| 중복 방문 | **0** |
| 결함 | **50건** (깨진 링크 30 + 구 도메인 20) — fixture 기대값과 문자열 대조 |
| 종료 시 AI 탭 | **1개** (상한 3) |
| 스레드 메시지 | 902건 (도구 호출 기록) |

강제 종료는 `app.close()` 가 아니라 프로세스 트리 `taskkill /F /T` + `SIGKILL` 이다 —
정상 종료 훅이 돌지 않아야 "전원이 꺼진 상황" 이 된다.

- 산출물: `scenario-e-summary.json`

### 4. Named Session — PASS

| 판정 항목 | 실측 |
|---|---|
| 파티션 | `itsm` → `persist:helm:itsm`, `gw` → `persist:helm:gw`, `default` → `persist:helm` |
| 쿠키(재시작 후) | itsm `helm_sid=itsm-1234`, gw `helm_sid=gw-5678` |
| 교차 접근 | **0** — 상대 주소·기본 세션 모두 빈 목록 |
| 로그인 경로 복원 | itsm `inapp`, gw `oauth_modal` (safeStorage 메타에서) |
| 탭 배지 | `itsm`, `gw` 2종 (기본 세션 탭에는 배지 없음) |

기본 세션의 파티션 이름은 `persist:helm` 을 그대로 지켰다. `persist:helm:default` 로 바꾸면
M0 부터 쌓인 로그인이 전부 날아간다.

- 화면: `sessions-and-badges.png`

### 5. 스레드 이어 말하기 — PASS

메시지 2건 → **정상 종료** → 재실행 → 상태 `paused` 로 복구 → 사이드바 입력칸으로 한 마디 추가.
메시지 번호 `1·2·3` 으로 이어지고 앞 대화가 그대로 남았다(`재시작 후에도 이어집니까?` 가 seq 3).

- 화면: `threads-continued.png`

### 6. ResultsTable 내보내기 — PASS

쉼표·인용부호·줄바꿈·파이프가 든 값을 일부러 섞어 파일을 직접 읽어 검증했다.

| 형식 | 검증 내용 | 크기 |
|---|---|---|
| CSV | 헤더 `pageId,kind,step,url,note`, 4줄(헤더+3행), RFC 4180 인용(`""` 이중화), CRLF | 202B |
| Markdown | 헤더·구분선·3행, 파이프 `\|` 이스케이프, 줄바꿈을 공백으로 눕힘(한 줄 유지) | 275B |
| JSON | 3행, 원본 값 그대로(줄바꿈 포함) | 382B |

화면에서도 3행·5열이 그려지는 것을 확인했다.

- 화면: `results-table.png`

### 7. 이 리포트 — PASS

---

## 추가로 구현·확인한 것 (IN SCOPE 항목)

- **UndoManager 를 threadId 스택으로 승격**: `callTool` 이 `ctx.threadId` 로 스택을 나누고,
  MCP 연결이 만든 항목도 사람의 UndoPanel 에 보인다(처음 열 때 가장 최근에 움직인 스택을 보여준다).
- **장시간 모드**: 스레드에 `stepLimit`(기본 60 / 장시간 2,000)이 있고 `step()` 이 초과를 알린다.
  자동 체크포인트는 10스텝마다·페이지 전환마다 걸리고 **마지막 커서를 실어 나른다** —
  커서 없이 덮이면 "최근 체크포인트에서 재개" 가 처음부터 다시 하기가 된다.
- **사이드바 6종**: 작업(스레드)·받은편지함·메모·결과표·세션·변경 이력. 봉인·거부·coarse diff 처럼
  "안 되는 이유" 는 모두 화면에 문장으로 남긴다.
- **북마크 메타 편집 UI**: 북마크 행의 "AI 힌트" 를 펼쳐 의도·기대 콘텐츠·핵심 필드·요령을 적는다.
  이 값은 프롬프트에 실리므로 저장 전에 자격증명·PII 를 거부한다.
- **ChangeTracker 연결**: 북마크된 주소를 방문하면 Reader 본문 스냅샷이 쌓인다(모든 방문을 남기면
  DB 가 방문 기록의 사본이 된다).

---

## 이번 세션에 찾은 실제 결함·한계 (전부 수정 또는 기록)

1. **바이트로 자르면 UTF-8 문자가 깨진다.** 200KB 스냅샷 상한을 바이트로 자르자 마지막 문자가
   반토막 나 대체문자(U+FFFD, 3바이트)로 바뀌어 **상한을 넘겼다**(204,801 > 204,800).
   → `text.ts` 에 문자 경계까지 물러나는 자르기를 만들고 앞/뒤 두 방향 모두 적용, 테스트로 고정.
2. **접근성 트리에 노드 상한이 있다.** 위키 목차 20장을 모두 펼치니 링크가 400개로 불어나
   `read_page` 상한에 걸려 **9장 이후 버튼이 잘려 나갔다**. → 펼친 뒤 바로 접고, 문서 id 는
   화면이 아니라 `/tree` 응답에서 읽는다(fixture 주석이 가리키던 정석 경로).
3. **주 프로세스만 죽이면 단일 인스턴스 잠금이 남는다.** SIGKILL 직후 재실행이 exitCode 0 으로
   즉시 종료됐다(자식 프로세스가 잠금을 붙들고 있었다). → 프로세스 **트리**를 죽이고 포트 해제를
   확인한 뒤 재실행한다.
4. **MCP 연결마다 새 스레드가 생기면 이어가기가 불가능하다.** → `X-Helm-Thread` 헤더로 클라이언트가
   스레드를 지정할 수 있게 했다(형식 `[\w.-]{1,64}` 로 제한 — DB 키이자 경로 조각이다).
5. **로딩 중 페이지의 `executeJavaScript` 가 응답하지 않으면 체크포인트가 멈춘다.**
   400페이지를 도는 동안 실측했다. → 스크롤 위치 읽기에 300ms 시간 제한.
6. **쓰기 키워드 판정의 오탐** — "결재 규정" 처럼 낱말이 **명사로** 쓰인 목차 버튼도 쓰기 클릭으로
   본다(승인 대기 → MCP 60초 타임아웃으로 드러났다). 문구만으로 명사와 동사를 가릴 방법이 없어
   M4a 에서는 규칙을 건드리지 않았다. 대신 두 가지를 했다:
   - 포털 E 장 제목에서 쓰기 키워드를 뺐다(이 fixture 는 지연 로딩·분량·결함을 보는 곳이다)
   - `tests/policy.test.ts` 의 **"알려진 오탐"** 2건으로 현재 동작을 고정했다 — 나중에 규칙을
     정교하게 만들면 이 테스트가 먼저 깨져 "의도한 변경" 임을 확인하게 된다
7. **닫은 탭을 복구하면 세션이 기본으로 돌아갔다** → 스냅샷에 `sessionName` 을 담아 복원.

---

## 문서화한 편차·설계 선택

1. **마이그레이션은 `migrations/` 의 번호 붙은 `.ts` 파일**이다(`001-browser.ts`, `002-persistence.ts`).
   `.sql` 파일로 두려면 번들러에 `?raw` 임포트를 물려야 하는데, 이 프로젝트는 main 을 단일 청크로
   묶기 때문에 파일 로딩 경로가 하나 더 생긴다(이번 세션에 지연 `require` 로 같은 함정을 겪었다).
   "번호 파일 · append 만" 이라는 결정의 목적은 그대로 지킨다.
2. **기본 세션의 파티션은 `persist:helm`** 이고 이름 있는 세션만 접미사를 붙인다(성공 조건 4 참고).
3. **세션을 바꿔도 이미 열린 탭은 그대로다.** 보고 있는 화면의 계정이 뒤에서 바뀌는 것이 더 위험하다.
4. **결과표는 DB 에 매 행을 쓰지 않는다.** 수집 중에는 초당 여러 번 바뀌고, 남아야 하는 시점은
   체크포인트뿐이다. 그래서 메모리에 들고 체크포인트에 함께 저장한다.
5. **스레드에는 도구 결과 전문을 넣지 않는다.** 페이지 본문을 그대로 넣으면 400페이지 순회로 DB 가
   수십 MB 로 불어난다. 문자열 200자·배열 5개로 요약하고, 전문은 감사 로그(M3)에 있다.
6. **모의 포털 G(메신저)는 추가했지만 시나리오 G 는 M4b 다.** fixture 불변식(240메시지·결정 26건·
   커서 페이징·모든 고정 링크 200)은 단위 테스트로 고정해 두었다 — M4b 가 바로 쓸 수 있다.
7. **`page_diff` 는 차이가 크면 정렬을 포기하고 `coarse: true` 로 알린다.** 낱말 LCS 는
   1,000,000 셀(앞뒤 공통 부분 제거 후) 상한을 둔다. 정확해 보이는 거짓 diff 보다 낫다.

---

## M4b STOP — PRECONDITIONS 미충족

GOAL-M4 는 M4b(내장 에이전트)의 선행 조건으로 다음을 요구한다.

> 개발 PC 에 Ollama 가 설치되어 `http://localhost:11434/v1/chat/completions` 이 응답하고
> **`qwen3.6:27b`(또는 `qwen3-coder:30b`)** 가 pull 되어 있음. 없으면 M4b 는 STOP.

**실측 (2026-09-10):**

- Ollama 는 살아 있다 — `GET /api/tags` 200 응답
- 설치된 모델: `qwen2.5:7b-instruct` (7.6B), `gemma4:e2b` (5.1B), `meeting-ko:latest` (7.6B)
- **`qwen3.6:27b` · `qwen3-coder:30b` 둘 다 없음**
- `ANTHROPIC_API_KEY` 없음 → 선택 경로인 Anthropic 어댑터 검증도 불가

STOP CONDITIONS 그대로 M4b 는 시작하지 않았다.

**추가 실측 (같은 날, 사용자 요청):** "7.6B 로 대체해서 테스트가 되는가" 를 `npm run probe:llm` 로
확인했다. 결과는 `docs/eval.md` 에 있고 요지는 이렇다.

- `qwen2.5:7b-instruct` 는 도구 호출·다단계·`json_schema` 구조화 출력·`<page_content>` 주입 저항이
  **모두 동작**하고, 10페이지 400행 순회를 **3/3 완주**했다(31스텝·약 27초).
- 그래서 **능력으로는 대체 가능하다.** 다만 M4b 성공 조건의 "3회 중 2회" 와 "LLM 호출 50% 감소" 는
  27B/30B 급을 전제로 쓰인 값이라, 7.6B 로 측정한 성공률은 같은 이름의 다른 숫자다.
  `docs/eval.md` 의 표에 모델 이름을 반드시 함께 적는 이유다.
- 실측에서 M4b 설계에 반영해야 할 것 두 가지가 나왔다: ① 도구 인자를 **읽지 않으면 채울 수 없게**
  설계해야 한다(순서 규칙만 준 1차 시도에서 모델이 페이지를 한 번도 읽지 않고 행 수를 지어냈다),
  ② 문맥이 한 시나리오에서 8,048 토큰에 닿아 **문맥 정리가 필수**다.

모델 교체는 사람 결정이므로(STOP CONDITIONS) 결정 전까지 M4b 는 그대로 멈춰 있다.

**M4b 를 지정 모델로 시작하려면:**

```powershell
ollama pull qwen3.6:27b        # 또는 ollama pull qwen3-coder:30b
ollama list                    # 모델이 보이면 준비 완료
```

M4b 가 바로 쓸 수 있게 남겨 둔 것: 모의 포털 G, `X-Helm-Thread` 로 스레드 이어가기,
`inbox_post`·`note_append`·`bookmark_list`·`checkpoint_*` 도구, ResultsTable 내보내기.

---

## 산출물

| 파일 | 내용 |
|---|---|
| `scenario-e-summary.json` | 시나리오 E 실측(방문·중복·결함·재개 지점·탭) |
| `persistence-summary.json` | 세션 격리·스레드 연속·내보내기 실측 |
| `sessions-and-badges.png` | 세션 화면과 탭 배지(itsm/gw) |
| `threads-continued.png` | 재시작 후 이어진 스레드 |
| `results-table.png` | 결과표와 내보내기 버튼 |
