import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import type { FindState } from '../../shared/types';

/**
 * 페이지 단위 도구 — 찾기·인쇄·PDF 저장·개발자도구.
 * 탭 관리와 섞이면 TabManager 가 비대해지므로 webContents 를 받아 동작하는 모듈로 분리한다.
 */

export interface FindOptions {
  forward?: boolean;
  /**
   * 이미 열린 검색 세션에서 다음/이전 일치로 이동하는가.
   * false(기본)면 새 검색 세션을 시작한다.
   */
  advance?: boolean;
  matchCase?: boolean;
}

/**
 * 페이지 내 찾기.
 *
 * findInPage 는 비동기로 'found-in-page' 를 쏘기 때문에, 호출자가 결과를 기다릴 수 있게
 * 이벤트를 한 번 듣고 Promise 로 감싼다. 응답이 없는 페이지에서 영원히 걸리지 않게 상한을 둔다.
 */
export function findInPage(
  wc: WebContents,
  query: string,
  options: FindOptions = {}
): Promise<FindState> {
  if (query.trim() === '') {
    wc.stopFindInPage('clearSelection');
    return Promise.resolve({ query: '', matches: 0, activeMatchOrdinal: 0 });
  }

  return new Promise<FindState>((resolve) => {
    const timer = setTimeout(() => {
      wc.removeListener('found-in-page', onFound);
      resolve({ query, matches: 0, activeMatchOrdinal: 0 });
    }, 3000);

    const onFound = (_event: unknown, result: Electron.Result): void => {
      // finalUpdate 가 아닌 중간 결과는 일치 수가 확정되지 않았다.
      if (!result.finalUpdate) return;
      clearTimeout(timer);
      wc.removeListener('found-in-page', onFound);
      resolve({
        query,
        matches: result.matches ?? 0,
        activeMatchOrdinal: result.activeMatchOrdinal ?? 0
      });
    };

    wc.on('found-in-page', onFound);
    wc.findInPage(query, {
      forward: options.forward ?? true,
      // Electron 의 findNext 는 "이 요청으로 새 검색 세션을 시작하는가" 를 뜻한다.
      // 이름과 달리 "다음 일치로 이동"이 아니다 — 새 검색에 false 를 주면
      // found-in-page 가 아예 오지 않아 결과가 0 으로 보인다(Electron 44 에서 실측).
      findNext: !(options.advance ?? false),
      matchCase: options.matchCase ?? false
    });
  });
}

export function stopFind(wc: WebContents): void {
  wc.stopFindInPage('clearSelection');
}

/** 인쇄 대화상자를 띄운다. 사용자가 취소하면 false. */
export function printPage(wc: WebContents): Promise<boolean> {
  return new Promise((resolve) => {
    wc.print({}, (success, reason) => {
      if (!success && reason !== 'cancelled') {
        console.error(`[printPage] 인쇄 실패 - ${reason}`);
      }
      resolve(success);
    });
  });
}

export interface SavePdfResult {
  ok: boolean;
  filePath: string | null;
  error: string | null;
}

/**
 * 현재 페이지를 PDF 로 저장한다.
 * 대화상자를 띄우지 않고 다운로드 폴더에 저장한 뒤, 경로를 돌려주어 셸이 사용자에게 알린다.
 */
export async function savePageAsPdf(
  wc: WebContents,
  downloadDir: string,
  fileNameHint: string
): Promise<SavePdfResult> {
  try {
    const data = await wc.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      // 인치 단위. 1cm(≈0.4인치)가 Electron 기본값이라 그 값을 명시해 둔다.
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
    });

    const fileName = `${sanitizeFileName(fileNameHint)}.pdf`;
    const filePath = path.join(downloadDir, fileName);
    fs.writeFileSync(filePath, data);

    return { ok: true, filePath, error: null };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[savePageAsPdf] PDF 저장 실패 - 대상: ${fileNameHint}`, error);
    return { ok: false, filePath: null, error: message };
  }
}

/** 개발자도구. WebContentsView 는 창 크롬이 없어 별도 창(detach)으로 띄운다. */
export function toggleDevTools(wc: WebContents): boolean {
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools();
    return false;
  }
  wc.openDevTools({ mode: 'detach' });
  return true;
}

/**
 * Windows 파일명에 쓸 수 없는 문자를 공백으로 바꾼다.
 * 하이픈·밑줄은 제목의 일부일 수 있어 남긴다.
 */
export function sanitizeFileName(raw: string): string {
  // 제어 문자는 정규식(no-control-regex)에 넣는 대신 코드 포인트로 걸러낸다.
  const withoutControl = [...raw]
    .map((char) => (char.codePointAt(0) ?? 0) < 0x20 ? ' ' : char)
    .join('');

  const cleaned = withoutControl
    .replace(/[<>:"|?*/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return cleaned === '' ? 'page' : cleaned;
}
