import fs from 'node:fs';
import path from 'node:path';
import type { Bookmark, HistorySuggestion, OmniboxSuggestion } from '../../shared/types';
import { HOME_URL } from '../../shared/types';

/**
 * 주소창 — 입력 정규화와 제안 목록.
 *
 * 순수 함수로 두어 단위 테스트가 가능하게 한다. 저장소는 조회 함수로 주입받고,
 * 검색엔진은 config/search.json 에서 읽는다(코드에 URL 을 박지 않는다).
 */

/** navigate 로 넘길 수 있는 스킴 허용 목록. file: 은 셸에서 임의로 열지 않는다. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'app:', 'about:']);

/** 스킴 없는 입력이 호스트처럼 보이는지: 점이 있거나 localhost(:포트) 형태. */
const HOST_LIKE = /^(localhost(:\d+)?|[\w-]+(\.[\w-]+)+(:\d+)?)(\/.*)?$/i;

/**
 * `호스트:포트` 를 스킴으로 오인하지 않기 위한 판별.
 * `localhost:5173` 은 정규식상 스킴 `localhost:` 로도 읽히므로, 콜론 뒤가 숫자(포트)뿐이면
 * 스킴이 아니라 호스트로 본다. 크롬도 같은 규칙을 쓴다.
 */
const HOST_WITH_PORT = /^[a-z][a-z0-9-]*:\d+(\/.*)?$/i;

function hasScheme(input: string): boolean {
  if (HOST_WITH_PORT.test(input)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(input);
}

export function normalizeAddress(rawInput: string): string | null {
  const input = rawInput.trim();
  if (input === '') return null;
  if (input === 'home' || input === 'app://home') return HOME_URL;

  if (hasScheme(input)) {
    try {
      const url = new URL(input);
      return ALLOWED_SCHEMES.has(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  if (HOST_LIKE.test(input)) {
    try {
      return new URL(`https://${input}`).toString();
    } catch {
      return null;
    }
  }

  return null;
}

export interface SearchEngine {
  id: string;
  name: string;
  /** {q} 자리에 검색어가 URL 인코딩되어 들어간다. */
  urlTemplate: string;
  keyword?: string;
}

export interface SearchConfig {
  defaultEngine: string | null;
  engines: SearchEngine[];
}

const EMPTY_SEARCH: SearchConfig = { defaultEngine: null, engines: [] };

/**
 * 검색엔진 설정을 읽는다.
 * 파일이 없거나 형식이 어긋나면 "검색엔진 없음"으로 떨어진다 — 외부 네트워크로 나가는 기본값을
 * 코드에 두지 않기 위한 것이다(GOAL CONSTRAINTS).
 */
export function loadSearchConfig(configDir: string): SearchConfig {
  const file = path.join(configDir, 'search.json');

  try {
    if (!fs.existsSync(file)) return EMPTY_SEARCH;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SearchConfig>;

    const engines = (parsed.engines ?? []).filter(
      (engine): engine is SearchEngine =>
        typeof engine?.id === 'string' &&
        typeof engine.name === 'string' &&
        typeof engine.urlTemplate === 'string' &&
        engine.urlTemplate.includes('{q}')
    );

    const defaultEngine =
      typeof parsed.defaultEngine === 'string' && engines.some((e) => e.id === parsed.defaultEngine)
        ? parsed.defaultEngine
        : (engines[0]?.id ?? null);

    return { defaultEngine, engines };
  } catch (error) {
    console.error(`[loadSearchConfig] 검색엔진 설정 읽기 실패 - 경로: ${file}`, error);
    return EMPTY_SEARCH;
  }
}

export function resolveSearchUrl(config: SearchConfig, query: string): string | null {
  const engine = config.engines.find((e) => e.id === config.defaultEngine);
  if (!engine) return null;
  return engine.urlTemplate.replace('{q}', encodeURIComponent(query));
}

/** 번들 내부 페이지. 히스토리가 비어 있어도 제안에 뜨게 한다. */
const BUILT_IN_PAGES: readonly { url: string; title: string; keywords: readonly string[] }[] = [
  { url: HOME_URL, title: 'Helm 홈', keywords: ['home', 'helm', '홈', 'app://home'] }
];

export interface SuggestSources {
  bookmarks: (query: string, limit: number) => Bookmark[];
  history: (query: string, limit: number) => HistorySuggestion[];
  search: SearchConfig;
}

/** 점수 구간 — 종류별 우선순위를 숫자로 못박아 정렬이 흔들리지 않게 한다. */
const SCORE = {
  directUrl: 1000,
  builtInPrefix: 900,
  bookmarkPrefix: 800,
  bookmarkSubstring: 600,
  historyPrefix: 500,
  historySubstring: 300,
  search: 10
} as const;

interface Scored extends OmniboxSuggestion {
  score: number;
}

/** URL 에서 스킴과 www 를 떼어 사용자가 실제로 타이핑하는 형태로 만든다. */
function typedForm(url: string): string {
  return url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .toLowerCase();
}

function isPrefixMatch(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().startsWith(needle);
}

export function buildSuggestions(
  rawInput: string,
  sources: SuggestSources,
  limit = 8
): OmniboxSuggestion[] {
  const input = rawInput.trim();
  if (input === '') return [];

  const needle = input.toLowerCase();
  const scored: Scored[] = [];

  // 1) 입력 자체가 주소로 해석되면 직접 이동을 1순위로 둔다.
  //    단, 점도 스킴도 없는 한 단어(예: 'hom')는 주소로 보지 않는다 — 검색·제안 대상이다.
  const looksLikeAddress = hasScheme(input) || HOST_LIKE.test(input);
  const direct = looksLikeAddress ? normalizeAddress(input) : null;
  if (direct) {
    scored.push({
      kind: 'url',
      url: direct,
      primary: direct,
      secondary: '주소로 이동',
      score: SCORE.directUrl
    });
  }

  // 2) 번들 내부 페이지
  for (const page of BUILT_IN_PAGES) {
    const hit =
      page.keywords.some((keyword) => isPrefixMatch(keyword, needle)) ||
      isPrefixMatch(typedForm(page.url), needle) ||
      isPrefixMatch(page.title, needle);
    if (!hit) continue;

    scored.push({
      kind: 'url',
      url: page.url,
      primary: page.title,
      secondary: page.url,
      score: SCORE.builtInPrefix
    });
  }

  // 3) 북마크
  for (const bookmark of sources.bookmarks(input, limit)) {
    const prefix =
      isPrefixMatch(typedForm(bookmark.url), needle) || isPrefixMatch(bookmark.title, needle);
    scored.push({
      kind: 'bookmark',
      url: bookmark.url,
      primary: bookmark.title || bookmark.url,
      secondary: bookmark.url,
      score: prefix ? SCORE.bookmarkPrefix : SCORE.bookmarkSubstring
    });
  }

  // 4) 방문 기록 — 같은 구간 안에서는 방문 횟수가 많은 쪽이 위로.
  for (const entry of sources.history(input, limit)) {
    const prefix = isPrefixMatch(typedForm(entry.url), needle) || isPrefixMatch(entry.title, needle);
    const base = prefix ? SCORE.historyPrefix : SCORE.historySubstring;
    scored.push({
      kind: 'history',
      url: entry.url,
      primary: entry.title || entry.url,
      secondary: entry.url,
      score: base + Math.min(entry.visitCount, 50)
    });
  }

  // 5) 검색 — 설정된 엔진이 있을 때만. 없으면 아무것도 넣지 않는다.
  if (!direct) {
    const searchUrl = resolveSearchUrl(sources.search, input);
    if (searchUrl) {
      const engine = sources.search.engines.find((e) => e.id === sources.search.defaultEngine);
      scored.push({
        kind: 'search',
        url: searchUrl,
        primary: input,
        secondary: `${engine?.name ?? '검색'}에서 검색`,
        score: SCORE.search
      });
    }
  }

  // URL 이 같은 제안은 점수가 높은 쪽만 남긴다.
  const best = new Map<string, Scored>();
  for (const item of scored) {
    const existing = best.get(item.url);
    if (!existing || item.score > existing.score) best.set(item.url, item);
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.primary.localeCompare(b.primary))
    .slice(0, limit)
    .map(({ score: _score, ...suggestion }) => suggestion);
}
