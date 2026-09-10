import { registerTool, type Tool } from './index';
import { INBOX_KINDS, type InboxKind } from '../persistence/Inbox';

/**
 * inbox_post — 결과·요청을 받은편지함에 남긴다.
 *
 * 장시간·헤드리스 작업의 출력은 화면이 아니라 받은편지함이다. 사람이 자리에 없어도 결과가
 * 쌓이고, 돌아와서 읽지 않은 것만 보면 된다.
 *
 * 근거는 파일 경로로 남긴다(스크린샷·CSV). 본문을 DB 에 넣으면 목록 조회가 느려지고,
 * 무엇보다 개인정보가 DB 로 번진다.
 */

interface PostArgs {
  kind: InboxKind;
  title: string;
  summary?: string;
  /** 근거 파일 경로(스크린샷·CSV 등) */
  evidencePath?: string;
}

interface PostResult {
  id: number;
  kind: string;
  title: string;
  unreadCount: number;
  createdAt: number;
}

const inboxPost: Tool<PostArgs, PostResult> = {
  name: 'inbox_post',
  description:
    '받은편지함에 항목을 남긴다. 작업을 마쳤으면 kind: "done" 으로, 중간 결과는 "result" 로, ' +
    '실패는 "failed" 로 남긴다. 사람이 자리에 없어도 결과가 여기 쌓인다.',
  input: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...INBOX_KINDS] },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      summary: { type: 'string', maxLength: 2000 },
      evidencePath: { type: 'string', maxLength: 1000 }
    },
    required: ['kind', 'title'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      unreadCount: { type: 'integer' },
      createdAt: { type: 'integer' }
    }
  },
  sideEffect: 'persist',
  irreversible: false,
  /** 항목 삭제. 사람이 이미 읽었더라도 되돌리기는 그 항목을 없앤다. */
  inverse(ctx, _args, result) {
    return {
      tool: 'inbox_post',
      describe: `받은편지함 항목 "${result.title}" 삭제`,
      invert: async () => {
        ctx.inbox.remove(result.id);
      }
    };
  },
  async run(ctx, args) {
    const item = ctx.inbox.post({
      kind: args.kind,
      title: args.title,
      threadId: ctx.threadId,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      ...(args.evidencePath === undefined ? {} : { evidencePath: args.evidencePath })
    });

    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      unreadCount: ctx.inbox.unreadCount(),
      createdAt: item.createdAt
    };
  }
};

export function registerInboxTools(): void {
  registerTool(inboxPost);
}
