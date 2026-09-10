import type { WebContents } from 'electron';
import type { ReaderPayload } from '../../shared/types';
import { extractArticle } from './Reader';

/**
 * 읽기 모드를 실제 탭에 연결하는 얇은 층.
 * 추출 로직(Reader.ts)은 Electron 을 모르게 두고, 페이지 HTML 을 가져오는 일만 여기서 한다.
 */

/**
 * 탭의 현재 문서 HTML 을 가져와 본문을 추출한다.
 *
 * outerHTML 을 통째로 끌어오는 건 큰 페이지에서 비용이 있지만, 읽기 모드는 사용자가 명시적으로
 * 누를 때만 동작하므로 감수한다. 대신 상한을 두어 비정상적으로 큰 문서에서 메인을 막지 않는다.
 */
export async function readTab(wc: WebContents, tabId: number): Promise<ReaderPayload> {
  const url = wc.getURL();

  let html: string;
  try {
    html = (await wc.executeJavaScript('document.documentElement.outerHTML')) as string;
  } catch (error) {
    console.error(`[readTab] 문서 HTML 가져오기 실패 - 탭 ${tabId}, url: ${url}`, error);
    return { tabId, url, article: null, reason: 'extract-failed' };
  }

  if (typeof html !== 'string' || html.trim() === '') {
    return { tabId, url, article: null, reason: 'empty-html' };
  }

  const result = extractArticle(html, url);
  return result.ok
    ? { tabId, url, article: result.article, reason: null }
    : { tabId, url, article: null, reason: result.reason };
}
