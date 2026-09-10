/**
 * 모의 포털이 공유하는 HTML·응답 헬퍼.
 *
 * 포털이 늘어나면서(A·B·C·D·F·billing 에 이어 M4a 의 E·G) 한 파일에 다 담으면 읽기 어려워진다.
 * 껍데기와 응답 만들기만 여기로 빼고, 포털별 데이터·라우팅은 각 모듈이 갖는다.
 * 순환 import 를 피하려고 이 파일은 아무것도 import 하지 않는다.
 */

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 사내 포털 특유의 밋밋한 껍데기. 스크래핑 난관은 구조에서 오지 재주에서 오지 않는다. */
export function page(title: string, body: string, extraHead = ''): string {
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

export function html(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders }
  });
}

export function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
}
