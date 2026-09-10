import fs from 'node:fs';
import path from 'node:path';

/**
 * 모의 사내 포털 3종. `app://portal-a|portal-b|portal-c` 로 서비스한다.
 *
 * 이 세션은 실제 사내 포털에 접근할 수 없으므로(GOAL-M2 PRECONDITIONS) 스크래핑이 어려운
 * 기술 패턴만 골라 재현한다. 재현 대상:
 *   A 그룹웨어형  — 서버 렌더링 테이블, 번호 페이지네이션, 세션 만료 → 로그인 리다이렉트
 *   B ITSM형 SPA — 필터 폼 → XHR JSON, 가상 스크롤, total 필드
 *   C 규정 포털형 — iframe 중첩, window.open 팝업, 첨부 PDF, EUC-KR 페이지
 *
 * 패키징된 앱에는 등록하지 않는다(installAppProtocol 호출부에서 판단).
 */

export const PORTAL_HOSTS = ['portal-a', 'portal-b', 'portal-c'] as const;
export type PortalHost = (typeof PORTAL_HOSTS)[number];

/**
 * 포털 A 로그인 세션.
 *
 * 진짜 쿠키를 쓰려 했으나 Chromium 이 커스텀 스킴 쿠키를 거부한다
 * (`EXCLUDE_NONCOOKIEABLE_SCHEME`, Electron 44 에서 실측). app:// 는 쿠키를 가질 수 없다.
 * 그래서 모의 포털의 세션은 fixture 내부 상태로 둔다 — 검증 대상은 "만료 → 로그인 페이지로
 * 리다이렉트 → 복구 → 재개" 흐름이지 쿠키 저장소 자체가 아니다.
 * 실제 포털은 https 라 쿠키가 정상 동작하고, persist:helm 파티션의 쿠키 유지는
 * M0·M1 스모크가 이미 검증했다.
 */
let portalASessionValid = false;

// ─────────────────────────────────────────────────────────────
// 데이터 생성 — 결정적이어야 테스트가 값을 단언할 수 있다
// ─────────────────────────────────────────────────────────────

export const PORTAL_A = { rowsPerPage: 20, pages: 10 } as const;
export const PORTAL_A_TOTAL = PORTAL_A.rowsPerPage * PORTAL_A.pages;

interface Notice {
  id: number;
  title: string;
  dept: string;
  author: string;
  /** YYYY-MM-DD */
  postedAt: string;
  views: number;
}

const DEPTS = ['정보관리팀', '인사팀', '총무팀', '재무팀', '정보보호팀'];
const AUTHORS = ['김주임', '이대리', '박과장', '최차장', '정부장'];

/** 공지 200건. id 는 1..200, 게시일은 2026-01-01 부터 하루씩. */
function notices(): Notice[] {
  return Array.from({ length: PORTAL_A_TOTAL }, (_unused, index) => {
    const id = index + 1;
    const day = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000);
    const iso = day.toISOString().slice(0, 10);
    return {
      id,
      title: `사내 공지 ${String(id).padStart(3, '0')} — ${DEPTS[id % DEPTS.length]} 안내`,
      dept: DEPTS[id % DEPTS.length] ?? '정보관리팀',
      author: AUTHORS[id % AUTHORS.length] ?? '김주임',
      postedAt: iso,
      views: 100 + ((id * 37) % 900)
    };
  });
}

const NOTICES = notices();

export const PORTAL_B = { pageSize: 50, total: 137 } as const;

interface Incident {
  id: string;
  priority: 'P1' | 'P2' | 'P3';
  status: string;
  title: string;
  assignee: string;
  openedAt: string;
  period: 'week' | 'month' | 'quarter';
}

const PRIORITIES: Incident['priority'][] = ['P1', 'P2', 'P3'];
const STATUSES = ['접수', '처리중', '보류', '완료'];
const PERIODS: Incident['period'][] = ['week', 'month', 'quarter'];

/** 장애 137건. 우선순위·기간이 골고루 섞여 필터 조합을 검증할 수 있다. */
const INCIDENTS: Incident[] = Array.from({ length: PORTAL_B.total }, (_unused, index) => {
  const n = index + 1;
  return {
    id: `INC${String(n).padStart(5, '0')}`,
    priority: PRIORITIES[n % 3] ?? 'P3',
    status: STATUSES[n % 4] ?? '접수',
    title: `장애 ${n} — 서비스 지연`,
    assignee: AUTHORS[n % AUTHORS.length] ?? '김주임',
    openedAt: new Date(Date.UTC(2026, 5, 1) + index * 3_600_000).toISOString(),
    // 우선순위와 기간을 서로 다른 주기로 돌린다. 같은 주기(n % 3)로 두면 둘이 완전히 상관돼
    // "P1 + 최근 1분기" 같은 조합이 공집합이 되고, 필터 조합 검증이 성립하지 않는다.
    period: PERIODS[Math.floor(n / 7) % 3] ?? 'week'
  };
});

export const PORTAL_C = { docs: 10 } as const;

interface Rule {
  id: number;
  category: string;
  title: string;
  /** EUC-KR 로 서비스되는 문서 */
  legacyEncoding: boolean;
}

const RULES: Rule[] = Array.from({ length: PORTAL_C.docs }, (_unused, index) => {
  const id = index + 1;
  return {
    id,
    category: id <= 5 ? '인사규정' : '보안규정',
    title: `규정 제${id}호 — ${id <= 5 ? '인사' : '보안'} 관리 기준`,
    // 3번 문서만 구형 인코딩. 사내 구형 시스템에서 흔한 상황을 한 건 심어 둔다.
    legacyEncoding: id === 3
  };
});

// ─────────────────────────────────────────────────────────────
// HTML 조립
// ─────────────────────────────────────────────────────────────

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  body { font: 14px/1.6 "Malgun Gothic", system-ui, sans-serif; margin: 0; color: #1c1c1e; background: #fff; }
  header { background: #23408e; color: #fff; padding: 10px 16px; font-weight: 600; }
  main { padding: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d5d5dd; padding: 6px 8px; text-align: left; }
  th { background: #f1f3f8; }
  .pager { margin-top: 12px; display: flex; gap: 6px; flex-wrap: wrap; }
  .pager a { padding: 4px 9px; border: 1px solid #c9c9d3; text-decoration: none; color: #23408e; }
  .pager a[aria-current="page"] { background: #23408e; color: #fff; }
  .danger { background: #b3261e; color: #fff; border: 0; padding: 6px 10px; cursor: pointer; }
  label { display: inline-flex; gap: 4px; align-items: center; margin-right: 12px; }
</style>
${extraHead}
</head>
<body>
${body}
</body>
</html>
`;
}

function html(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders }
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/**
 * 커스텀 스킴에서 302 를 Chromium 이 따라가지 않는 경우가 있어, 스크립트로 실제 탐색을 일으킨다.
 * did-navigate 가 뜨는 진짜 이동이므로 AI 쪽에서 리다이렉트로 감지된다.
 */
function redirect(to: string, reason: string): Response {
  return html(
    page(
      '이동 중',
      `<main>
         <p id="redirect-notice">${esc(reason)}</p>
         <p><a id="redirect-link" href="${esc(to)}">계속</a></p>
       </main>
       <script>location.replace(${JSON.stringify(to)});</script>`
    )
  );
}

// ─────────────────────────────────────────────────────────────
// 포털 A — 그룹웨어형
// ─────────────────────────────────────────────────────────────

function portalALogin(next: string): string {
  return page(
    '사내 포털 로그인',
    `<header>사내 그룹웨어 — 로그인</header>
     <main>
       <p id="login-required">세션이 만료되었습니다. 다시 로그인해 주세요.</p>
       <form id="login-form" method="get" action="app://portal-a/login-submit">
         <input type="hidden" name="next" value="${esc(next)}" />
         <label>사번 <input id="user" name="user" type="text" value="10012345" /></label>
         <label>비밀번호 <input id="password" name="password" type="password" value="sample-not-real" /></label>
         <button id="login-button" type="submit">로그인</button>
       </form>
     </main>`
  );
}

function portalAList(pageNumber: number): string {
  const start = (pageNumber - 1) * PORTAL_A.rowsPerPage;
  const rows = NOTICES.slice(start, start + PORTAL_A.rowsPerPage);

  const body = rows
    .map(
      (notice) => `<tr data-notice-id="${notice.id}">
        <td>${notice.id}</td>
        <td><a href="app://portal-a/notice?id=${notice.id}">${esc(notice.title)}</a></td>
        <td>${esc(notice.dept)}</td>
        <td>${esc(notice.author)}</td>
        <td class="posted-at">${notice.postedAt}</td>
        <td>${notice.views}</td>
      </tr>`
    )
    .join('\n');

  const pager = Array.from({ length: PORTAL_A.pages }, (_unused, index) => {
    const n = index + 1;
    const current = n === pageNumber ? ' aria-current="page"' : '';
    return `<a href="app://portal-a/list?page=${n}"${current}>${n}</a>`;
  }).join('');

  return page(
    `공지사항 (${pageNumber}/${PORTAL_A.pages})`,
    `<header>사내 그룹웨어 — 공지사항</header>
     <main>
       <p>전체 ${PORTAL_A_TOTAL}건 · ${pageNumber}/${PORTAL_A.pages} 페이지</p>
       <button class="danger" id="expire-session" onclick="location.href='app://portal-a/expire'">세션 만료 시뮬레이션</button>
       <table id="notice-table">
         <thead><tr><th>번호</th><th>제목</th><th>부서</th><th>작성자</th><th>게시일</th><th>조회</th></tr></thead>
         <tbody>${body}</tbody>
       </table>
       <nav class="pager" aria-label="페이지 목록">${pager}</nav>
     </main>`
  );
}

function portalANotice(id: number): string | null {
  const notice = NOTICES.find((item) => item.id === id);
  if (!notice) return null;

  return page(
    notice.title,
    `<header>사내 그룹웨어 — 공지 상세</header>
     <main>
       <h1 id="notice-title">${esc(notice.title)}</h1>
       <p id="notice-meta">${esc(notice.dept)} · ${esc(notice.author)} · <span class="posted-at">${notice.postedAt}</span> · 조회 ${notice.views}</p>
       <div id="notice-body">
         <p>공지 본문 ${notice.id}. 규정 개정에 따른 절차 변경을 안내합니다.</p>
       </div>
       <p><a href="app://portal-a/list?page=${Math.floor((notice.id - 1) / PORTAL_A.rowsPerPage) + 1}">목록으로</a></p>
     </main>`
  );
}

// ─────────────────────────────────────────────────────────────
// 포털 B — ITSM형 SPA
// ─────────────────────────────────────────────────────────────

function portalBApp(): string {
  return page(
    'ITSM 장애 조회',
    `<header>ITSM — 장애 조회</header>
     <main>
       <form id="filter">
         <fieldset>
           <legend>우선순위</legend>
           <label><input type="checkbox" id="p1" name="priority" value="P1" /> P1</label>
           <label><input type="checkbox" id="p2" name="priority" value="P2" /> P2</label>
           <label><input type="checkbox" id="p3" name="priority" value="P3" /> P3</label>
         </fieldset>
         <label>기간
           <select id="period" name="period">
             <option value="week">최근 1주</option>
             <option value="month">최근 1개월</option>
             <option value="quarter">최근 1분기</option>
           </select>
         </label>
         <button type="button" id="search">조회</button>
       </form>

       <p id="summary">조회 전</p>
       <!-- 가상 스크롤: 화면에 보이는 만큼만 DOM 에 둔다. DOM 파싱으로는 전체를 얻을 수 없다. -->
       <div id="viewport" style="height: 320px; overflow: auto; border: 1px solid #d5d5dd;">
         <div id="spacer" style="height: 0;"></div>
       </div>
     </main>
     <script>
       const state = { rows: [], total: 0, page: 1, size: 50, loading: false, done: false };

       function query() {
         const priorities = Array.from(document.querySelectorAll('input[name="priority"]:checked')).map((el) => el.value);
         const period = document.getElementById('period').value;
         return { priorities, period };
       }

       async function load(reset) {
         if (state.loading || (!reset && state.done)) return;
         state.loading = true;
         if (reset) { state.rows = []; state.page = 1; state.done = false; }

         const { priorities, period } = query();
         const params = new URLSearchParams({ page: String(state.page), size: String(state.size), period });
         for (const p of priorities) params.append('priority', p);

         const response = await fetch('app://portal-b/api/incidents?' + params.toString());
         const data = await response.json();

         state.total = data.total;
         state.rows = state.rows.concat(data.items);
         state.page += 1;
         state.done = state.rows.length >= data.total;
         state.loading = false;
         render();
       }

       function render() {
         document.getElementById('summary').textContent =
           '표시 ' + state.rows.length + ' / 전체 ' + state.total + '건';
         // 마지막 12행만 DOM 에 남긴다(가상 스크롤 흉내).
         const visible = state.rows.slice(-12);
         const viewport = document.getElementById('viewport');
         viewport.querySelectorAll('.row').forEach((el) => el.remove());
         for (const row of visible) {
           const div = document.createElement('div');
           div.className = 'row';
           div.dataset.incidentId = row.id;
           div.textContent = row.id + ' · ' + row.priority + ' · ' + row.status + ' · ' + row.title;
           viewport.appendChild(div);
         }
         document.getElementById('spacer').style.height = (state.rows.length * 24) + 'px';
       }

       document.getElementById('search').addEventListener('click', () => load(true));
       document.getElementById('viewport').addEventListener('scroll', (event) => {
         const el = event.target;
         if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) load(false);
       });
     </script>`
  );
}

function portalBIncidents(url: URL): Response {
  const pageNumber = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size') ?? PORTAL_B.pageSize)));
  const priorities = url.searchParams.getAll('priority');
  const period = url.searchParams.get('period');

  const filtered = INCIDENTS.filter(
    (incident) =>
      (priorities.length === 0 || priorities.includes(incident.priority)) &&
      (period === null || period === '' || incident.period === period)
  );

  const start = (pageNumber - 1) * size;
  return json({
    page: pageNumber,
    size,
    total: filtered.length,
    items: filtered.slice(start, start + size)
  });
}

// ─────────────────────────────────────────────────────────────
// 포털 C — 규정 포털형 (iframe 중첩 + 팝업 + PDF + EUC-KR)
// ─────────────────────────────────────────────────────────────

function portalCFrameset(): string {
  return page(
    '규정 포털',
    `<header>규정 포털</header>
     <main style="display:flex; gap:8px; height: 420px;">
       <iframe id="tree-frame" name="tree" title="분류 트리" src="app://portal-c/tree" style="width:240px;height:100%;border:1px solid #d5d5dd;"></iframe>
       <iframe id="list-frame" name="list" title="문서 목록" src="app://portal-c/list?category=인사규정" style="flex:1;height:100%;border:1px solid #d5d5dd;"></iframe>
     </main>`
  );
}

function portalCTree(): string {
  const categories = ['인사규정', '보안규정'];
  const items = categories
    .map(
      (category) =>
        `<li><a id="tree-${encodeURIComponent(category)}" href="app://portal-c/list?category=${encodeURIComponent(category)}" target="list">${esc(category)}</a></li>`
    )
    .join('');

  return page('분류', `<main><ul id="tree">${items}</ul></main>`);
}

function portalCList(category: string): string {
  const rows = RULES.filter((rule) => rule.category === category)
    .map(
      (rule) =>
        `<tr data-rule-id="${rule.id}">
           <td>${rule.id}</td>
           <td><a class="rule-link" href="app://portal-c/doc?id=${rule.id}" target="_blank"
                  onclick="window.open(this.href, '_blank'); return false;">${esc(rule.title)}</a></td>
           <td>${rule.legacyEncoding ? 'EUC-KR' : 'UTF-8'}</td>
         </tr>`
    )
    .join('');

  return page(
    `${category} 목록`,
    `<main>
       <h2 id="list-category">${esc(category)}</h2>
       <table id="rule-table">
         <thead><tr><th>번호</th><th>제목</th><th>인코딩</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </main>`
  );
}

/** UTF-8 문서. EUC-KR 문서는 별도 파일 바이트로 서비스한다. */
function portalCDoc(rule: Rule): string {
  return page(
    rule.title,
    `<header>규정 상세</header>
     <main>
       <h1 id="doc-title">${esc(rule.title)}</h1>
       <p id="doc-body">본문 ${rule.id}. 본 규정은 사내 문서 관리 기준을 정한다. 한글 본문 표식 확인용.</p>
       <p><a id="attachment" href="app://portal-c/attachment?id=${rule.id}" download>첨부: 규정 제${rule.id}호.pdf</a></p>
     </main>`
  );
}

// ─────────────────────────────────────────────────────────────
// 라우팅
// ─────────────────────────────────────────────────────────────

interface PortalContext {
  /** fixtures 디렉터리 절대 경로 */
  fixturesDir: string;
}

function hasValidSession(): boolean {
  return portalASessionValid;
}

function setSession(valid: boolean): void {
  portalASessionValid = valid;
}

function routePortalA(url: URL): Response {
  const route = url.pathname;

  if (route === '/login') return html(portalALogin(url.searchParams.get('next') ?? 'app://portal-a/list?page=1'));

  if (route === '/login-submit') {
    setSession(true);
    const next = url.searchParams.get('next') ?? 'app://portal-a/list?page=1';
    return redirect(next, '로그인되었습니다. 이동합니다.');
  }

  if (route === '/expire') {
    setSession(false);
    return redirect('app://portal-a/list?page=1', '세션을 만료시켰습니다.');
  }

  // 목록·상세는 세션이 있어야 본다. 없으면 로그인 페이지로 실제 이동시킨다.
  if (!hasValidSession()) {
    return redirect(
      `app://portal-a/login?next=${encodeURIComponent(url.toString())}`,
      '세션이 만료되었습니다.'
    );
  }

  if (route === '/' || route === '/list') {
    const requested = Number(url.searchParams.get('page') ?? '1');
    const pageNumber = Math.min(PORTAL_A.pages, Math.max(1, Number.isFinite(requested) ? requested : 1));
    return html(portalAList(pageNumber));
  }

  if (route === '/notice') {
    const body = portalANotice(Number(url.searchParams.get('id') ?? '0'));
    return body ? html(body) : notFound();
  }

  return notFound();
}

function routePortalB(url: URL): Response {
  if (url.pathname === '/' || url.pathname === '/incidents') return html(portalBApp());
  if (url.pathname === '/api/incidents') return portalBIncidents(url);
  return notFound();
}

function routePortalC(ctx: PortalContext, url: URL): Response {
  const route = url.pathname;

  if (route === '/' || route === '/index') return html(portalCFrameset());
  if (route === '/tree') return html(portalCTree());
  if (route === '/list') return html(portalCList(url.searchParams.get('category') ?? '인사규정'));

  if (route === '/doc') {
    const rule = RULES.find((item) => item.id === Number(url.searchParams.get('id') ?? '0'));
    if (!rule) return notFound();

    if (rule.legacyEncoding) {
      // EUC-KR 바이트를 그대로 내려보낸다. 인코딩 선언만 맞으면 Chromium 이 정상 디코딩한다.
      const file = path.join(ctx.fixturesDir, 'portals', 'portal-c-euckr.html');
      try {
        const bytes = fs.readFileSync(file);
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=EUC-KR' }
        });
      } catch (error) {
        console.error(`[PortalProtocol] EUC-KR 문서 읽기 실패 - 경로: ${file}`, error);
        return notFound();
      }
    }

    return html(portalCDoc(rule));
  }

  if (route === '/attachment') {
    const file = path.join(ctx.fixturesDir, 'sample.pdf');
    try {
      const bytes = fs.readFileSync(file);
      const id = url.searchParams.get('id') ?? '0';
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="rule-${id}.pdf"`
        }
      });
    } catch (error) {
      console.error(`[PortalProtocol] 첨부 읽기 실패 - 경로: ${file}`, error);
      return notFound();
    }
  }

  return notFound();
}

/** app:// 핸들러가 포털 host 요청을 이쪽으로 넘긴다. */
export function handlePortalRequest(ctx: PortalContext, host: string, url: URL): Response | null {
  if (host === 'portal-a') return routePortalA(url);
  if (host === 'portal-b') return routePortalB(url);
  if (host === 'portal-c') return routePortalC(ctx, url);
  return null;
}

/** 테스트가 세션 상태를 직접 만들 수 있게 노출한다. */
export const portalTestHooks = {
  setSession,
  hasValidSession,
  counts: {
    portalATotal: PORTAL_A_TOTAL,
    portalAPages: PORTAL_A.pages,
    portalBTotal: PORTAL_B.total,
    portalCDocs: PORTAL_C.docs
  }
};
