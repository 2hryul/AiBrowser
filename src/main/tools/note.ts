import { registerTool, ToolError, type Tool } from './index';

/**
 * note_read / note_append — thread/site 범위의 메모.
 *
 * `site:<host>` 메모는 다음에 그 사이트를 다룰 때 에이전트 프롬프트에 자동으로 실린다.
 * 그래서 여기 적은 것은 **다음 실행에서 LLM 에게 보내진다** — 자격증명·개인정보가 들어가면
 * 그대로 흘러 나간다. NoteStore 가 저장 전에 검사해 거부하고, 그 사실을 결과로 알린다.
 */

interface ReadArgs {
  scope: string;
  /** 이력까지 볼지 */
  history?: boolean;
}

interface ReadResult {
  scope: string;
  text: string;
  version: number;
  exists: boolean;
  versions?: { version: number; createdAt: number; bytes: number }[];
}

const noteRead: Tool<ReadArgs, ReadResult> = {
  name: 'note_read',
  description:
    '메모를 읽는다. 범위는 thread:<id>(이 작업 메모) 또는 site:<host>(그 사이트 요령)다. ' +
    'site 메모는 그 사이트를 다룰 때 참고할 요령이 쌓이는 곳이다.',
  input: {
    type: 'object',
    properties: {
      scope: { type: 'string', minLength: 1 },
      history: { type: 'boolean' }
    },
    required: ['scope'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      scope: { type: 'string' },
      text: { type: 'string' },
      version: { type: 'integer' },
      exists: { type: 'boolean' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const note = ctx.notes.read(args.scope);

    const base: ReadResult = {
      scope: args.scope,
      text: note?.text ?? '',
      version: note?.version ?? 0,
      exists: note !== null
    };

    if (!args.history) return base;

    return {
      ...base,
      versions: ctx.notes.history(args.scope).map((item) => ({
        version: item.version,
        createdAt: item.createdAt,
        bytes: Buffer.byteLength(item.text, 'utf-8')
      }))
    };
  }
};

interface AppendArgs {
  scope: string;
  text: string;
}

interface AppendResult {
  scope: string;
  version: number;
  /** 거부됐으면 false. 이유는 reason 에 있다. */
  saved: boolean;
  reason: string | null;
  message: string | null;
  /** site 메모가 2KB 상한에 걸려 앞부분이 잘렸는지 */
  truncated: boolean;
  /** 되돌리기용 — 저장 전 버전 */
  previousVersion: number;
}

const noteAppend: Tool<AppendArgs, AppendResult> = {
  name: 'note_append',
  description:
    '메모에 한 줄 덧붙인다. 자격증명(비밀번호·토큰·카드번호)이나 개인정보(사번·전화·이메일)가 ' +
    '있으면 저장하지 않고 거부한다 — 이 메모는 다음 실행의 프롬프트에 실린다. ' +
    'site 메모는 호스트당 2KB 를 넘으면 오래된 앞부분이 잘린다.',
  input: {
    type: 'object',
    properties: {
      scope: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1, maxLength: 4000 }
    },
    required: ['scope', 'text'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      scope: { type: 'string' },
      version: { type: 'integer' },
      saved: { type: 'boolean' },
      reason: { type: ['string', 'null'] }
    }
  },
  sideEffect: 'persist',
  irreversible: false,
  /** 이전 버전 복원. 거부됐으면(저장이 없었으면) 되돌릴 것이 없다. */
  inverse(ctx, args, result) {
    if (!result.saved || result.previousVersion === 0) return null;

    const scope = args.scope;
    const version = result.previousVersion;

    return {
      tool: 'note_append',
      describe: `${scope} 메모를 v${version} 로 되돌리기`,
      invert: async () => {
        ctx.notes.restore(scope, version);
      }
    };
  },
  async run(ctx, args) {
    const previousVersion = ctx.notes.latestVersion(args.scope);
    const result = ctx.notes.append(args.scope, args.text);

    if (!result.ok) {
      // 범위 오류는 호출자의 실수라 오류로 던지고, 내용 거부는 결과로 알린다 —
      // 거부는 정상 동작이고 AI 가 다른 문장으로 다시 시도할 수 있어야 한다.
      if (result.reason === 'scope') {
        throw new ToolError('invalid_scope', `[note_append] ${result.message}`);
      }

      return {
        scope: args.scope,
        version: previousVersion,
        saved: false,
        reason: result.reason,
        message: result.message,
        truncated: false,
        previousVersion
      };
    }

    return {
      scope: args.scope,
      version: result.note.version,
      saved: true,
      reason: null,
      message: null,
      truncated: result.truncated,
      previousVersion
    };
  }
};

export function registerNoteTools(): void {
  registerTool(noteRead);
  registerTool(noteAppend);
}
