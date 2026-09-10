import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ReaderArticle, ReaderFailure } from '../../shared/types';

/**
 * 읽기 모드 본문 추출기.
 * 이후 ToolSurface 의 get_page_text 가 같은 함수를 쓴다(M2). 그래서 Electron 에 의존하지 않는
 * 순수 함수로 두고, 페이지 HTML 문자열만 받는다 — 그래야 단위 테스트로 골든 비교가 가능하다.
 */

/** 추출 실패 사유를 호출자가 구분할 수 있게 결과를 감싼다. */
export type ReaderResult =
  | { ok: true; article: ReaderArticle }
  | { ok: false; reason: Exclude<ReaderFailure, 'no-tab'> };

/**
 * Readability 는 문서를 파괴적으로 수정하므로 판정용과 추출용 문서를 따로 파싱한다.
 * 한 문서를 재사용하면 isProbablyReaderable 이후 추출 결과가 달라진다.
 */
function toDocument(html: string, baseUrl: string): Document {
  // 상대 링크·이미지 경로 해석을 위해 base 를 주입한다. linkedom 은 documentURI 를 못 세운다.
  const withBase = html.includes('<base ')
    ? html
    : html.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttribute(baseUrl)}">`);

  const { document } = parseHTML(withBase);
  return document as unknown as Document;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 연속 공백·빈 줄을 접어 본문 텍스트를 비교 가능한 형태로 만든다. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // 줄바꿈을 제외한 모든 공백류(NBSP·전각 공백 포함)를 한 칸으로 접는다.
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** 추출 성공으로 인정하는 최소 본문 길이. 이보다 짧으면 내비게이션 조각을 집은 것으로 본다. */
const MIN_ARTICLE_LENGTH = 200;

/**
 * 본문을 추출한다.
 *
 * isProbablyReaderable 로 미리 걸러내지 않는다. 그 휴리스틱은 `<p>`·`<pre>`·`<article>` 만 세기
 * 때문에 본문을 `<div>`·`<td>` 로 짜는 사내 구형 포털을 "읽을 수 없음"으로 잘못 판정한다.
 * 사용자가 읽기 모드를 누른 건 이미 의사 표시이므로 실제로 파싱해 보고 결과 길이로 판정한다.
 */
export function extractArticle(html: string, baseUrl: string): ReaderResult {
  if (html.trim() === '') return { ok: false, reason: 'empty-html' };

  try {
    const parsed = new Readability(toDocument(html, baseUrl)).parse();
    if (!parsed || !parsed.content) return { ok: false, reason: 'extract-failed' };

    const textContent = normalizeText(parsed.textContent ?? '');
    if (textContent.length < MIN_ARTICLE_LENGTH) {
      // 휴리스틱까지 아니라고 하면 애초에 본문이 없는 페이지다.
      return { ok: false, reason: isReaderable(html, baseUrl) ? 'extract-failed' : 'not-readerable' };
    }

    return {
      ok: true,
      article: {
        title: (parsed.title ?? '').trim(),
        byline: parsed.byline?.trim() || null,
        excerpt: parsed.excerpt?.trim() || null,
        content: parsed.content,
        textContent,
        length: textContent.length,
        siteName: parsed.siteName?.trim() || null,
        lang: parsed.lang?.trim() || null
      }
    };
  } catch (error) {
    console.error(`[extractArticle] 본문 추출 실패 - url: ${baseUrl}`, error);
    return { ok: false, reason: 'extract-failed' };
  }
}

/** 읽기 모드 버튼 활성화 여부만 알고 싶을 때. 추출까지 하지 않아 가볍다. */
export function isReaderable(html: string, baseUrl: string): boolean {
  if (html.trim() === '') return false;
  try {
    return isProbablyReaderable(toDocument(html, baseUrl));
  } catch (error) {
    console.warn(`[isReaderable] 판정 실패 - url: ${baseUrl}`, error);
    return false;
  }
}
