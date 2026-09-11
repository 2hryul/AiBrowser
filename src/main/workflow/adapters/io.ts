/**
 * 어댑터가 바깥 세계를 만지는 유일한 통로.
 *
 * 어댑터를 ToolSurface 에 직접 묶지 않고 이 인터페이스를 사이에 둔다. 이유는 두 가지다:
 *   - 어댑터 로직(사다리·폴백·파싱)을 Electron 없이 단위 테스트할 수 있다
 *   - 실제 구현은 메인이 주입하므로 Policy·마스킹·감사 로그를 그대로 지난다
 *     (어댑터가 CDP 를 직접 부르는 경로를 만들지 않는다)
 */

export interface NetEntryLike {
  url: string;
  status: number | null;
  body: string | null;
}

export interface PortalIo {
  /** 탭을 열거나 재사용하고 그 주소로 이동한다. 탭 id 를 돌려준다. */
  open: (url: string) => Promise<number>;
  /** 응답 도청을 켠다(켠 뒤부터 기록된다). */
  tap: (tabId: number, urlPattern: string) => Promise<NetEntryLike[]>;
  /** 문구로 요소를 찾아 누른다. */
  click: (tabId: number, query: string, role?: string) => Promise<void>;
  /** 화면 본문 텍스트(마스킹 적용됨). 표는 행마다 줄바꿈, 칸마다 탭이다. */
  text: (tabId: number) => Promise<string>;
  /** 파일을 받아 경로를 돌려준다. */
  download: (tabId: number, url: string) => Promise<{ savePath: string; bytes: number }>;
  /** 파일을 읽는다(xlsx 파싱용). */
  readFile: (savePath: string) => Promise<Buffer>;
  /** 단계 스크린샷을 남기고 경로를 돌려준다. 실패하면 null. */
  screenshot: (tabId: number, label: string) => Promise<string | null>;
  /** 잠깐 기다린다(XHR 폴링). */
  wait: (ms: number) => Promise<void>;
}

/**
 * `get_page_text` 가 준 표를 행 객체로 바꾼다.
 *
 * innerText 기반이라 **행 = 줄, 칸 = 탭**이다. 헤더 줄을 찾아 그 뒤부터 읽는다.
 * 헤더를 못 찾으면 빈 배열이 아니라 null 을 돌려준다 — 어댑터가 "화면 구조가 바뀌었다"
 * (`ADAPTER_BROKEN`)와 "데이터가 없다"를 구분할 수 있어야 한다.
 */
export function parseTextTable(
  text: string,
  headers: readonly string[]
): Record<string, string>[] | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const headerIndex = lines.findIndex((line) => {
    const cells = line.split('\t').map((cell) => cell.trim());
    return headers.every((header) => cells.includes(header));
  });

  if (headerIndex < 0) return null;

  const headerCells = (lines[headerIndex] ?? '').split('\t').map((cell) => cell.trim());
  const rows: Record<string, string>[] = [];

  const headerLine = headerCells.join('\u0001');

  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split('\t').map((cell) => cell.trim());
    // 칸 수가 다른 줄은 표가 아니다(안내 문구·합계 줄 등) — 조용히 건너뛴다.
    if (cells.length !== headerCells.length) continue;
    // 같은 머리글이 또 나오면 표가 하나 더 있는 것이다(정산 화면의 XHR 표 + 정적 표).
    // 머리글을 데이터 행으로 읽으면 거래번호가 "거래번호" 인 행이 생긴다 — 건너뛴다.
    if (cells.join('\u0001') === headerLine) continue;

    const row: Record<string, string> = {};
    headerCells.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    rows.push(row);
  }

  return rows;
}
