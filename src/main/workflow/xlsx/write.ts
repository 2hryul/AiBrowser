import { zipWrite, type ZipEntry } from './zip';

/**
 * 최소 xlsx 쓰기 — 모의 포털의 "Excel 다운로드" 를 만든다.
 *
 * 실제 회계 시스템이 내려주는 파일의 특징 세 가지를 재현한다(성공 조건 6 의 골든 3건):
 *   - **병합 셀**: 제목 행이 여러 열에 걸친다
 *   - **천단위 콤마**: 값은 숫자인데 서식만 `#,##0` 이다 — 읽을 때 숫자가 나와야 한다
 *   - **날짜 서식**: 값은 1900 기준 일련번호이고 서식이 `yyyy-mm-dd` 다
 *
 * 문자열은 `sharedStrings.xml` 로 넣는다. 실제 파일이 그렇게 생겼고, 읽기 쪽의
 * 공유 문자열 경로가 실제로 검증되어야 하기 때문이다.
 */

export type CellValue = string | number | { date: string } | null;

export interface SheetSpec {
  name: string;
  /** 행 배열. 각 행은 셀 값 배열. */
  rows: CellValue[][];
  /** `A1:C1` 꼴 병합 범위 */
  merges?: string[];
  /** 0-기반 열 번호 → 서식. 지정하지 않으면 일반 서식 */
  columnFormats?: Record<number, 'money' | 'date'>;
}

/** 사용자 정의 서식 id. 내장 id(0~163)와 겹치지 않게 164부터 쓴다. */
const FMT_MONEY = 164;
const FMT_DATE = 165;

/** 스타일 인덱스 — cellXfs 의 순서와 같아야 한다. */
const STYLE_GENERAL = 0;
const STYLE_MONEY = 1;
const STYLE_DATE = 2;
const STYLE_TITLE = 3;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0-기반 열 번호 → A, B, ... Z, AA */
export function columnName(index: number): string {
  let name = '';
  let remaining = index;

  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);

  return name;
}

/**
 * `YYYY-MM-DD` → Excel 일련번호.
 *
 * 기준은 1899-12-30 이다. 1900-02-29 가 존재한다고 보는 Excel 의 오래된 버그 때문에
 * 1900-03-01 이후 날짜는 이 기준으로 계산하면 맞는다(우리 데이터는 2026년이라 안전 구간).
 */
export function dateToSerial(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const utc = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((utc - epoch) / 86_400_000);
}

export function buildXlsx(sheet: SheetSpec): Buffer {
  // 공유 문자열 표 — 같은 문자열은 한 번만 넣는다.
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();

  const internString = (value: string): number => {
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const index = shared.length;
    shared.push(value);
    sharedIndex.set(value, index);
    return index;
  };

  const rowsXml: string[] = [];

  sheet.rows.forEach((row, rowIndex) => {
    const cells: string[] = [];

    row.forEach((value, columnIndex) => {
      if (value === null || value === '') return;

      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      const format = sheet.columnFormats?.[columnIndex];

      if (typeof value === 'object') {
        // 날짜는 숫자 + 서식이다. 문자열로 넣으면 Excel 에서 날짜가 아니게 된다.
        cells.push(`<c r="${ref}" s="${STYLE_DATE}"><v>${dateToSerial(value.date)}</v></c>`);
        return;
      }

      if (typeof value === 'number') {
        const style = format === 'money' ? STYLE_MONEY : STYLE_GENERAL;
        cells.push(`<c r="${ref}" s="${style}"><v>${value}</v></c>`);
        return;
      }

      // 첫 행은 제목 스타일(병합된 제목 행을 눈에 보이게)
      const style = rowIndex === 0 ? STYLE_TITLE : STYLE_GENERAL;
      cells.push(`<c r="${ref}" s="${style}" t="s"><v>${internString(value)}</v></c>`);
    });

    if (cells.length > 0) {
      rowsXml.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`);
    }
  });

  const merges = sheet.merges ?? [];
  const mergeXml =
    merges.length > 0
      ? `<mergeCells count="${merges.length}">${merges
          .map((ref) => `<mergeCell ref="${esc(ref)}"/>`)
          .join('')}</mergeCells>`
      : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml.join('')}</sheetData>${mergeXml}
</worksheet>`;

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map((value) => `<si><t>${esc(value)}</t></si>`).join('')}
</sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="${FMT_MONEY}" formatCode="#,##0"/>
<numFmt numFmtId="${FMT_DATE}" formatCode="yyyy\\-mm\\-dd"/>
</numFmts>
<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="${FMT_MONEY}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="${FMT_DATE}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheet.name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf-8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf-8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf-8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf-8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedXml, 'utf-8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf-8') }
  ];

  return zipWrite(entries);
}
