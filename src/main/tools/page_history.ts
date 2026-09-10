import { registerTool, type Tool } from './index';

/**
 * page_history / page_diff — 페이지 본문의 변화.
 *
 * "지난주와 뭐가 달라졌나" 는 사내 포털에서 가장 자주 나오는 질문이다. 매번 전문을 다시 읽어
 * 비교하는 대신, 방문할 때 남긴 스냅샷을 낱말 단위로 비교한다. 스냅샷은 북마크된 주소를
 * 방문할 때 자동으로 쌓인다.
 */

interface HistoryArgs {
  url: string;
  limit?: number;
}

interface HistoryResult {
  url: string;
  snapshots: { id: number; capturedAt: number; bytes: number; truncated: boolean; title: string }[];
  /** 비교할 수 있는지 — 스냅샷이 2개 이상이어야 한다 */
  comparable: boolean;
}

const pageHistory: Tool<HistoryArgs, HistoryResult> = {
  name: 'page_history',
  description:
    '그 주소의 본문 스냅샷 이력을 최근 순으로 나열한다. 스냅샷은 북마크된 주소를 방문할 때 ' +
    '자동으로 쌓인다. 2개 이상이면 page_diff 로 비교할 수 있다.',
  input: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 }
    },
    required: ['url'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      snapshots: { type: 'array' },
      comparable: { type: 'boolean' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const snapshots = ctx.changes.history(args.url, args.limit ?? 20);

    return {
      url: args.url,
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        capturedAt: snapshot.capturedAt,
        bytes: snapshot.bytes,
        truncated: snapshot.truncated,
        title: snapshot.title
      })),
      comparable: snapshots.length >= 2
    };
  }
};

interface DiffArgs {
  url: string;
  /** 생략하면 직전 스냅샷 */
  fromId?: number;
  /** 생략하면 최신 스냅샷 */
  toId?: number;
  /** 돌려줄 조각 수 상한 — 전체를 다 보내면 토큰이 폭발한다 */
  maxHunks?: number;
}

interface DiffResult {
  url: string;
  found: boolean;
  from: { id: number; capturedAt: number } | null;
  to: { id: number; capturedAt: number } | null;
  addedWords: number;
  removedWords: number;
  changedWords: number;
  /** 낱말 정렬을 포기하고 전체 교체로 본 경우 */
  coarse: boolean;
  hunks: { kind: string; text: string; words: number }[];
  truncatedHunks: boolean;
}

/** 변경 조각만 돌려준다 — 안 바뀐 부분은 이미 알고 있다. */
const CONTEXT_CHARS = 60;

const pageDiff: Tool<DiffArgs, DiffResult> = {
  name: 'page_diff',
  description:
    '두 스냅샷을 낱말 단위로 비교한다. id 를 생략하면 직전 ↔ 최신이다. 바뀐 조각만 돌려주고, ' +
    '차이가 너무 커서 정렬을 포기하면 coarse: true 로 알린다(그때는 전체를 다시 읽어야 한다).',
  input: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      fromId: { type: 'integer', minimum: 1 },
      toId: { type: 'integer', minimum: 1 },
      maxHunks: { type: 'integer', minimum: 1, maximum: 200 }
    },
    required: ['url'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      found: { type: 'boolean' },
      changedWords: { type: 'integer' },
      hunks: { type: 'array' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const diff = ctx.changes.diff(args.url, args.fromId, args.toId);

    if (!diff) {
      return {
        url: args.url,
        found: false,
        from: null,
        to: null,
        addedWords: 0,
        removedWords: 0,
        changedWords: 0,
        coarse: false,
        hunks: [],
        truncatedHunks: false
      };
    }

    const maxHunks = args.maxHunks ?? 40;
    const changed = diff.hunks.filter((hunk) => hunk.kind !== 'same');

    return {
      url: diff.url,
      found: true,
      from: diff.from,
      to: diff.to,
      addedWords: diff.addedWords,
      removedWords: diff.removedWords,
      changedWords: diff.changedWords,
      coarse: diff.coarse,
      hunks: changed.slice(0, maxHunks).map((hunk) => ({
        kind: hunk.kind,
        text: hunk.text.length > CONTEXT_CHARS * 4 ? `${hunk.text.slice(0, CONTEXT_CHARS * 4)}…` : hunk.text,
        words: hunk.words
      })),
      truncatedHunks: changed.length > maxHunks
    };
  }
};

export function registerPageHistoryTools(): void {
  registerTool(pageHistory);
  registerTool(pageDiff);
}
