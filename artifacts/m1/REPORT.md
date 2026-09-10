# M1 REPORT — 크롬 완성도

- 작성: 2026-09-10
- 목표: `goals/GOAL-M1.md` (M0 골격을 "하루 업무를 이 브라우저만으로" 쓸 수 있는 수준으로)
- 이전 단계: `artifacts/m0/REPORT.md` (5개 조건 PASS)
- 환경: Windows 11 (x64) · Node v24.11.0 · Electron 44.3.0 (내장 Node 24.20) · vite 7.3.6

## 1. PRECONDITIONS

| 조건 | 상태 |
|---|---|
| M0 산출물 존재 + `artifacts/m0/REPORT.md` 전부 PASS | **충족** |
| `config/extensions.json` 에 사내 필수 확장 3종 경로 | **미제공 → `[]` 로 두고 확장 항목 SKIPPED, 나머지 진행** (GOAL 이 정한 대체 경로) |

## 2. 성공 조건 판정

깨끗한 상태(`out\`, `.smoke-profile\`, `.smoke-downloads\`, `artifacts\m1\`, `*.tsbuildinfo` 삭제)에서 순서대로 실행했다.

| # | 조건 | 결과 | 근거 |
|---|---|---|---|
| 1 | `typecheck && lint && build` | **PASS** (전부 exit 0) | strict TS 2개 프로젝트, `eslint --max-warnings=0`, electron-vite 빌드 |
| 2 | `npm run smoke` (M0 유지 + M1 8항목) | **PASS** (exit 0, 13 passed) | 아래 3절 |
| 3 | `npm run test:unit` | **PASS** (exit 0, 52 passed / 5 파일) | 아래 4절 |
| 4 | 프로필 가져오기 fixture 건수 일치 + 자격증명 파일 미접근 | **PASS** | 아래 5절 |
| 5 | 확장 로드 결과가 `docs/extensions.md` 에 기록 | **PASS (확장 3종은 SKIPPED)** | 아래 6절 |
| 6 | `artifacts/m1/REPORT.md` | **PASS** | 이 문서 |

## 3. 스모크 13건 (`npm run smoke`)

| # | 항목 | 실측 |
|---|---|---|
| 1 | [M0] 앱 기동·탭·주소창·네비게이션·배치 | 콘텐츠 `{x:240, y:48, w:1026, h:710}` = 페이지 뷰포트 = 셸 1266×758 |
| 2 | [M1] 히스토리 | 기록 비운 뒤 3개 URL 방문 → 3건 저장·3행 표시. `home` 필터 → 1행(`app://home/`) |
| 3 | [M1] 북마크 | 별 버튼 추가 → 북마크바 표시 → 항목 클릭으로 이동 → 별 버튼 삭제. 북마크바가 뜨면 콘텐츠 상단 여백 48→80, 사라지면 48 |
| 4 | [M1] 다운로드 | `app://fixtures/sample.pdf` → 관리자에 `completed` 1건, 실제 파일 598바이트(원본과 동일) |
| 5 | [M1] 옴니박스 | 주소창에 `hom` 입력 → 제안 1순위 `app://home/` (셸 DOM·메인 계산 양쪽 확인) |
| 6 | [M1] 탭 고급 | 닫은 탭 복구, 고정 탭에 닫기 버튼 0개(IPC 로 닫아도 안 닫힘, 앞쪽 정렬), 드래그 순서 변경, 유휴 언로드 1건 후 재선택 복구 |
| 7 | [M1] 읽기 모드 | 본문 793자 추출, 본문 표식 포함 / 상단·하단 광고 및 `<script>` 미포함 |
| 8 | [M1] 페이지 내 찾기 | `보관` → 13건, 찾기바에 일치 수 표시. 바가 뜨면 여백 48→88, 닫으면 48 |
| 9 | [M1] 다크모드 | 셸 스크린샷 평균 밝기 밝게 **244.4** / 어둡게 **30.5** (임계값: 밝게 >150, 어둡게 <90, 차이 >80) |
| 10 | [M1] 확장 로드 | fixture 3종 — 정상 로드 1, 미지원 권한 경고 1, manifest 없음 실패 1 |
| 11 | [M1] 전체 스크린샷 + 쿠키 기록 | `shell.png` 1583×948, `home-tab.png` 1283×848 |
| 12 | [M0] 재시작 후 유지 | 쿠키 `m1-persisted` 복원 + 북마크 1건 · 방문 기록 12건 유지(SQLite) |
| 13 | [M1] 프로필 가져오기(앱 경유) | 아래 5절 |

판정은 전부 메인 프로세스의 실제 상태나 셸 DOM 을 읽어서 한다. 외부 네트워크에 나가지 않는다 —
검증에 쓰는 페이지는 전부 `app://` 번들 리소스다.

실측값 원본: `artifacts/m1/smoke-summary.json`

## 4. 단위 테스트 52건 (`npm run test:unit`)

| 파일 | 건수 | 내용 |
|---|---|---|
| `tests/reader.test.ts` | 12 | **골든 5건**(`article`/`main`+중첩 div/`div.content`/레거시 table/iframe+사이드바) + `article.html` + 실패 경로 |
| `tests/profile-import.test.ts` | 15 | 크롬 Bookmarks JSON 파서, 크롬 시각 변환, History·Web Data DB 파서, 프로필 탐색, 가져오기 건수, **파일 접근 로그**, 재실행 중복 없음 |
| `tests/omnibox.test.ts` | 17 | 주소 정규화, 제안 순위, 검색엔진 설정 |
| `tests/extensions.test.ts` | 7 | 확장 설정 파싱, 미지원 권한 판별 |
| `tests/no-credential-files.test.ts` | 1 | lint 규칙 자체 검증 — 위반 15건 검출 / 정상 9건 통과 |

## 5. 프로필 가져오기 — 건수와 파일 접근 로그

fixture: `fixtures/profiles/`(생성기 `scripts/make-profile-fixtures.mjs`).
크롬/엣지 프로필 폴더를 실제 형식으로 만들고, **열려서는 안 되는 파일 5개를 미끼로 함께 둔다.**

| 항목 | 기대 | 실측(앱 경유, 스모크 #13) |
|---|---|---|
| 북마크 | 4 | **4** |
| 방문 기록 | 5 | **5** |
| 자동완성 | 3 | **3** |
| 가져오지 않은 파일 | 5 | **5** (`Affiliation Database`, `Cookies`, `Local State`, `Login Data`, `Login Data For Account`) |
| 오류 | 0 | **0** |

### 자격증명 파일 미접근 — 세 겹으로 확인

1. **파일 접근 로그(단위 테스트).** `fs.existsSync/readFileSync/readdirSync/copyFileSync/openSync`
   를 감싸 프로필 디렉터리 접근을 전부 기록하고, 접근한 파일이 허용 목록
   (`Bookmarks`/`History`/`Web Data`) 뿐임을 단언한다. SQLite 원본은 임시 사본으로 복사한 뒤
   사본을 열기 때문에 원본 접근이 전부 `fs` 를 거친다 — 즉 이 로그가 빠짐없는 접근 기록이다.
2. **미끼 내용 미유출.** 미끼 파일에 `HELM_FIXTURE_MUST_NOT_BE_READ` 표식을 넣고, 가져오기
   결과 어디에도 나타나지 않음을 확인한다.
3. **정적 차단(`no-credential-files`).** 자격증명 저장소 파일명·복호화 관용구가 소스에
   등장하면 lint 에러다(`eslint-rules/no-credential-files.mjs`). 규칙 자체도 테스트한다.

**설계로 예외를 없앴다.** `ProfileImport` 는 허용 목록만 알고, 가져오지 않은 파일은
디렉터리 열거의 여집합으로 보고한다. 그래서 자격증명 파일명이 소스에 아예 없고 lint 규칙에
예외가 필요 없다. 유일한 예외는 규칙 자신의 테스트 파일 하나다(위반 문자열이 테스트 데이터).

`cookies` 는 Electron 정식 API(`session.cookies`)이기도 해서 단어만으로 잡지 않는다 —
경로 형태이거나 크롬 파일명 그대로일 때만 잡는다.

## 6. 확장 — SKIPPED (사유 기록)

사내 필수 확장 3종의 unpacked 경로가 제공되지 않아 **실제 확장은 검증하지 못했다.**
`config/extensions.json` 은 `[]` 이고, GOAL-M1 PRECONDITIONS 가 정한 "SKIPPED 기록 후 진행"
경로를 따랐다. 경로가 채워지면 `npm run smoke` 로 재검증하고 `docs/extensions.md` 에 결과를 추가한다.

로더 자체는 fixture 확장으로 검증했다(성공/미지원 권한/실패 3경로). 상세와 미지원 API 대안표는
`docs/extensions.md`, 실측 원본은 `artifacts/m1/extensions.json`.

## 7. 스크린샷

| 파일 | 내용 | 해상도(device px) |
|---|---|---|
| `shell.png` | 다크 셸 — 세로 탭바·주소창·툴바·북마크바 | 1583 × 948 |
| `shell-light.png` / `shell-dark.png` | 다크모드 토글 전후 (밝기 244.4 / 30.5) | 1583 × 948 |
| `reader.png` | 읽기 모드 화면 | 1583 × 948 |
| `home-tab.png` | 탭 웹 콘텐츠 `app://home/` | 1283 × 848 |

논리 크기 대비 1.25배인 것은 Windows 디스플레이 배율 125% 때문이다.

## 8. 실행 방법

```powershell
npm install
npm run dev
```

`npm install` 후 Electron 바이너리가 없으면 한 번만: `node node_modules\electron\install.js`

검증:

```powershell
npm run typecheck
npm run lint        # 경고 0건 정책
npm run build
npm run test:unit   # vitest 52건
npm run smoke       # build + Playwright Electron 13건, 산출물은 artifacts\m1\
```

fixture 재생성이 필요하면:

```powershell
node scripts\make-reader-fixtures.mjs
node scripts\make-profile-fixtures.mjs
node scripts\make-download-fixture.mjs
```

## 9. 도중에 발견해서 고친 것 3가지

전부 **말이 아니라 측정으로** 잡혔다. 셋 다 스모크가 회귀를 잡는다.

### (1) 앱이 종료되지 않던 회귀 — 창 파괴 후 뷰 정리

`app.quit()` 후 `quit` 이벤트까지 도달하고도 OS 프로세스가 남았다. Playwright 의 `app.close()`
가 무한 대기해 스모크 전체가 90초 타임아웃으로 죽었다.

- 좁히기: 가드를 넣어 이분 탐색 → **탭이 하나라도 있으면 종료 안 됨**, 탭이 없으면 정상.
  격리 실험(better-sqlite3 단독, BaseWindow+WebContentsView 단독)은 전부 정상 종료.
  M0 커밋을 worktree 로 빌드해 비교 → M0 는 3초에 정상 종료 = M1 회귀 확정.
- 원인: `window.on('closed')` 에서 `TabManager.dispose()` 가 **이미 파괴된 창**에
  `contentView.removeChildView()` 와 `webContents.close()` 를 호출.
- 조치: `dispose()` 가 `window.isDestroyed()` 를 먼저 확인하고, 죽은 창에서는 참조만 끊는다.
  두 번 호출해도 안전하다(`closed` 와 `will-quit` 양쪽에서 불린다).

### (2) 페이지 내 찾기가 항상 0건 — `findNext` 의미를 추측했다

Electron 의 `findInPage(query, { findNext })` 에서 `findNext` 는 "다음 일치로 이동"이 아니라
**"이 요청으로 새 검색 세션을 시작하는가"** 다. 초기 검색에 `false` 를 넘겨 `found-in-page`
이벤트가 **아예 오지 않았고**, 3초 타임아웃 후 0건으로 보였다.

옵션 조합을 실측한 결과: `findNext:true` 또는 생략 → 새 세션(13건), `findNext:false` 로 시작
→ 이벤트 없음, 세션이 열린 뒤 `findNext:false` → 다음 일치로 이동(ordinal 1→2).
공개 옵션명을 `advance` 로 바꿔 의미를 코드에 드러냈다. GOAL 의 "모르는 Electron API 는
추측하지 말 것" 을 어겼던 지점이다.

### (3) 다크모드가 셸에 반영되지 않음

`nativeTheme.themeSource = 'dark'` 는 `shouldUseDarkColors` 를 true 로 바꾸지만,
**`WebContentsView` 안의 `prefers-color-scheme` 은 따라오지 않는다**(Electron 44 실측: 5회
전환 모두 `matchMedia('(prefers-color-scheme: dark)').matches === false`). 셸 팔레트를
미디어 쿼리에만 걸어 두었더니 색이 그대로였다.

조치: 메인이 판정한 결과를 `document.documentElement.dataset.theme` 로 내려 셸이 명시적으로
따라가게 했다. 미디어 쿼리는 첫 페인트 보험으로 남겼다.
**남은 한계:** 웹 페이지의 `prefers-color-scheme` 은 같은 이유로 전환되지 않을 수 있다.
스모크가 검증한 것은 **셸 다크모드**다. 웹 콘텐츠 다크모드는 M2 에서 다시 확인해야 한다.

### 덤: `localhost:5173` 이 주소창에서 열리지 않던 M0 버그

`localhost:5173` 이 스킴 `localhost:` 로 오인돼 거부됐다. 콜론 뒤가 숫자뿐이면 호스트:포트로
본다(크롬과 같은 규칙). 옴니박스 단위 테스트를 쓰다가 드러났다.

## 10. 제약 준수

| 제약 | 상태 |
|---|---|
| `contextIsolation` / `nodeIntegration:false` / `sandbox:true` | 셸·탭 모든 뷰에 적용 |
| 웹 콘텐츠 뷰에 preload 금지 | `TabManager.attachView()` 는 preload 를 지정하지 않음. preload 는 셸 뷰 하나뿐 — 내부 화면을 패널로 만든 이유(ADR 0005) |
| IPC 화이트리스트 | `src/main/ipc/channels.ts` 채널만 preload 가 노출. `ipcRenderer` 자체는 넘기지 않음 |
| 외부 네트워크 호출 코드 없음 | 자동 업데이트·텔레메트리·크래시 리포트 없음. 검색엔진 URL 은 `config/search.json` 에서 읽고 기본값은 **엔진 없음** — 코드에 외부 URL 이 없다 |
| `no-credential-files` lint | 저장소 전체 적용, 규칙 자체도 테스트 (5절) |
| 의존성 라이선스 | 전수 검사 금지 라이선스 0건, license 필드 누락 0건 |
| `npm audit` | 취약점 0건 |

추가 방어: `app://` 핸들러는 허용 host(`home`, `fixtures`)만 서비스하고 경로 탈출을 404 로 막는다.
`persist:helm` 권한 요청은 M1 에서도 전부 거부한다(사이트별 허용 UI 는 M3 정책 화면).
프로필 가져오기는 렌더러가 보낸 임의 경로를 열지 않고, **탐색으로 찾은 프로필만** 가져온다.

## 11. 스택 관련 확인 사항

- **`better-sqlite3` 는 리빌드 없이 동작한다.** 이 환경에 MSVC 툴체인이 없어 네이티브 빌드가
  불가능한데, better-sqlite3 13.x 는 N-API prebuild(`prebuilds/win32-x64.node`)를 함께
  배포해 Electron ABI 와 무관하게 로드된다. Electron 실행 중 로드를 실제로 확인했다.
  M6 패키징 때 `prebuilds/` 가 asar 밖으로 나가도록 챙겨야 한다.
- Electron 44 의 내장 Node 는 24.20 이고 `node:sqlite` 도 쓸 수 있지만, `CLAUDE.md` 지정
  스택대로 `better-sqlite3` 를 썼다.

## 12. 이번 범위에서 하지 않은 것

GOAL-M1 OUT OF SCOPE: AI 비서, ToolSurface, MCP, 로컬 LLM, 승인·되돌리기, 스레드·세션·
체크포인트, 비밀번호 임포트, 로그인 획득 경로(LoginBroker), 사내 포털 연동.
**M1 진행 중 OUT OF SCOPE 결정이 필요해진 상황은 없었다.**

의도적으로 미룬 것:

- **3단계 임포트 마법사** — CLAUDE.md 가 M4c 로 배정했다. M1 은 IN SCOPE 인 "1단계(북마크·기록·
  자동완성)" 만 구현하고, 북마크 관리자 안의 최소 UI 로 노출했다.
- **자동완성 값을 실제 폼에 채우는 것** — 가져와 저장까지만 한다. 폼 채우기는 Chromium 자체
  기능과의 연동이 필요해 M1 범위를 넘는다.
- **다운로드 기록 영구 보존** — 목록은 메모리에만 둔다. GOAL 은 "진행률·취소·폴더 열기"만 요구한다.
- **`VERSION` 파일 기반 버전 주입** — 인스톨러가 생기는 M6 에서 electron-builder 와 함께.

## 13. 다음 단계

`goals/README.md` 순서대로면 다음은 **M2**(ToolSurface + 오버레이/Handoff + MCP, 모의 포털 A·B·C).
선행 조건 없음 — 모의 포털은 세션이 만든다.

M2 로 넘어갈 때 이어지는 것:

- `Reader.extractArticle()` 은 Electron 비의존 순수 함수다. `get_page_text` 가 그대로 쓴다.
- 내부 화면을 셸 패널로 둔 결정(ADR 0005) 덕분에 preload 표면이 셸 하나뿐이다. AI 도구 표면을
  붙일 때 노출 지점을 새로 늘리지 않아도 된다.
- 웹 콘텐츠 다크모드는 미확인 상태다(9-(3)). M2 에서 확인 필요.
