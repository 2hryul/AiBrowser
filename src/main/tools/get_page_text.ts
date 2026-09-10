import { extractArticle } from '../browser/Reader';
import { getPageHtml, getPageText, MASKED_VALUE } from '../cdp/PageReader';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, type Tool } from './index';

/**
 * get_page_text — 페이지 텍스트.
 *
 * mode='text'(기본)는 iframe 까지 포함한 본문 텍스트, mode='article'은 M1 읽기 모드와 같은
 * 추출기(@mozilla/readability)를 써서 광고·내비를 걷어낸 본문만 준다. 추출기를 공유하는 것이
 * GOAL 의 "Reader 공용" 요구다.
 */

interface Args {
  tabId?: number;
  mode?: 'text' | 'article';
  maxChars?: number;
}

interface Result {
  tabId: number;
  url: string;
  mode: 'text' | 'article';
  text: string;
  frames: number;
  truncated: boolean;
  /** mode='article' 에서만 채워진다. */
  title?: string;
  byline?: string | null;
}

const DEFAULT_MAX_CHARS = 50_000;

/**
 * 비밀번호가 본문에 섞여 나가지 않게 한 번 더 훑는다.
 * innerText 에는 보통 input 값이 포함되지 않지만, 값을 그대로 텍스트로 찍는 페이지가 있다.
 */
function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join(MASKED_VALUE);
  }
  return out;
}

/** 페이지 안의 password 입력 값을 모아 온다. 마스킹 대상 목록으로만 쓰고 저장하지 않는다. */
async function passwordValues(wc: Electron.WebContents): Promise<string[]> {
  try {
    const values = (await wc.executeJavaScript(
      `Array.from(document.querySelectorAll('input[type=password]')).map((el) => el.value).filter(Boolean)`
    )) as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

const getPageTextTool: Tool<Args, Result> = {
  name: 'get_page_text',
  description:
    '페이지의 텍스트를 가져온다. mode=text 는 iframe 을 포함한 화면 텍스트, mode=article 은 ' +
    '읽기 모드와 같은 추출기로 본문만 뽑는다(광고·내비 제거). 비밀번호 값은 *** 로 가려진다.',
  input: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['text', 'article'] },
      maxChars: { type: 'integer', minimum: 100, maximum: 500000 },
      ...TAB_ID_PROPERTY
    },
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      url: { type: 'string' },
      mode: { type: 'string' },
      text: { type: 'string' },
      frames: { type: 'integer' },
      truncated: { type: 'boolean' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);
    const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
    const secrets = await passwordValues(wc);

    if (args.mode === 'article') {
      const html = await getPageHtml(wc);
      const extracted = extractArticle(html, wc.getURL());

      if (!extracted.ok) {
        // 본문을 못 찾으면 화면 텍스트로 떨어진다 — 빈손으로 돌려보내지 않는다.
        const fallback = await getPageText(wc);
        const text = maskSecrets(fallback.text, secrets);
        return {
          tabId,
          url: fallback.url,
          mode: 'text',
          text: text.slice(0, maxChars),
          frames: fallback.frames,
          truncated: text.length > maxChars
        };
      }

      const text = maskSecrets(extracted.article.textContent, secrets);
      return {
        tabId,
        url: wc.getURL(),
        mode: 'article',
        text: text.slice(0, maxChars),
        frames: 1,
        truncated: text.length > maxChars,
        title: extracted.article.title,
        byline: extracted.article.byline
      };
    }

    const raw = await getPageText(wc);
    const text = maskSecrets(raw.text, secrets);

    return {
      tabId,
      url: raw.url,
      mode: 'text',
      text: text.slice(0, maxChars),
      frames: raw.frames,
      truncated: text.length > maxChars
    };
  }
};

export function registerGetPageTextTool(): void {
  registerTool(getPageTextTool);
}
