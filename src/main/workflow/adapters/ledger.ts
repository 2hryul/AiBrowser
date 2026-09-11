import { readXlsx, sheetToRecords } from '../xlsx/read';
import { AdapterBrokenError, type Adapter, type AdapterResult, type ToolContract } from '../Engine';
import type { ValueSource } from '../types';
import { parseTextTable, type PortalIo } from './io';

/**
 * 회계 시스템 어댑터 — 화면(dom)으로 읽고 파일(xlsx)로 대조한다.
 *
 * 이쪽에는 XHR 이 없다. 조회 버튼을 눌러 나온 서버 렌더링 표가 유일한 화면 출처이므로
 * 계약의 `source` 는 `dom` 이다. 그런데 같은 데이터를 xlsx 로도 주고, 파일에는 금액이
 * 숫자로 들어 있다 — 화면의 쉼표 서식보다 정확하다.
 *
 * 그래서 둘을 다 읽고 **금액이 다르면 값을 고르지 않는다**: 화면 행을 쓰되 `sourceConflict`
 * 를 달아 돌려준다. 워크플로우의 오라클이 그것을 보고 REVIEW/FAIL 을 낸다. 어댑터가
 * "파일이 더 정확하니 파일을 쓰자" 고 혼자 판단하면 두 시스템이 어긋난 사실이 사라진다.
 *
 * xlsx 다운로드가 안 되는 것은 깨진 것이 아니다(권한·네트워크). 화면 값만으로 진행하고
 * `file` 대조를 건너뛴 사실을 note 에 남긴다. 반대로 **화면 표의 머리글이 사라지면**
 * `ADAPTER_BROKEN` 이다.
 */

const HEADERS = ['전표번호', '거래번호', '공급사', '금액', '전표일자'] as const;

export const LEDGER_CONTRACT: ToolContract = {
  name: 'portal_ledger_daily',
  version: 1,
  input: ['date'],
  output: ['rows'],
  write: false,
  source: 'dom',
  pii: ['rows[].approver', 'rows[].approverNo']
};

export interface LedgerRowValue {
  voucherNo: string;
  txId: string;
  vendor: string;
  amount: string;
  date: string;
  /** 화면과 파일의 금액이 다른가 — 어댑터가 고르지 않고 표시만 한다 */
  sourceConflict?: { dom: string; file: string };
}

function rowsFromDom(text: string, stepId: string): LedgerRowValue[] {
  const table = parseTextTable(text, HEADERS);

  if (table === null) {
    throw new AdapterBrokenError(
      LEDGER_CONTRACT.name,
      `${stepId}: 회계 화면에서 표 머리글(${HEADERS.join('·')})을 찾을 수 없습니다`
    );
  }

  return table.map((row) => ({
    voucherNo: row['전표번호'] ?? '',
    txId: row['거래번호'] ?? '',
    vendor: row['공급사'] ?? '',
    amount: row['금액'] ?? '',
    date: row['전표일자'] ?? ''
  }));
}

/** 숫자든 쉼표 문자열이든 원 단위 정수로. 읽을 수 없으면 null. */
function toWon(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 파일의 거래번호 → 금액.
 * 0행은 병합된 제목(`2026-03-04 전표 목록`)이고 머리글은 1행이다.
 */
function amountsFromXlsx(buffer: Buffer): Map<string, number> {
  const workbook = readXlsx(buffer);
  const sheet = workbook.sheets[0];
  if (!sheet) throw new Error('xlsx 에 시트가 없습니다');

  const records = sheetToRecords(sheet, 1);
  const amounts = new Map<string, number>();

  for (const record of records) {
    const txId = String(record['거래번호'] ?? '').trim();
    const won = toWon(record['금액']);
    if (txId !== '' && won !== null) amounts.set(txId, won);
  }

  return amounts;
}

export function createLedgerAdapter(io: PortalIo): Adapter {
  return {
    contract: LEDGER_CONTRACT,

    async run(context): Promise<AdapterResult> {
      const date = String(context.args['date'] ?? context.inputs['date'] ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`회계 어댑터: 날짜 형식이 아닙니다 (${date})`);
      }

      // q=1 이 없으면 표가 그려지지 않는다 — 폼을 채우고 조회를 눌러야 한다.
      const tabId = await io.open(`app://portal-h-ledger/?date=${encodeURIComponent(date)}`);
      await io.click(tabId, '조회', 'button');
      await io.wait(200);

      const rows = rowsFromDom(await io.text(tabId), context.stepId);
      const screenshot = await io.screenshot(tabId, `${context.stepId}-ledger`);
      const shot = screenshot === null ? {} : { screenshot };

      // 화면 행의 전표일자가 요청 날짜와 다르면 조회가 안 먹은 것이다.
      const wrongDate = rows.find((row) => row.date !== date);
      if (wrongDate) {
        throw new AdapterBrokenError(
          LEDGER_CONTRACT.name,
          `${context.stepId}: 요청 ${date} 인데 화면에 ${wrongDate.date} 전표가 있습니다`
        );
      }

      let fileAmounts: Map<string, number> | null = null;
      let fileNote = '';

      try {
        const file = await io.download(tabId, `app://portal-h-ledger/download.xlsx?date=${encodeURIComponent(date)}`);
        fileAmounts = amountsFromXlsx(await io.readFile(file.savePath));
        fileNote = `xlsx ${fileAmounts.size}건 대조`;
      } catch (error) {
        // 파일을 못 받는 것은 깨진 것이 아니다. 대조만 건너뛴다.
        fileNote = `xlsx 대조 건너뜀 — ${(error as Error).message}`;
      }

      let conflicts = 0;

      if (fileAmounts) {
        for (const row of rows) {
          const fromFile = fileAmounts.get(row.txId);
          const fromDom = toWon(row.amount);
          if (fromFile === undefined || fromDom === null) continue;

          if (fromFile !== fromDom) {
            conflicts += 1;
            row.sourceConflict = { dom: String(fromDom), file: String(fromFile) };
          }
        }
      }

      return {
        value: rows,
        // 값 자체는 화면에서 왔다. 파일은 대조용이므로 출처를 올리지 않는다.
        source: 'dom' satisfies ValueSource,
        raw: {
          rows,
          file: fileAmounts === null ? null : Object.fromEntries(fileAmounts),
          conflicts
        },
        note:
          conflicts === 0
            ? `회계 화면 ${rows.length}건 · ${fileNote}`
            : `회계 화면 ${rows.length}건 · ${fileNote} · 화면↔파일 금액 불일치 ${conflicts}건`,
        ...shot
      };
    }
  };
}
