import { buildXlsx } from '../../workflow/xlsx/write';
import { esc, html, notFound, page } from './html';
import { SETTLE_DATES, ledgerRows } from './settleData';

/**
 * 포털 H-2 — 회계 시스템형. 대사의 다른 한쪽이다.
 *
 * 재현하는 난관:
 *   - **날짜 입력 → 조회 → 서버 렌더링 표**: XHR 이 없다. 화면(DOM)이 유일한 출처다
 *     → 어댑터가 `source: 'dom'` 으로 얻어야 하는 곳
 *   - **"Excel 다운로드"**: 같은 데이터를 xlsx 로도 준다. 제목 행이 병합돼 있고 금액은
 *     천단위 서식, 날짜는 날짜 서식이다 — 화면보다 파일이 정확한 경우가 많다
 *
 * 정산 포털과 **같아야 하지만 다른** 6일치가 여기 반영되어 있다(settleData.ts 의 PLANTED).
 */

function knownDate(date: string): boolean {
  return SETTLE_DATES.includes(date);
}

function ledgerIndex(date: string, queried: boolean): string {
  const rows = queried && knownDate(date) ? ledgerRows(date) : [];

  const body = rows
    .map(
      (row) => `<tr data-voucher="${esc(row.voucherNo)}">
        <td class="ledger-voucher">${esc(row.voucherNo)}</td>
        <td class="ledger-tx">${esc(row.txId)}</td>
        <td class="ledger-vendor">${esc(row.vendor)}</td>
        <td class="ledger-amount">${esc(row.amount)}</td>
        <td class="ledger-date">${esc(row.date)}</td>
      </tr>`
    )
    .join('\n');

  return page(
    '회계 시스템 — 전표 조회',
    `<header>회계 시스템</header>
     <main>
       <form id="ledger-form" method="get" action="app://portal-h-ledger/">
         <label>전표일자 <input id="ledger-date" name="date" type="text" value="${esc(date)}" /></label>
         <input type="hidden" name="q" value="1" />
         <button id="ledger-query" type="submit">조회</button>
       </form>

       <p id="ledger-status">${queried ? `조회 완료 ${rows.length}건` : '조회 전'}</p>

       <table id="ledger-table">
         <thead>
           <tr><th>전표번호</th><th>거래번호</th><th>공급사</th><th>금액</th><th>전표일자</th></tr>
         </thead>
         <tbody id="ledger-body">${body}</tbody>
       </table>

       <p>
         <a id="ledger-download" href="app://portal-h-ledger/download.xlsx?date=${esc(date)}" download>
           Excel 다운로드
         </a>
       </p>
     </main>`
  );
}

/** 화면과 같은 데이터를 xlsx 로. 제목 행은 병합, 금액은 숫자 + 천단위 서식, 날짜는 날짜 서식. */
function ledgerWorkbook(date: string): Buffer {
  const rows = ledgerRows(date);

  return buildXlsx({
    name: '전표',
    rows: [
      [`${date} 전표 목록`, null, null, null, null],
      ['전표번호', '거래번호', '공급사', '금액', '전표일자'],
      ...rows.map((row) => [
        row.voucherNo,
        row.txId,
        row.vendor,
        // 파일에는 숫자로 넣는다 — 화면의 쉼표는 서식일 뿐이다.
        Number(row.amount.replace(/,/g, '')),
        { date: row.date }
      ])
    ],
    merges: ['A1:E1'],
    columnFormats: { 3: 'money', 4: 'date' }
  });
}

export function routePortalLedger(url: URL): Response {
  const route = url.pathname;

  if (route === '/' || route === '/index') {
    const date = url.searchParams.get('date') ?? SETTLE_DATES[0] ?? '';
    // 조회 버튼을 눌러야(q=1) 표가 나온다 — 주소만으로는 아무것도 없다.
    return html(ledgerIndex(date, url.searchParams.get('q') === '1'));
  }

  if (route === '/download.xlsx') {
    const date = url.searchParams.get('date') ?? '';
    if (!knownDate(date)) return notFound();

    const buffer = ledgerWorkbook(date);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="ledger-${date}.xlsx"`
      }
    });
  }

  return notFound();
}
