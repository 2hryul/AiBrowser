# GOAL.md — Helm(가칭) M6 파일럿 준비 (서명 배포 · 정책 잠금 · 파일럿 계측)

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. M6는 성격상 두 부분으로 나뉜다. **Claude Code가 무개입으로 할 수 있는 것(배포 패키지·정책 잠금·계측·운영 문서)** 과 **사람이 해야 하는 것(실제 파일럿 실행·피드백)**. 이 GOAL은 전자만을 목표로 한다.

---

## PRECONDITIONS

- `artifacts/m4c/REPORT.md`, `artifacts/m5/REPORT.md` 전부 PASS
- **사람이 준비**: 코드 서명 인증서(사내 CA 발급 `.pfx`) 경로와 비밀번호를 환경변수 `HELM_SIGN_PFX`, `HELM_SIGN_PASS`로 제공. 없으면 서명 단계는 SKIPPED로 기록하고 미서명 인스톨러로 진행(REPORT에 명시)
- **사람이 결정해 기록**: `config/pilot.json` — 파일럿 대상 도메인 허용 목록, 관리자 잠금 정책 값(`allowPasswordImport`, `externalLoginHosts`, `javascriptTool`, `headlessAllowed`, `retentionDays`), 사내 LLM 엔드포인트·모델. 없으면 STOP

## OBJECTIVE

10명 파일럿에 배포할 수 있는 서명된 Windows 인스톨러와 관리자 정책 잠금, 파일럿 기간 동안 무엇이 얼마나 쓰였는지 로컬에서 계측·집계하는 수단, 그리고 파일럿 운영 문서를 만든다. 외부 텔레메트리는 없다 — 계측은 로컬 감사 로그의 집계 리포트다.

## IN SCOPE

- **배포**: electron-builder Windows NSIS(x64), 코드 서명(환경변수 제공 시), 앱 아이콘·제품명(가칭 유지), 설치 경로·시작 메뉴·기본 브라우저 등록 옵션(사용자 선택), 제거 시 사용자 데이터 보존 여부 선택
- **관리자 정책 잠금**: `config/policy.json`을 `%PROGRAMDATA%\Helm\policy.json`(관리자 배포)과 `%APPDATA%\Helm\policy.json`(사용자) 2계층으로 — 관리자 파일의 `locked: true` 키는 사용자 파일이 덮어쓸 수 없음. 설정 화면에 잠긴 항목 회색 표시
- **폐쇄망 검증**: 앱 기동부터 종료까지 아웃바운드 연결이 설정된 LLM 엔드포인트와 사용자 브라우징 대상 외에 **0건**임을 자동 검증(테스트에서 네트워크 인터셉트로 호스트 목록 수집). 자동 업데이트·텔레메트리·크래시 리포트 코드 부재를 정적 검사(`electron-updater`, `@sentry/*` 등 의존성 금지 목록)
- **파일럿 계측(로컬)**: 감사 로그 집계 스크립트 `npm run pilot:report` → 기간 내 스레드 수, 도구 호출 분포, 승인 발생·선택 분포(once/thread/domain), 되돌리기 사용 수, Handoff 발생 수, 로컬 LLM 호출 수·평균 지연, 워크플로우 실행·판정 분포, 오류 상위 10 → `artifacts/pilot/REPORT-<date>.md`. 개인 식별 정보 없음(사용자별 집계는 로컬 사용자명 해시)
- **운영 문서**: `docs/pilot/설치가이드.md`(사용자), `docs/pilot/관리자가이드.md`(정책 잠금·배포·로그 수집), `docs/pilot/피드백양식.md`(기본 브라우저 전환 여부, 스크래핑 시간 절감 체감, 승인·되돌리기 사용 경험, 막힌 사이트), `docs/pilot/알려진제약.md`(확장 호환, ActiveX 미지원, 토큰 미이관 안내)
- **크래시 안전**: 렌더러 크래시 시 탭만 복구(전체 앱 종료 아님), 메인 크래시 시 재실행하면 스레드 `paused`로 복구(M4a 확인)
- 기존 전체 테스트를 CI 스크립트(`npm run ci`)로 묶고 라이선스 검사 포함

## OUT OF SCOPE

실제 파일럿 실행·피드백 수집·분석(사람), 새 기능, 레코더, 사내 GPU 서버 구축, 제품명 확정.

## FIXED DECISIONS

- 텔레메트리 서버는 만들지 않는다. 계측은 로컬 집계 리포트를 사람이 수합한다
- 인스톨러는 NSIS x64 단일. MSI·ARM은 제외
- 서명 인증서 미제공 시 STOP 아님 — 미서명으로 진행하고 REPORT에 SmartScreen 경고 예상을 명시
- 관리자 정책 잠금은 파일 2계층 방식(레지스트리·GPO 연동은 후속)

## CONSTRAINTS

CLAUDE.md 보안 기본값. 의존성 금지 목록: `electron-updater`, `@sentry/*`, `posthog-*`, `mixpanel*`, `segment*`. 라이선스 검사 통과 필수.

## SUCCESS CRITERIA (전부 통과)

1. `npm run ci` — 전 마일스톤 테스트 + 라이선스 검사 통과
2. `npm run dist` → `dist/Helm-Setup-x64.exe` 생성. 서명 환경변수 있으면 `signtool verify` 통과, 없으면 SKIPPED 기록
3. 설치 스모크(Windows 러너에서): 사일런트 설치 → 앱 기동 → M0 스모크 → 사일런트 제거 → 데이터 보존 옵션에 따라 `%APPDATA%\Helm` 존재/부재
4. 정책 잠금 테스트: 관리자 파일 `locked:true, allowPasswordImport:false` + 사용자 파일 `allowPasswordImport:true` → 유효값 false, 설정 화면 항목 회색·편집 불가(DOM 검사), 로그에 override 시도 기록
5. 폐쇄망 검증: 기동→모의 포털 A 작업→종료 동안 아웃바운드 호스트 집합 = {설정 LLM 호스트, app://} 만. 정적 검사에서 금지 의존성 0
6. `npm run pilot:report` — fixture 감사 로그 7일치로 리포트 생성, 모든 지표 존재, PII 패턴 0
7. 크래시 안전: 렌더러 강제 크래시 → 해당 탭만 재로딩, 다른 탭·스레드 유지; 메인 강제 종료 → 재실행 → 스레드 `paused`
8. `docs/pilot/` 4개 문서 존재, 설치가이드에 스크린샷 3장 이상(자동 캡처)
9. `artifacts/m6/REPORT.md` — 배포물 경로, 서명 상태, 정책 잠금 결과, 폐쇄망 검증 호스트 목록, 파일럿 리포트 샘플 경로

## AUTONOMY LOOP

CI 묶기 → 정책 2계층 → 폐쇄망 검증 → 계측 스크립트 → 문서 → dist/서명 → 설치 스모크. `[M6]` 커밋.

## STOP CONDITIONS

- `config/pilot.json` 미기록(사람 결정) → STOP
- 같은 근본 원인 5회 실패 / OUT OF SCOPE 결정 필요
- 폐쇄망 검증에서 알 수 없는 아웃바운드 호스트 발견 → 원인 제거까지 반복, 제거 불가(서드파티 내부 호출)면 STOP·의존성 교체는 사람 결정

## DONE

`artifacts/m6/REPORT.md` 전부 PASS. 관리자가 정책 파일을 잠근 채 서명된 인스톨러를 10명에게 배포할 수 있고, 앱은 사내 LLM 외 어디에도 연결하지 않으며, 파일럿 종료 후 `pilot:report`로 사용 실태를 집계할 수 있다.

## AFTER M6 (사람의 일 — 참고)

10명 파일럿 2주 → 피드백양식 수합 → `pilot:report` 집계 → 기본 브라우저 전환율·스크래핑 시간 절감·승인/되돌리기 사용 빈도 평가 → 다음 목표 후보: M7 레코더(시연 → 어댑터 컴파일), M8 실제 사내 포털 어댑터 3종, M9 심사 전처리·문서 QC 도메인, Vessel 포크 재검토(코드베이스가 커진 시점의 비용 대비).
