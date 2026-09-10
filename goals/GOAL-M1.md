# GOAL.md — Helm(가칭) M1 크롬 완성도

이 파일은 Claude Code가 이번 세션의 **목표**로 읽는 단일 명세다. `CLAUDE.md`(규칙)와 함께 읽고, 이 목표 하나만 개입 없이 끝까지 달성한다.

---

## PRECONDITIONS (세션 시작 전 사람이 준비 — 없으면 STOP)

- M0 산출물이 존재하고 `artifacts/m0/REPORT.md`가 전부 PASS
- `config/extensions.json`에 사내 필수 확장 3종의 로컬 경로(unpacked 디렉터리)가 등록되어 있음. 없으면 이 파일에 `[]`를 두고 확장 항목은 SKIPPED로 기록하되 나머지는 진행

## OBJECTIVE

M0 골격을 "하루 업무를 이 브라우저만으로 볼 수 있는" 수준의 브라우저로 끌어올린다. 크롬에서 되는 일상 동작이 여기서 안 되면 버그다.

## IN SCOPE

- 히스토리(`History.ts` + 페이지, Ctrl+H), 북마크(`Bookmarks.ts` + 북마크바, Ctrl+D/Ctrl+Shift+O), 다운로드 관리자(Ctrl+J, 진행률·취소·폴더 열기)
- 옴니박스 제안: URL·히스토리·북마크 접두 일치, 사내 검색엔진 URL은 `config/search.json`에서 읽음
- 탭 고급: 드래그 정렬, 고정, 닫은 탭 복구(Ctrl+Shift+T), 음소거, 유휴 30분 언로드, 세로/가로 전환
- 읽기 모드(`Reader.ts`, `@mozilla/readability` + linkedom) — 본문 추출기는 이후 `get_page_text`와 공용
- 개발자도구(F12), 인쇄(Ctrl+P), PDF 저장, 페이지 내 찾기(Ctrl+F), 확대/축소(Ctrl +/-/0), 다크모드
- 확장 로드(`Extensions.ts`, `session.loadExtension`) — `config/extensions.json`의 항목 로드, 미지원 API는 `docs/extensions.md`에 기록
- 크롬 프로필 가져오기 1단계만: 북마크·방문 기록·자동완성(비암호화 데이터). 비밀번호·쿠키·토큰은 **하지 않음**(GOAL-M0/CLAUDE.md 불변 조건 9)
- 크롬 단축키 호환표 `docs/shortcuts.md`

## OUT OF SCOPE

AI 비서, ToolSurface, MCP, 로컬 LLM, 승인·되돌리기, 스레드·세션·체크포인트, 비밀번호 임포트, 로그인 획득 경로(LoginBroker), 사내 포털 연동.

## FIXED DECISIONS

- 읽기 모드 라이브러리는 `@mozilla/readability`(Apache-2.0) 고정
- 프로필 가져오기는 Chrome·Edge 프로필 폴더의 `Bookmarks`(JSON), `History`(SQLite 복사 후 읽기), `Web Data`(자동완성)만. `Cookies`·`Login Data`·`Local State`는 열지 않는다
- 확장 로드 실패는 버그가 아니라 호환성 기록 대상. `docs/extensions.md`에 확장명·실패 API·대안을 적고 진행

## CONSTRAINTS

CLAUDE.md 보안 기본값 전부. 외부 네트워크 호출 코드 금지. 프로필 가져오기 코드에서 `Cookies`, `Login Data`, `Local State` 파일명이 등장하면 lint 에러(`eslint` 커스텀 규칙 `no-credential-files`).

## SUCCESS CRITERIA (전부 통과)

1. `npm run typecheck && npm run lint && npm run build` 통과
2. `npm run smoke` — M0 항목 유지 + 다음 추가 검증:
   - 히스토리: 3개 URL 방문 후 히스토리 페이지에 3건 표시, 검색 필터 동작
   - 북마크: 추가 → 북마크바 표시 → 클릭 이동 → 삭제
   - 다운로드: `app://fixtures/sample.pdf` 다운로드 → 관리자에 완료 항목 → 파일 존재
   - 옴니박스: "hom" 입력 시 `app://home` 제안 1순위
   - 탭: 닫기 후 Ctrl+Shift+T 복구, 고정 탭은 닫기 버튼 없음, 드래그로 순서 변경
   - 읽기 모드: `app://fixtures/article.html`에서 본문 추출 결과가 기대 텍스트 포함, 광고 div 미포함
   - 페이지 내 찾기: 일치 수 표시
   - 다크모드 토글 후 스크린샷 배경색 임계값 확인
3. `npm run test:unit` — Reader 추출기 골든 5건, 프로필 가져오기 파서(Chrome·Edge 샘플 프로필 fixture) 단위 테스트 통과
4. 프로필 가져오기 fixture 실행 결과: 북마크·히스토리·자동완성 건수 일치, 그리고 `Cookies`/`Login Data` 파일은 **읽히지 않았음**을 파일 접근 로그로 확인
5. `config/extensions.json` 항목 로드 결과가 `docs/extensions.md`에 기록(성공/실패/미지원 API)
6. `artifacts/m1/REPORT.md`에 위 결과·스크린샷·실행법 기록

## AUTONOMY LOOP

typecheck → lint → build → smoke → test:unit 순으로 실제 실행, 실패 시 로그 읽고 수정·재시도. UI는 `webContents.capturePage()` 스크린샷으로 확인. 의미 단위 커밋(`[M1]`). 전부 PASS면 REPORT.md 쓰고 종료.

## STOP CONDITIONS

- PRECONDITIONS 미충족
- 같은 근본 원인 5회 실패
- `session.loadExtension`이 Electron 버전에서 특정 확장을 로드 못 함 → STOP 아님, `docs/extensions.md`에 기록하고 진행
- OUT OF SCOPE 결정 필요(스코프 오류 기록)

## DONE

`artifacts/m1/REPORT.md` 전부 PASS. 사람이 `npm run dev`로 띄워 히스토리·북마크·다운로드·읽기 모드·단축키를 크롬처럼 쓸 수 있고, 프로필 가져오기가 북마크·기록만 가져온다.
