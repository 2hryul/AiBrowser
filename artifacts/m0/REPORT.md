# M0 REPORT — Helm 실행 골격

- 작성: 2026-09-10
- 목표 문서: `GOAL.md` (M0 — 뜨는 빈 브라우저)
- 결정 기록: `docs\adr\0001-신규-스캐폴딩.md`
- 환경: Windows 11 (x64) · Node v24.11.0 · npm 11.6.1 · Electron 44.3.0 · vite 7.3.6

## 1. 성공 조건 판정

깨끗한 상태(`out\`, `.smoke-profile\`, `artifacts\m0\*` 삭제)에서 순서대로 실행한 결과다.

| # | 조건 | 결과 | 근거 |
|---|---|---|---|
| 1 | `npm run typecheck` | **PASS** (exit 0) | `tsc -p tsconfig.node.json` + `tsconfig.web.json`, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 2 | `npm run lint` | **PASS** (exit 0) | `eslint . --max-warnings=0` — 오류 0, 경고 0 |
| 3 | `npm run build` | **PASS** (exit 0) | `electron-vite build` → `out\main\index.js`, `out\preload\index.js`, `out\renderer\` |
| 4 | `npm run smoke` | **PASS** (exit 0) | Playwright Electron 스펙 2건 통과 (아래 상세) |
| 5 | `artifacts\m0\REPORT.md` | **PASS** | 이 문서 + 스크린샷 2장 + `smoke-summary.json` |

## 2. 스모크 테스트가 실제로 검증한 것

`scripts\smoke.ts` — 판정은 전부 메인 프로세스의 실제 상태를 읽어서 한다. 외부 네트워크 접속 없음.

### 스펙 1 — "앱이 뜨고 탭·주소창·네비게이션이 동작한다"

| 검증 | 방법 | 실측 |
|---|---|---|
| 메인 윈도우가 뜬다 | `BaseWindow.getAllWindows()` 1개 + `isVisible()` | true |
| 셸 UI가 실제로 렌더링된다 | 셸 DOM 조회 | 탭 1 · 주소창 1 · 새 탭 버튼 1 |
| 새 탭 2개 생성 | `TabManager.createTab()` ×2 (시작 탭 포함 3개) | tabs.length 3 |
| `app://home/` 이동 후 문서 title | `webContents.getTitle()` | `Helm 홈` (기대값 일치) |
| 탭 전환 | `selectTab()` 후 `activeTabId` | 대상 탭 id |
| 탭 닫기 | `closeTab()` 후 목록·활성 탭 | 2개 남음, 닫힌 id 없음, 활성 유지 |
| 웹 콘텐츠 배치 | 탭 뷰 bounds vs 기대 사각형 | `{x:240, y:48, w:1026, h:710}` 일치 |
| 페이지가 그 영역을 다 채움 | 탭 `window.innerWidth/Height` | 1026 × 710 (bounds와 동일) |
| 셸이 창에 정확히 맞음 | 셸 뷰 bounds vs `getContentBounds()` | 1266 × 758 일치 |
| 셸이 메인 상태를 반영 | IPC → zustand → DOM 재조회 | 탭 2개 · 활성 `Helm 홈` · 주소창 `app://home/` |
| 스크린샷 | `webContents.capturePage()` | 아래 3항 |

### 스펙 2 — "재시작 후에도 `persist:helm` 세션이 유지된다"

1. 1차 실행: `persist:helm` 파티션에 만료시각 있는 쿠키 `helm_smoke_session=m0-persisted` 저장 → `cookies.flushStore()` → 앱 종료
2. 2차 실행(같은 `userData` 프로필): 같은 파티션에서 쿠키 조회
3. 결과: 1건, 값 `m0-persisted` — **재시작 후 유지 확인**

프로필 경로는 `HELM_USER_DATA_DIR` 환경변수로 `.smoke-profile\` 에 고정한다. 테스트 시작 시 이 디렉터리를 지우므로 이전 실행 결과가 섞이지 않는다.

반복 안정성: 연속 3회 재실행 모두 2 passed (플래키 없음).

## 3. 스크린샷

| 파일 | 내용 | 해상도(device px) | 크기 |
|---|---|---|---|
| `artifacts\m0\shell.png` | 브라우저 크롬 — 세로 탭바 + 주소창 + 네비 버튼 | 1583 × 948 | 13,856 B |
| `artifacts\m0\home-tab.png` | 탭 웹 콘텐츠 — `app://home/` 번들 페이지 | 1283 × 888 | 22,034 B |

셸과 웹 콘텐츠는 별개의 `WebContentsView` 이므로 `capturePage()` 도 각각 찍힌다(화면에서는 Electron 이 합성). 논리 크기 대비 1.25배인 것은 Windows 디스플레이 배율 125% 때문이다: 셸 1266×758 → 1583×948, 탭 1026×710 → 1283×888.

실측값 원본: `artifacts\m0\smoke-summary.json` (스모크가 매 실행 갱신)

## 4. 실행 방법

```powershell
npm install
npm run dev          # 개발 모드 (vite dev server + Electron)
```

`npm install` 후 Electron 바이너리가 없으면 한 번만: `node node_modules\electron\install.js`

검증:

```powershell
npm run typecheck
npm run lint
npm run build
npm run smoke        # build 후 Playwright 실행, 스크린샷은 artifacts\m0\
```

`npm run dev` 로 실제 기동 확인함(로그: vite renderer `http://localhost:5173`, main/preload 빌드 성공 후 Electron 기동). 사람이 쓰는 동작: 탭 생성·전환·닫기, 주소창 입력/Enter, 뒤로·앞으로·새로고침, `Ctrl+T`/`Ctrl+W`/`Ctrl+L`/`Ctrl+R`·`F5`/`Alt+←→`.

## 5. 도중에 발견해서 고친 것

**셸 뷰가 창보다 26px 커서 사이드바 하단이 잘리던 문제.**
`window.show()` 직후 `getContentBounds()` 가 Windows 캡션 높이를 아직 반영하지 않고 1266×784 를 돌려주며(정착값 1266×758), 값이 바뀔 때 `resize` 이벤트도 발생하지 않았다. 그대로 두면 셸 하단("탭 N개 · persist:helm" 푸터)이 창 밖으로 밀린다.

- 확인: 스모크에 "셸 뷰 bounds == 창 콘텐츠 영역" 검증을 추가 → 758 vs 784 로 실패 재현
- 조치: `src\main\index.ts` 의 `settleLayout()` — 표시 직후 콘텐츠 크기가 안정될 때까지(동일값 3회 또는 1초) 50ms 간격으로 레이아웃을 재동기화
- 재검증: 해당 검증 통과, 연속 3회 재실행 안정

말이 아니라 수치로 잡힌 사례라 스크린샷만 봤으면 놓쳤을 버그다.

## 6. 제약 준수 확인

| 제약 | 상태 |
|---|---|
| `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | 셸·탭 모든 `WebContentsView` 에 적용 |
| 웹 콘텐츠 뷰에 preload 금지 | `TabManager.createTab()` 은 `preload` 를 지정하지 않음. preload 는 셸 뷰에만 |
| IPC 화이트리스트 | `src\main\ipc\channels.ts` 의 채널만 preload 가 노출. `ipcRenderer` 자체는 넘기지 않음 |
| 외부 네트워크 호출 코드 없음 | 자동 업데이트·텔레메트리·크래시 리포트 없음. 홈은 `app://home/` 번들 리소스. 주소창은 검색 엔진 폴백 없음 |
| 의존성 라이선스 | `node_modules` 전수 검사 결과 금지 라이선스 0건, license 필드 누락 0건 (MIT/Apache-2.0/BSD/ISC/0BSD/MPL-2.0 범위) |
| `npm audit` | 취약점 0건 (Electron 44.3.0 / vite 7.3.6 으로 상향) |
| 인증정보 이관 코드 없음 | Chrome/Edge 쿠키·토큰 복호화 코드 없음. `ProfileImport`·`LoginBroker` 자체가 M0 범위 밖 |

추가로 넣은 안전장치: `app://` 핸들러는 허용 host 목록(`home`)만 서비스하고 정규화 후 루트 밖 경로를 404 로 차단한다. `persist:helm` 세션의 권한 요청(`setPermissionRequestHandler`)은 M0 에서 전부 거부한다 — 사이트별 허용 UI 는 M1 이후.

## 7. 이번 범위에서 하지 않은 것 (스코프 오류 아님, GOAL OUT OF SCOPE)

AI 비서 · ToolSurface · MCP 서버 · 로컬 LLM · 에이전트 · 사내 포털 접속 · 인증정보 임포트 · 로그인 획득 경로 · 검증(워크플로우) 계층 · 승인/되돌리기 UI · 확장 프로그램.

M0 진행 중 OUT OF SCOPE 결정이 필요해진 상황은 **없었다**.

의도적으로 미룬 규칙 항목 하나:

- **`VERSION` 파일과 인스톨러 버전 주입**(`CLAUDE.md` 버전관리 규칙). M0 의 `build` 산출물은 `out\` 뿐이고 `dist\setup\` 인스톨러가 없다. electron-builder 도입 시점(M1/M6)에 `VERSION` 파일 + 빌드 주입을 함께 넣는 것이 맞아 지금은 `package.json` 의 `version: 0.0.1` 만 둔다. ADR 0001 에도 기록.

## 8. 다음 단계 판단 재료

- M0 산출물은 위 스크린샷 2장과 `npm run dev` 로 직접 확인 가능하다.
- `CLAUDE.md` 마일스톤 표의 "결정" 단계(Vessel 포크 vs 신규)는 아직 열려 있다. Vessel Windows 빌드로 사내 포털 3종 렌더링·세션 유지·MCP 시나리오 A 를 돌린 결과를 붙여 ADR 0001 을 갱신해야 최종 결론이 난다.
- M0 에서 만든 것 중 포크로 가더라도 재사용 가능한 부분: `app://` 프로토콜 핸들러, 주소창 정규화, 스모크 하네스(`HELM_USER_DATA_DIR` 프로필 고정 + 메인 프로세스 상태 판정 방식).
