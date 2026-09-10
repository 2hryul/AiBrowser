import { esc, html, json, notFound, page } from './html';

/**
 * 포털 E — 사내 위키형. 장시간 작업(중단·재개)의 시험대다.
 *
 * 재현하는 난관:
 *   - **지연 로딩 트리**: 목차가 한 번에 오지 않는다. 섹션을 펼칠 때 XHR 로 자식이 온다.
 *     그래서 "전체 목록"을 한 번에 얻을 수 없고, 순회 진행 상태를 스스로 기억해야 한다.
 *   - **400 페이지**: 한 번에 끝낼 수 없는 분량. 중간에 앱이 죽으면 체크포인트에서 이어야 한다.
 *   - **깨진 링크 30개 / 구 도메인 링크 20개**: 결함 목록을 만드는 것이 작업 목표다.
 *
 * 결함이 **겹치는 페이지가 하나 있다**(id 260 — 13과 20의 공배수). 결함을 페이지 단위로 세면
 * 49건, 결함 단위로 세면 50건이다. 성공 조건은 50건이므로 수집기가 결함 단위로 세야 맞는다.
 */

export const PORTAL_E = {
  sections: 20,
  pagesPerSection: 20,
  /** 깨진 링크를 가진 페이지: id % 13 === 0 → 13·26·…·390 = 30개 */
  brokenEvery: 13,
  /** 구 도메인 링크를 가진 페이지: id % 20 === 0 → 20·40·…·400 = 20개 */
  legacyEvery: 20
} as const;

export const PORTAL_E_TOTAL = PORTAL_E.sections * PORTAL_E.pagesPerSection;

/** 구 도메인. 실제로 접속되지 않아야 한다 — 결함으로 보고만 한다. */
const LEGACY_HOST = 'wiki.old-intra.example.co.kr';

const TOPICS = [
  '결재 규정',
  '보안 지침',
  '휴가 신청',
  '경비 처리',
  '자산 관리',
  '출입 통제',
  '개발 표준',
  '장애 대응',
  '외주 계약',
  '교육 과정'
];

export interface WikiDefect {
  pageId: number;
  kind: 'broken' | 'legacy';
  href: string;
}

function sectionOf(id: number): number {
  return Math.floor((id - 1) / PORTAL_E.pagesPerSection) + 1;
}

function titleOf(id: number): string {
  const topic = TOPICS[(id - 1) % TOPICS.length] ?? '문서';
  return `${topic} v${sectionOf(id)}.${((id - 1) % PORTAL_E.pagesPerSection) + 1}`;
}

/** 이 페이지가 가진 결함. 페이지 하나가 둘 다 가질 수 있다. */
function defectsOf(id: number): WikiDefect[] {
  const found: WikiDefect[] = [];

  if (id % PORTAL_E.brokenEvery === 0) {
    // 존재하지 않는 문서를 가리킨다 → 404
    found.push({ pageId: id, kind: 'broken', href: `app://portal-e/page?id=${id + 10_000}` });
  }
  if (id % PORTAL_E.legacyEvery === 0) {
    found.push({ pageId: id, kind: 'legacy', href: `http://${LEGACY_HOST}/wiki/${id}` });
  }

  return found;
}

/** 전체 결함 목록 — 테스트가 기대값으로 쓴다. */
export function allDefects(): WikiDefect[] {
  const out: WikiDefect[] = [];
  for (let id = 1; id <= PORTAL_E_TOTAL; id += 1) out.push(...defectsOf(id));
  return out;
}

// ─────────────────────────────────────────────────────────────
// 화면
// ─────────────────────────────────────────────────────────────

/**
 * 목차. 섹션 제목만 서버 렌더링하고 자식은 펼칠 때 가져온다.
 * `read_network_requests` 로 `/tree` 응답을 모으는 편이 DOM 을 긁는 것보다 빠르다.
 */
function wikiIndex(): string {
  const sections = Array.from({ length: PORTAL_E.sections }, (_unused, index) => {
    const n = index + 1;
    return `<li>
      <button class="section-toggle" data-section="${n}" aria-expanded="false">${n}장 ${esc(
        TOPICS[index % TOPICS.length] ?? '문서'
      )}</button>
      <ul class="section-children" id="section-${n}" hidden></ul>
    </li>`;
  }).join('\n');

  return page(
    '사내 위키 — 목차',
    `<header>사내 위키</header>
     <main>
       <p id="total-hint">전체 ${PORTAL_E_TOTAL}개 문서 · ${PORTAL_E.sections}개 장</p>
       <ul id="toc">${sections}</ul>
       <p id="loaded-count">펼친 장 0개</p>
     </main>
     <script>
       let opened = 0;
       document.querySelectorAll('.section-toggle').forEach((button) => {
         button.addEventListener('click', async () => {
           const section = button.getAttribute('data-section');
           const list = document.getElementById('section-' + section);
           if (button.getAttribute('aria-expanded') === 'true') {
             button.setAttribute('aria-expanded', 'false');
             list.hidden = true;
             return;
           }

           // 지연 로딩: 펼칠 때마다 서버에 묻는다.
           const response = await fetch('app://portal-e/tree?section=' + section);
           const data = await response.json();
           list.innerHTML = data.pages
             .map((item) => '<li><a class="wiki-link" href="app://portal-e/page?id=' + item.id + '">' + item.title + '</a></li>')
             .join('');
           list.hidden = false;
           button.setAttribute('aria-expanded', 'true');
           opened += 1;
           document.getElementById('loaded-count').textContent = '펼친 장 ' + opened + '개';
         });
       });
     </script>`
  );
}

function wikiPage(id: number): string {
  const defects = defectsOf(id);
  const related = [id - 1, id + 1].filter((other) => other >= 1 && other <= PORTAL_E_TOTAL);

  const defectLinks = defects
    .map(
      (defect) =>
        `<li><a class="defect-link" data-defect="${defect.kind}" href="${esc(defect.href)}">${
          defect.kind === 'broken' ? '관련 문서(이동 불가)' : '구 위키 원문'
        }</a></li>`
    )
    .join('\n');

  return page(
    titleOf(id),
    `<header>사내 위키 — ${esc(titleOf(id))}</header>
     <main>
       <h1 id="doc-title">${esc(titleOf(id))}</h1>
       <p id="doc-id">문서번호 W-${String(id).padStart(4, '0')}</p>
       <p id="doc-section">${sectionOf(id)}장</p>
       <p>이 문서는 ${esc(titleOf(id))} 에 관한 사내 규정을 설명한다. 개정 이력은 하단을 참고한다.</p>
       <ul id="links">
         ${related
           .map(
             (other) =>
               `<li><a class="wiki-link" href="app://portal-e/page?id=${other}">${esc(
                 titleOf(other)
               )}</a></li>`
           )
           .join('\n')}
         ${defectLinks}
       </ul>
       <p><a id="to-index" href="app://portal-e/">목차로</a></p>
     </main>`
  );
}

export function routePortalE(url: URL): Response {
  const route = url.pathname;

  if (route === '/' || route === '/index') return html(wikiIndex());

  if (route === '/tree') {
    const section = Number(url.searchParams.get('section') ?? '0');
    if (!Number.isInteger(section) || section < 1 || section > PORTAL_E.sections) {
      return json({ section, pages: [] });
    }

    const first = (section - 1) * PORTAL_E.pagesPerSection + 1;
    const pages = Array.from({ length: PORTAL_E.pagesPerSection }, (_unused, index) => {
      const id = first + index;
      return { id, title: titleOf(id) };
    });

    return json({ section, pages });
  }

  if (route === '/page') {
    const id = Number(url.searchParams.get('id') ?? '0');
    // 10000 을 넘는 id 는 깨진 링크가 가리키는 곳이다. 404 가 정답이다.
    if (!Number.isInteger(id) || id < 1 || id > PORTAL_E_TOTAL) return notFound();
    return html(wikiPage(id));
  }

  return notFound();
}

/** 테스트가 기대값을 얻는 통로. */
export const portalEHooks = {
  total: PORTAL_E_TOTAL,
  sections: PORTAL_E.sections,
  defects: allDefects,
  defectCounts: (): { broken: number; legacy: number; total: number } => {
    const defects = allDefects();
    return {
      broken: defects.filter((defect) => defect.kind === 'broken').length,
      legacy: defects.filter((defect) => defect.kind === 'legacy').length,
      total: defects.length
    };
  }
};
