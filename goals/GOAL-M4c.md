# GOAL.md — Helm(가칭) M4c 로그인 획득 경로 + 최초 임포트 마법사

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`(불변 조건 9, "인증·로그인·임포트" 절), 기획서 4.8장과 함께 읽는다.

---

## PRECONDITIONS

- `artifacts/m4a/REPORT.md` 전부 PASS(M4b는 무관)
- **사람이 결정해 `config/policy.json`에 기록**: `allowPasswordImport`(true/false — 정보보호 부서 승인 결과), `externalLoginHosts`(외부 브라우저 폴백을 허용할 호스트 목록, 없으면 `[]`). 두 값이 없으면 STOP
- 모의 IdP fixture 2종을 이 세션에서 만든다: (1) 일반 폼 로그인 `app://idp-form`, (2) 임베디드 웹뷰를 거부하는 OAuth `app://idp-oauth`(User-Agent가 Electron 문자열을 포함하거나 `window.opener`가 없으면 "안전하지 않은 앱" 페이지 반환, 모달/외부 창에서는 표준 redirect로 code 발급)
- 모의 Chrome/Edge 프로필 fixture(`fixtures/profiles/chrome`, `fixtures/profiles/edge`): `Bookmarks`(JSON), `History`(SQLite), `Web Data`(SQLite), 그리고 **읽히면 안 되는** `Cookies`·`Login Data`·`Local State` 더미 파일 포함

## OBJECTIVE

인증 토큰을 이관하지 않고도 사용자가 "다시 로그인 안 함"을 체감하도록, 로그인 획득 경로 3종을 구현하고, 최초 구동 임포트를 편의 데이터 한정 3단계 정책·동의·감사 로그로 구현한다.

## IN SCOPE

**LoginBroker** (`sessions/LoginBroker.ts`, `tools/login.ts` → `login_start(url, method)`)
- `inapp`: 대상 로그인 URL을 현재 Named Session 탭에서 열고 사용자 입력 대기 → 로그인 성공 휴리스틱(리다이렉트·세션 쿠키 생성·로그인 폼 사라짐) → 세션 메타에 `{method:'inapp', at}` 기록
- `oauth_modal`: 서비스 웹뷰와 **같은 partition**을 쓰는 모달 BrowserWindow에서 표준 redirect OAuth 완료(정상 브라우저 UA 값 사용 — 스푸핑이 아니라 Electron 기본 UA에서 `Electron/x.y` 토큰만 제거한 표준 Chromium UA). 완료 후 모달 닫고 세션 안착 검증
- `external`: `shell.openExternal`로 실제 Chrome/Edge 열어 인증만 완료 → 사용자가 "완료" 클릭 → Helm이 `navigate`로 대상 도메인 로그인 상태 휴리스틱 검증 → 실패 시 `inapp` 폴백. `policy.externalLoginHosts`에 없는 호스트는 거부
- 세 경로 모두 비밀번호·토큰을 어디에도 쓰지 않는다(암호화 partition만)
- 세션 만료 감지(M2의 리다이렉트 휴리스틱) → Inbox `login_required` + 스레드 `waiting_login` + 사이드바에 "로그인 필요" 카드(경로 선택 버튼)

**ProfileImport 마법사** (`browser/ProfileImport.ts`, `renderer/shell/ImportWizard`)
- 최초 구동 시 Chrome·Edge 프로필 감지(`%LOCALAPPDATA%\Google\Chrome\User Data`, `...\Microsoft\Edge\User Data`; 테스트는 fixture 경로 주입)
- 1단계 가져온다: 북마크·방문 기록·자동완성 — 항목별 체크박스, 건수 미리보기(M1 파서 재사용)
- 2단계 동의 시: 저장 비밀번호 — `policy.allowPasswordImport`가 true일 때만 항목 표시, 명시 동의 체크 → Chrome 내보내기 CSV 가져오기 **또는** 같은 사용자 DPAPI 복호화 → OS 자격증명 관리자(Windows Credential Manager)로 이전 → 평문 즉시 삭제(메모리·임시파일 zero-fill). false면 항목 자체를 숨기고 "관리자 정책으로 비활성"
- 3단계 가져오지 않는다: 세션 쿠키·인증 토큰 — 마법사에 고정 안내 "보안 정책상 가져오지 않습니다. 각 사이트에서 한 번 로그인하면 이후 유지됩니다"
- 모든 임포트 `{what, count, sourceProfile, ts}` AuditLog, 마법사 재실행 가능(설정)

## OUT OF SCOPE

에이전트·LLM 변경, 검증 계층, 서명·배포, 실제 IdP·실제 프로필(테스트는 fixture).

## FIXED DECISIONS

- **금지**: `Cookies`, `Login Data`(비밀번호 경로 제외), `Local State`의 `os_crypt`, `app_bound_encrypted_key`를 읽거나 복호화하는 코드. `no-credential-files` lint 규칙을 `Login Data`에 대해서만 `allowPasswordImport` 경로에서 예외 허용하고, 그 파일에는 `// policy:password-import` 주석과 감사 로그 호출이 있어야 통과
- ABE/DBSC 우회 시도 코드 금지(불변 조건 9). 관련 라이브러리 의존성 추가 금지
- `oauth_modal`의 UA는 스푸핑이 아니다: Electron 토큰 제거만 허용, 다른 브라우저로 위장하는 문자열 금지
- 외부 폴백은 `policy.externalLoginHosts` 화이트리스트 밖이면 실행 자체 거부

## CONSTRAINTS

CLAUDE.md 보안 기본값. 비밀번호 임포트 경로는 평문을 디스크에 쓰지 않는다(스트리밍 → Credential Manager). 마법사 스크린샷에 비밀번호 값이 보이면 실패.

## SUCCESS CRITERIA (전부 통과)

1. 회귀: `typecheck && lint && build && smoke && test:tools && test:mcp && test:policy && test:persistence`
2. `npm run test:login`:
   - `inapp`: `app://idp-form` 로그인 → 세션 쿠키 생성 → 재시작 후 유지 → 세션 메타 `method:'inapp'`
   - `oauth_modal`: `app://idp-oauth`를 일반 탭에서 열면 "안전하지 않은 앱" 페이지(fixture 재현 확인) → `login_start(method:'oauth_modal')` → 모달에서 code 발급·redirect → 서비스 파티션에 세션 쿠키 존재 → 모달 자동 닫힘
   - `external`: 화이트리스트 호스트는 `shell.openExternal` 호출(mock) → "완료" → 검증 통과; 화이트리스트 밖 호스트는 호출 전 거부·로그
   - 세션 만료 → `login_required` Inbox 항목 + 스레드 `waiting_login` → 로그인 후 재개(M4a 체크포인트 연동)
3. `npm run test:import`:
   - fixture Chrome·Edge 프로필에서 북마크·기록·자동완성 건수 일치
   - `allowPasswordImport:false` → 마법사에 비밀번호 항목 부재(스크린샷 OCR 아닌 DOM 검사)
   - `allowPasswordImport:true` + 동의 → CSV fixture 3건이 Credential Manager mock에 저장, 임시 파일 부재, 로그 3건
   - **파일 접근 로그에 `Cookies`·`Local State` 접근 0건**(fixture 파일에 read hook)
   - 마법사 스크린샷 어디에도 fixture 비밀번호 문자열 픽셀/DOM 부재
4. lint: `Cookies` 문자열이 소스에 등장하면 실패(허용 목록: 이 GOAL·docs 제외), `Login Data`는 정책 주석·감사 호출 없으면 실패
5. `docs/adr/0003-인증정보-미이관.md` 작성(ABE/DBSC 근거, sync-multi-chat·Vessel 사례, 3경로·3단계 정책)
6. `artifacts/m4c/REPORT.md`

## AUTONOMY LOOP

fixture(IdP·프로필) → LoginBroker 3경로 → 세션 만료 연동 → ImportWizard → lint 규칙 → ADR. 각 단계 테스트 후 다음. `[M4c]` 커밋.

## STOP CONDITIONS

- PRECONDITIONS 미충족(정책 값 2개 미기록이면 즉시 STOP — 이 결정은 사람 몫)
- Windows Credential Manager 연동 라이브러리가 라이선스 허용 목록 밖이면 STOP(대안 조사 결과를 REPORT에)
- 같은 근본 원인 5회 실패 / OUT OF SCOPE 결정 필요

## DONE

`artifacts/m4c/REPORT.md` 전부 PASS. 최초 구동 마법사가 북마크·기록만(정책 허용 시 비밀번호까지) 가져오고 토큰은 가져오지 않는다고 안내하며, 임베디드 OAuth를 거부하는 IdP도 모달 경로로 로그인되어 세션이 유지된다. 소스 어디에도 쿠키·토큰 복호화 코드가 없다.
