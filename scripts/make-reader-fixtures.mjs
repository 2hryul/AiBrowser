/**
 * 읽기 모드 골든 fixture 생성기.
 * 본문 마크업 형태만 다르고 본문 텍스트는 같은 5종을 만든다.
 * 추출기가 마크업 모양에 흔들리지 않는지 보기 위한 것이므로 생성 스크립트로 둔다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'fixtures', 'reader');

/** 본문 문단 — 각 문단이 충분히 길어야 readability 가 본문으로 인정한다. */
const BODY = [
  '본문표식알파 보관 기간 산정 기준을 문서 생성일에서 최종 열람일로 바꾼다. 기존 방식은 실제로 참조되는 문서까지 일괄 폐기 대상으로 분류해 업무 공백을 만들었다. 개정 이후에는 마지막 열람 시점부터 3년을 보관하며 기간 내 재열람 시 갱신된다.',
  '본문표식베타 부서 단위로 보관 책임자를 지정한다. 작성자 개인에게 책임이 묶여 있으면 조직을 떠날 때 책임 주체가 사라진다. 인사 이동 시 후임자에게 목록을 인계하고, 인계 목록은 분기 말에 시스템이 자동으로 만든다.',
  '본문표식감마 전자문서와 종이문서의 이중 보관을 금지한다. 같은 내용을 두 매체로 남기면 최신본 판단이 어렵고 폐기 시점이 어긋난다. 원본이 전자문서면 출력물을 즉시 폐기하고, 종이가 원본이면 스캔본을 정본으로 등록한다.',
  '본문표식델타 개인정보가 포함된 문서는 별도 등급으로 분류한다. 등급 문서는 열람 이력이 자동 기록되고 보관 기간이 만료되면 담당자 확인 없이 폐기된다. 폐기 결과는 매월 정보보호 담당자에게 보고된다.'
];

/** 본문에 절대 섞이면 안 되는 잡동사니 — 광고·내비·댓글·스크립트 */
const NOISE = {
  ad: '<div class="advertisement" id="ad-slot"><a href="/promo">잡동사니광고 지금 신청하면 사은품</a></div>',
  nav: '<nav id="global-nav"><a href="/">홈</a><a href="/notice">공지</a><a href="/help">도움말</a></nav>',
  comments:
    '<section id="comments"><h3>댓글</h3><ul><li>잡동사니댓글 첫 번째 의견입니다</li><li>잡동사니댓글 두 번째 의견입니다</li></ul></section>',
  script: '<script>window.__t = "잡동사니스크립트";</script>',
  footer: '<footer id="site-footer"><p>잡동사니푸터 회사 소개 및 약관</p></footer>'
};

const paragraphs = (tag = 'p') => BODY.map((t) => `<${tag}>${t}</${tag}>`).join('\n      ');

/** 마크업 형태별 5종. key 가 파일명이 된다. */
const CASES = {
  // 1) 표준: <article> 안에 본문
  'semantic-article': `
    ${NOISE.nav}
    ${NOISE.ad}
    <article>
      <h1>보관 규정 개정</h1>
      ${paragraphs()}
    </article>
    ${NOISE.comments}
    ${NOISE.footer}
    ${NOISE.script}`,

  // 2) <main> + 중첩 div
  'main-nested-div': `
    ${NOISE.nav}
    <main>
      <div class="wrap"><div class="inner"><div class="body">
        <h1>보관 규정 개정</h1>
        ${paragraphs()}
      </div></div></div>
    </main>
    ${NOISE.ad}
    ${NOISE.footer}`,

  // 3) 시맨틱 태그 없음 — div.content 만
  'plain-div-content': `
    ${NOISE.ad}
    <div id="header">사내 포털</div>
    <div class="content">
      <h1>보관 규정 개정</h1>
      ${paragraphs()}
    </div>
    ${NOISE.comments}`,

  // 4) 레거시 테이블 레이아웃 (사내 구형 포털에서 흔한 모양)
  'legacy-table': `
    <table width="100%"><tr>
      <td width="200">${NOISE.nav}</td>
      <td>
        <h1>보관 규정 개정</h1>
        ${paragraphs('div')}
      </td>
      <td width="150">${NOISE.ad}</td>
    </tr></table>
    ${NOISE.footer}`,

  // 5) iframe·사이드바가 섞인 형태
  'iframe-sidebar': `
    ${NOISE.nav}
    <iframe src="about:blank" title="배너"></iframe>
    <aside class="sidebar"><ul><li>잡동사니사이드 관련 문서 1</li><li>잡동사니사이드 관련 문서 2</li></ul></aside>
    <article>
      <h1>보관 규정 개정</h1>
      ${paragraphs()}
    </article>
    ${NOISE.ad}
    ${NOISE.script}`
};

mkdirSync(OUT, { recursive: true });

for (const [name, body] of Object.entries(CASES)) {
  const html = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>보관 규정 개정 — ${name}</title>
  </head>
  <body>${body}
  </body>
</html>
`;
  writeFileSync(path.join(OUT, `${name}.html`), html, 'utf-8');
}

writeFileSync(
  path.join(OUT, 'expected.json'),
  `${JSON.stringify(
    {
      cases: Object.keys(CASES),
      // 추출 결과에 반드시 있어야 하는 표식
      mustContain: ['본문표식알파', '본문표식베타', '본문표식감마', '본문표식델타'],
      // 절대 섞이면 안 되는 표식
      mustNotContain: [
        '잡동사니광고',
        '잡동사니댓글',
        '잡동사니스크립트',
        '잡동사니푸터',
        '잡동사니사이드'
      ]
    },
    null,
    2
  )}\n`,
  'utf-8'
);

console.warn(`[make-reader-fixtures] ${Object.keys(CASES).length}건 생성: ${OUT}`);
