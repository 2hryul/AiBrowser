import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, dateToSerial } from '../src/main/workflow/xlsx/write';
import { XlsxError, parseRef, readXlsx, serialToDate, sheetToRecords } from '../src/main/workflow/xlsx/read';
import { crc32, zipRead, zipWrite } from '../src/main/workflow/xlsx/zip';

/**
 * xlsx 골든 테스트 (GOAL-M5 성공 조건 6).
 *
 * 골든 3건: **병합 셀 · 천단위 콤마 · 날짜 서식**.
 * 기대값은 손으로 적는다 — 쓰기 결과를 그대로 기대값으로 삼으면 아무것도 증명하지 못한다.
 */

/** 회계 시스템이 내려주는 파일 모양. 제목이 병합되어 있고 헤더는 2행이다. */
function sampleWorkbook(): Buffer {
  return buildXlsx({
    name: '전표',
    rows: [
      ['2026년 3월 전표 대사', null, null, null],
      ['전표번호', '거래번호', '금액', '전표일자'],
      ['V-20260304-01', 'TX-20260304-01', 1_250_000, { date: '2026-03-04' }],
      ['V-20260304-02', 'TX-20260304-02', 980_500, { date: '2026-03-04' }],
      ['V-20260304-03', 'TX-20260304-03', 12_345, { date: '2026-03-05' }]
    ],
    merges: ['A1:D1'],
    columnFormats: { 2: 'money', 3: 'date' }
  });
}

describe('ZIP', () => {
  it('쓰고 다시 읽으면 같은 내용이 나온다', () => {
    const buffer = zipWrite([
      { name: 'a.txt', data: Buffer.from('가나다', 'utf-8') },
      { name: 'dir/b.xml', data: Buffer.from('<x>1</x>', 'utf-8') }
    ]);

    const files = zipRead(buffer);
    expect([...files.keys()].sort()).toEqual(['a.txt', 'dir/b.xml']);
    expect(files.get('a.txt')?.toString('utf-8')).toBe('가나다');
    expect(files.get('dir/b.xml')?.toString('utf-8')).toBe('<x>1</x>');
  });

  it('같은 입력이면 바이트가 같다 — fixture 가 결정적이어야 한다', () => {
    const first = zipWrite([{ name: 'a.txt', data: Buffer.from('같은 내용') }]);
    const second = zipWrite([{ name: 'a.txt', data: Buffer.from('같은 내용') }]);
    expect(first.equals(second)).toBe(true);
  });

  it('CRC32 는 알려진 값과 맞는다', () => {
    // 표준 검증 벡터
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from(''))).toBe(0);
  });

  it('ZIP 이 아니면 이유를 말하며 실패한다', () => {
    expect(() => zipRead(Buffer.from('안녕하세요 이건 zip 이 아닙니다'))).toThrow(/EOCD/);
  });
});

describe('셀 주소·날짜 변환', () => {
  it('열 이름과 주소를 왕복한다', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');

    expect(parseRef('A1')).toEqual({ row: 0, column: 0 });
    expect(parseRef('D5')).toEqual({ row: 4, column: 3 });
    expect(parseRef('AA10')).toEqual({ row: 9, column: 26 });
    expect(() => parseRef('1A')).toThrow(/셀 주소/);
  });

  it('Excel 일련번호를 왕복한다', () => {
    // 1900-01-01 은 1, 2026-03-04 는 아래 값 — 기준(1899-12-30)이 맞는지 확인한다.
    expect(dateToSerial('1900-01-01')).toBe(2);
    expect(serialToDate(dateToSerial('2026-03-04'))).toBe('2026-03-04');
    expect(serialToDate(dateToSerial('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('xlsx 골든 3건', () => {
  it('골든 1 — 병합 셀: 값은 왼쪽 위에만 있고 범위 안은 그 값으로 읽힌다', () => {
    const sheet = readXlsx(sampleWorkbook()).sheet;

    expect(sheet.name).toBe('전표');
    expect(sheet.merges).toHaveLength(1);
    expect(sheet.merges[0]).toMatchObject({ ref: 'A1:D1', top: 0, left: 0, bottom: 0, right: 3 });

    // 저장된 값은 A1 에만 있다
    expect(sheet.grid[0]?.[0]?.text).toBe('2026년 3월 전표 대사');
    expect(sheet.grid[0]?.[1]).toBeNull();

    // 병합을 풀면 B1·D1 도 같은 값이다
    expect(sheet.valueAt(0, 1)?.text).toBe('2026년 3월 전표 대사');
    expect(sheet.valueAt(0, 3)?.text).toBe('2026년 3월 전표 대사');

    // 병합 밖은 그대로
    expect(sheet.valueAt(1, 0)?.text).toBe('전표번호');
  });

  it('골든 2 — 천단위 콤마: 서식일 뿐이므로 숫자로 읽는다', () => {
    const sheet = readXlsx(sampleWorkbook()).sheet;

    const amount = sheet.valueAt(2, 2);
    expect(amount?.type).toBe('number');
    expect(amount?.value).toBe(1_250_000);
    // 문자열 "1,250,000" 을 돌려주면 대사 쪽에서 다시 파싱해야 한다 — 그러면 안 된다.
    expect(amount?.text).toBe('1250000');

    expect(sheet.valueAt(3, 2)?.value).toBe(980_500);
    expect(sheet.valueAt(4, 2)?.value).toBe(12_345);
  });

  it('골든 3 — 날짜 서식: 일련번호를 YYYY-MM-DD 로 돌려준다', () => {
    const sheet = readXlsx(sampleWorkbook()).sheet;

    const date = sheet.valueAt(2, 3);
    expect(date?.type).toBe('date');
    expect(date?.text).toBe('2026-03-04');
    // 원래 값(일련번호)도 남겨 둔다 — 다시 계산할 일이 있을 수 있다.
    expect(date?.value).toBe(dateToSerial('2026-03-04'));

    expect(sheet.valueAt(4, 3)?.text).toBe('2026-03-05');

    // 같은 열의 금액은 날짜가 아니다 — 서식으로만 판단해야 한다.
    expect(sheet.valueAt(2, 2)?.type).toBe('number');
  });

  it('표를 객체 배열로 바꾼다 — 병합된 제목 행 아래의 헤더를 쓴다', () => {
    const sheet = readXlsx(sampleWorkbook()).sheet;
    const records = sheetToRecords(sheet, 1);

    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({
      전표번호: 'V-20260304-01',
      거래번호: 'TX-20260304-01',
      금액: '1250000',
      전표일자: '2026-03-04'
    });
    expect(records[2]?.['전표일자']).toBe('2026-03-05');
  });

  it('공유 문자열을 쓴다 — 실제 파일과 같은 구조여야 읽기 경로가 검증된다', () => {
    const files = zipRead(sampleWorkbook());

    expect([...files.keys()]).toContain('xl/sharedStrings.xml');
    const shared = files.get('xl/sharedStrings.xml')?.toString('utf-8') ?? '';
    expect(shared).toContain('<t>전표번호</t>');

    const sheetXml = files.get('xl/worksheets/sheet1.xml')?.toString('utf-8') ?? '';
    // 문자열 셀은 t="s" 로 공유 문자열을 가리킨다(인라인이 아니다)
    expect(sheetXml).toContain('t="s"');
  });

  it('xlsx 가 아니면 이유를 말하며 실패한다', () => {
    const notXlsx = zipWrite([{ name: 'hello.txt', data: Buffer.from('hi') }]);
    expect(() => readXlsx(notXlsx)).toThrow(XlsxError);
    expect(() => readXlsx(notXlsx)).toThrow(/workbook.xml/);
  });
});
