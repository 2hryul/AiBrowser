import { readPage, READ_PAGE_LIMIT, type AxNode } from '../cdp/PageReader';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, type Tool } from './index';

/**
 * read_page — 접근성 트리를 ref 가 붙은 평탄한 목록으로 준다.
 *
 * iframe 은 평탄화해 한 목록으로 합친다(사내 규정 포털이 iframe 중첩을 즐겨 쓴다).
 * `input[type=password]` 값은 여기서 마스킹된다 — 읽기 도구로 비밀번호가 새어 나가지 않는다.
 */

interface ReadPageArgs {
  tabId?: number;
  /** 상호작용 가능한 요소만 볼지. 기본은 전부. */
  filter?: 'all' | 'interactive';
  maxNodes?: number;
}

interface ReadPageResultOut {
  tabId: number;
  url: string;
  title: string;
  nodes: AxNode[];
  truncated: boolean;
  frames: number;
}

/** 클릭·입력이 가능한 역할. filter='interactive' 에서 남긴다. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab'
]);

const readPageTool: Tool<ReadPageArgs, ReadPageResultOut> = {
  name: 'read_page',
  description:
    '페이지를 접근성 트리로 읽는다. 각 노드에 ref 가 붙고, computer/form_input 이 그 ref 로 대상을 ' +
    `지정한다. ref 는 호출마다 다시 부여되므로 조작 직전에 읽어야 한다. 기본 상한 ${READ_PAGE_LIMIT}개. ` +
    'iframe 안쪽도 함께 평탄화되며, 경계는 frameId 로 표시된다. 비밀번호 입력 값은 *** 로 가려진다.',
  input: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['all', 'interactive'],
        description: 'interactive 면 클릭·입력 가능한 요소만'
      },
      maxNodes: { type: 'integer', minimum: 1, maximum: 1000 },
      ...TAB_ID_PROPERTY
    },
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      url: { type: 'string' },
      title: { type: 'string' },
      nodes: { type: 'array' },
      truncated: { type: 'boolean' },
      frames: { type: 'integer' }
    }
  },
  sideEffect: 'read',
  irreversible: false,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    const result = await readPage(wc, { limit: args.maxNodes ?? READ_PAGE_LIMIT });
    const nodes =
      args.filter === 'interactive'
        ? result.nodes.filter((node) => INTERACTIVE.has(node.role))
        : result.nodes;

    return {
      tabId,
      url: result.url,
      title: result.title,
      nodes,
      truncated: result.truncated,
      frames: result.frames
    };
  }
};

export function registerReadPageTool(): void {
  registerTool(readPageTool);
}
