import { esc, html, json, notFound, page } from './html';
import { SETTLE_DATES, settleRows } from './settleData';

/**
 * 포털 H-1 — 정산 포털형. 대사(reconciliation)의 한쪽이다.
 *
 * 재현하는 난관:
 *   - **날짜 입력 → 조회**: 주소만으로는 데이터가 오지 않는다. 폼을 채우고 눌러야 한다
 *   - **`/api/settlements?date=` JSON 그리드**: 화면은 표를 그리지만 진짜 출처는 XHR 응답이다
 *     → 어댑터가 `source: 'network'` 로 얻어야 하는 곳
 *   - **API 를 끌 수 있다**: `?api=off` 를 주면 XHR 이 실패하고 화면만 남는다
 *     → 어댑터가 `dom` 으로 폴백하는지 보는 스위치(성공 조건 5)
 *
 * 금액은 쉼표가 붙은 문자열로 준다(이유는 settleData.ts 주석 참고).
 */

/** API 를 끈 상태 — 어댑터 사다리 폴백을 시험하는 스위치. 테스트만 건드린다. */
let apiEnabled = true;

export function setSettleApi(enabled: boolean): void {
  apiEnabled = enabled;
}

export function isSettleApiEnabled(): boolean {
  return apiEnabled;
}

function knownDate(date: string): boolean {
  return SETTLE_DATES.includes(date);
}

/**
 * 조회 화면.
 *
 * 표는 XHR 결과로 그린다. `api=off` 면 XHR 이 503 을 받아 표를 못 그리고,
 * 대신 서버가 미리 심어 둔 `<noscript>` 성격의 정적 표(`#fallback-table`)만 남는다 —
 * 실제 사내 시스템에도 이런 이중 렌더링이 흔하다.
 */
function settleIndex(date: string): string {
  const rows = knownDate(date) ? settleRows(date) : [];

  const fallbackRows = rows
    .map(
      (row) => `<tr data-tx="${esc(row.txId)}">
        <td class="tx-id">${esc(row.txId)}</td>
        <td class="tx-vendor">${esc(row.vendor)}</td>
        <td class="tx-amount">${esc(row.amount)}</td>
        <td class="tx-approver">${esc(row.approver)}</td>
      </tr>`
    )
    .join('\n');

  return page(
    '정산 포털 — 일별 정산',
    `<header>정산 포털</header>
     <main>
       <form id="query-form" onsubmit="return false;">
         <label>정산일 <input id="query-date" name="date" type="text" value="${esc(date)}" /></label>
         <button id="query-button" type="button">조회</button>
       </form>
       <p id="query-status">조회 전</p>

       <table id="settle-table">
         <thead><tr><th>거래번호</th><th>공급사</th><th>정산금액</th><th>결재자</th></tr></thead>
         <tbody id="settle-body"></tbody>
       </table>

       <details id="fallback">
         <summary>서버 렌더링 표(스크립트 없이 보는 화면)</summary>
         <table id="fallback-table">
           <thead><tr><th>거래번호</th><th>공급사</th><th>정산금액</th><th>결재자</th></tr></thead>
           <tbody>${fallbackRows}</tbody>
         </table>
       </details>
     </main>
     <script>
       const status = document.getElementById('query-status');

       async function query() {
         const date = document.getElementById('query-date').value;
         status.textContent = '조회 중';

         try {
           const response = await fetch('app://portal-h-settle/api/settlements?date=' + encodeURIComponent(date));
           if (!response.ok) throw new Error('HTTP ' + response.status);

           const data = await response.json();
           document.getElementById('settle-body').innerHTML = data.rows
             .map((row) =>
               '<tr data-tx="' + row.txId + '">' +
               '<td class="tx-id">' + row.txId + '</td>' +
               '<td class="tx-vendor">' + row.vendor + '</td>' +
               '<td class="tx-amount">' + row.amount + '</td>' +
               '<td class="tx-approver">' + row.approver + '</td>' +
               '</tr>'
             )
             .join('');
           status.textContent = '조회 완료 ' + data.rows.length + '건';
         } catch (error) {
           // API 가 꺼진 상태. 화면은 비고, 정적 표만 남는다.
           document.getElementById('settle-body').innerHTML = '';
           status.textContent = '조회 실패 — 정산 API 응답 없음';
           document.getElementById('fallback').open = true;
         }
       }

       document.getElementById('query-button').addEventListener('click', query);
     </script>`
  );
}

export function routePortalSettle(url: URL): Response {
  const route = url.pathname;

  if (route === '/' || route === '/index') {
    return html(settleIndex(url.searchParams.get('date') ?? SETTLE_DATES[0] ?? ''));
  }

  if (route === '/api/settlements') {
    if (!apiEnabled) {
      // 어댑터가 dom 으로 내려가야 하는 상황. 503 이면 "깨진 것" 이 아니라 "지금 못 쓰는 것" 이다.
      return new Response(JSON.stringify({ error: 'service unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    const date = url.searchParams.get('date') ?? '';
    if (!knownDate(date)) return json({ date, rows: [], total: 0 });

    const rows = settleRows(date);
    return json({ date, total: rows.length, rows });
  }

  return notFound();
}
