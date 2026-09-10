import { registerTool, type Tool } from './index';

/**
 * bookmark_list / bookmark_get — 에이전트용 북마크 조회.
 *
 * 사람에게 북마크는 "다시 갈 곳" 이지만 에이전트에게는 "무엇을 해야 하는 곳" 이다.
 * navigate 하기 전에 여기서 의도·기대 콘텐츠·핵심 필드·요령을 먼저 읽으면, 화면을 보고
 * 처음부터 추론하지 않아도 된다(그리고 화면이 바뀐 것도 알아챌 수 있다).
 *
 * 읽기 전용이다. 북마크 생성·삭제는 사람의 일이다(CLAUDE.md 지속성 도구 표).
 */

interface ListArgs {
  /** 제목·주소·의도·힌트에서 부분 일치 */
  query?: string;
  limit?: number;
}

interface BookmarkView {
  id: number;
  title: string;
  url: string;
  folder: string;
  intent: string | null;
  expectedContent: string | null;
  keyFields: string[];
  agentHints: string | null;
  /** 이 주소의 본문 스냅샷 수 — page_diff 로 변화를 볼 수 있는지 */
  snapshots: number;
}

interface ListResult {
  bookmarks: BookmarkView[];
  total: number;
}

function toView(
  entry: { bookmark: { id: number; title: string; url: string; folder: string }; meta: null | {
    intent: string;
    expectedContent: string;
    keyFields: string[];
    agentHints: string;
  } },
  snapshots: number
): BookmarkView {
  return {
    id: entry.bookmark.id,
    title: entry.bookmark.title,
    url: entry.bookmark.url,
    folder: entry.bookmark.folder,
    intent: entry.meta?.intent ?? null,
    expectedContent: entry.meta?.expectedContent ?? null,
    keyFields: entry.meta?.keyFields ?? [],
    agentHints: entry.meta?.agentHints ?? null,
    snapshots
  };
}

const bookmarkList: Tool<ListArgs, ListResult> = {
  name: 'bookmark_list',
  description:
    '북마크를 AI 메타(의도·기대 콘텐츠·핵심 필드·요령)와 함께 나열한다. query 로 좁힌다. ' +
    '작업을 시작하기 전에 관련 북마크가 있는지 먼저 보면 사이트 요령을 다시 알아내지 않아도 된다.',
  input: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: { bookmarks: { type: 'array' }, total: { type: 'integer' } }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const entries = ctx.bookmarkMeta.listWithBookmarks(args.query ?? '', args.limit ?? 50);

    return {
      bookmarks: entries.map((entry) =>
        toView(entry, ctx.changes.count(entry.bookmark.url))
      ),
      total: entries.length
    };
  }
};

interface GetArgs {
  /** id 또는 url 중 하나 */
  id?: number;
  url?: string;
}

const bookmarkGet: Tool<GetArgs, BookmarkView | { found: false }> = {
  name: 'bookmark_get',
  description: '북마크 하나를 AI 메타와 함께 읽는다. id 또는 url 로 지정한다.',
  input: {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1 },
      url: { type: 'string', minLength: 1 }
    },
    additionalProperties: false
  },
  output: { type: 'object' },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const entries = ctx.bookmarkMeta.listWithBookmarks('', 500);
    const found = entries.find(
      (entry) =>
        (args.id !== undefined && entry.bookmark.id === args.id) ||
        (args.url !== undefined && entry.bookmark.url === args.url)
    );

    if (!found) return { found: false };
    return toView(found, ctx.changes.count(found.bookmark.url));
  }
};

export function registerBookmarkTools(): void {
  registerTool(bookmarkList);
  registerTool(bookmarkGet);
}
