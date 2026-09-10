import { zipRead } from './zip';

/**
 * 최소 xlsx 읽기 — "Excel 다운로드" 파일에서 표를 꺼낸다.
 *
 * 세 가지를 제대로 다루는 것이 목적이다(성공 조건 6):
 *   - **천단위 콤마**: 저장된 값은 숫자다. 서식(`#,##0`)은 화면 표시일 뿐이므로 **숫자로** 읽는다.
 *     문자열 `"1,250,000"` 을 돌려주면 대사 쪽에서 다시 파싱해야 하고, 그 과정에서 실수가 난다.
 *   - **날짜 서식**: 값은 1900 기준 일련번호다. 서식이 날짜면 `YYYY-MM-DD` 로 바꿔 돌려준다.
 *   - **병합 셀**: 값은 왼쪽 위 칸에만 있다. `valueAt` 이 병합 범위를 풀어 준다.
 *
 * 정규식으로 XML 을 훑는다. 일반적으로 나쁜 방법이지만 여기 들어오는 XML 은 우리가 아는
 * SpreadsheetML 조각이고, XML 파서를 의존성으로 들이지 않는 편이 라이선스·공급망 면에서 낫다.
 * 예상 밖 구조는 조용히 무시하지 않고 `XlsxError` 로 던진다.
 */

export class XlsxError extends Error {
  constructor(message: string) {
    super(`[xlsx] ${message}`);
    this.name = 'XlsxError';
  }
}

export type CellType = 'string' | 'number' | 'date' | 'empty';

export interface Cell {
  /** `A1` 꼴 주소 */
  ref: string;
  /** 0-기반 */
  row: number;
  column: number;
  type: CellType;
  value: string | number | null;
  /** 날짜 서식이면 `YYYY-MM-DD` */
  text: string;
}

export interface Sheet {
  name: string;
  /** 행 → 열 순서의 2차원 배열(빈 칸은 null) */
  grid: (Cell | null)[][];
  merges: { ref: string; top: number; left: number; bottom: number; right: number }[];
  rowCount: number;
  columnCount: number;
  /**
   * 병합을 풀어 값을 읽는다. 병합 범위 안의 칸은 왼쪽 위 값을 돌려준다 —
   * 사람이 화면에서 보는 것과 같게.
   */
  valueAt: (row: number, column: number) => Cell | null;
}

export interface Workbook {
  sheets: Sheet[];
  /** 첫 시트 */
  sheet: Sheet;
}

/** 내장 날짜 서식 id. 사용자 정의(164+)는 formatCode 로 판단한다. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** `A1` → {row: 0, column: 0} */
export function parseRef(ref: string): { row: number; column: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) throw new XlsxError(`셀 주소를 읽을 수 없습니다: ${ref}`);

  const letters = match[1] as string;
  let column = 0;
  for (const char of letters) column = column * 26 + (char.charCodeAt(0) - 64);

  return { row: Number(match[2]) - 1, column: column - 1 };
}

/** Excel 일련번호 → `YYYY-MM-DD` */
export function serialToDate(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial) * 86_400_000);

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 공유 문자열 표. rich text(`<r><t>`)는 조각을 이어 붙인다. */
function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];

  const strings: string[] = [];
  const items = xml.match(/<si\b[\s\S]*?<\/si>|<si\s*\/>/g) ?? [];

  for (const item of items) {
    const parts = item.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    const text = parts
      .map((part) => /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(part)?.[1] ?? '')
      .join('');
    strings.push(unescapeXml(text));
  }

  return strings;
}

/** 스타일 인덱스 → 날짜 서식인지. `s` 속성이 이 배열을 가리킨다. */
function readDateStyles(xml: string | undefined): boolean[] {
  if (!xml) return [];

  const customDateFormats = new Set<number>();
  for (const entry of xml.match(/<numFmt\b[^>]*\/>/g) ?? []) {
    const id = Number(/numFmtId="(\d+)"/.exec(entry)?.[1] ?? '-1');
    const code = /formatCode="([^"]*)"/.exec(entry)?.[1] ?? '';

    // 서식 문자열에 연·월·일 기호가 있으면 날짜다. 색·리터럴은 무시한다.
    const stripped = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    if (/[yYdD]/.test(stripped) || /\bmmm/i.test(stripped)) customDateFormats.add(id);
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const styles: boolean[] = [];

  for (const xf of cellXfs.match(/<xf\b[^>]*\/?>/g) ?? []) {
    const id = Number(/numFmtId="(\d+)"/.exec(xf)?.[1] ?? '0');
    styles.push(BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id));
  }

  return styles;
}

export function readXlsx(buffer: Buffer): Workbook {
  const files = zipRead(buffer);

  const workbookXml = files.get('xl/workbook.xml')?.toString('utf-8');
  if (!workbookXml) throw new XlsxError('xl/workbook.xml 이 없습니다 — xlsx 가 아닙니다');

  const shared = readSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf-8'));
  const dateStyles = readDateStyles(files.get('xl/styles.xml')?.toString('utf-8'));

  const names = (workbookXml.match(/<sheet\b[^>]*\/?>/g) ?? []).map(
    (entry) => unescapeXml(/name="([^"]*)"/.exec(entry)?.[1] ?? '시트')
  );

  const sheets: Sheet[] = [];

  for (let index = 0; index < Math.max(names.length, 1); index += 1) {
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const sheetXml = files.get(path)?.toString('utf-8');
    if (!sheetXml) continue;

    sheets.push(readSheet(names[index] ?? `시트${index + 1}`, sheetXml, shared, dateStyles));
  }

  const first = sheets[0];
  if (!first) throw new XlsxError('시트를 하나도 읽지 못했습니다');

  return { sheets, sheet: first };
}

function readSheet(
  name: string,
  xml: string,
  shared: string[],
  dateStyles: boolean[]
): Sheet {
  const cells: Cell[] = [];

  for (const raw of xml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
    const ref = /r="([A-Z]+\d+)"/.exec(raw)?.[1];
    if (!ref) continue;

    const { row, column } = parseRef(ref);
    const type = /t="([^"]*)"/.exec(raw)?.[1] ?? 'n';
    const styleIndex = Number(/s="(\d+)"/.exec(raw)?.[1] ?? '-1');

    // 인라인 문자열과 공유 문자열, 그리고 숫자를 각각 다르게 꺼낸다.
    let value: string | number | null = null;
    let cellType: CellType = 'empty';
    let text = '';

    if (type === 'inlineStr') {
      const inline = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(raw)?.[1] ?? '';
      value = unescapeXml(inline);
      cellType = 'string';
      text = value;
    } else {
      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(raw)?.[1];
      if (rawValue === undefined) {
        cells.push({ ref, row, column, type: 'empty', value: null, text: '' });
        continue;
      }

      if (type === 's') {
        const shareIndex = Number(rawValue);
        value = shared[shareIndex] ?? '';
        cellType = 'string';
        text = String(value);
      } else if (type === 'str') {
        value = unescapeXml(rawValue);
        cellType = 'string';
        text = String(value);
      } else {
        const numeric = Number(rawValue);
        if (Number.isNaN(numeric)) {
          throw new XlsxError(`${ref}: 숫자로 읽을 수 없는 값 "${rawValue}"`);
        }

        if (dateStyles[styleIndex] === true) {
          cellType = 'date';
          text = serialToDate(numeric);
          value = numeric;
        } else {
          cellType = 'number';
          value = numeric;
          text = String(numeric);
        }
      }
    }

    cells.push({ ref, row, column, type: cellType, value, text });
  }

  const merges = (xml.match(/<mergeCell\b[^>]*\/?>/g) ?? []).map((entry) => {
    const ref = /ref="([^"]*)"/.exec(entry)?.[1] ?? '';
    const [from, to] = ref.split(':');
    const start = parseRef(from ?? 'A1');
    const end = parseRef(to ?? from ?? 'A1');
    return {
      ref,
      top: start.row,
      left: start.column,
      bottom: end.row,
      right: end.column
    };
  });

  const rowCount = cells.reduce((max, cell) => Math.max(max, cell.row + 1), 0);
  const columnCount = cells.reduce((max, cell) => Math.max(max, cell.column + 1), 0);

  const grid: (Cell | null)[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => null)
  );
  for (const cell of cells) {
    const line = grid[cell.row];
    if (line) line[cell.column] = cell;
  }

  const valueAt = (row: number, column: number): Cell | null => {
    const direct = grid[row]?.[column] ?? null;
    if (direct && direct.type !== 'empty') return direct;

    // 병합 범위 안이면 왼쪽 위 값이 그 칸의 값이다.
    const merge = merges.find(
      (item) => row >= item.top && row <= item.bottom && column >= item.left && column <= item.right
    );
    if (!merge) return direct;

    return grid[merge.top]?.[merge.left] ?? direct;
  };

  return { name, grid, merges, rowCount, columnCount, valueAt };
}

/**
 * 표를 객체 배열로. `headerRow` 의 셀 문구를 키로 쓴다.
 * 병합된 제목 행이 위에 있는 파일이 많아 헤더 행 번호를 받는다.
 */
export function sheetToRecords(sheet: Sheet, headerRow: number): Record<string, string>[] {
  const headers: string[] = [];

  for (let column = 0; column < sheet.columnCount; column += 1) {
    headers.push(sheet.valueAt(headerRow, column)?.text.trim() ?? '');
  }

  const records: Record<string, string>[] = [];

  for (let row = headerRow + 1; row < sheet.rowCount; row += 1) {
    const record: Record<string, string> = {};
    let filled = 0;

    headers.forEach((header, column) => {
      if (header === '') return;
      const cell = sheet.grid[row]?.[column] ?? null;
      const text = cell?.text ?? '';
      record[header] = text;
      if (text !== '') filled += 1;
    });

    if (filled > 0) records.push(record);
  }

  return records;
}
