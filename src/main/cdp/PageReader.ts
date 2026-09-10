import type { WebContents } from 'electron';
import { enableDomain, send } from './Debugger';

/**
 * 페이지 읽기 — 접근성 트리 기반 read_page 와 ref 매핑.
 *
 * DOM 을 그대로 넘기면 토큰이 폭발하고 AI 가 무엇을 누를지 판단하기 어렵다.
 * 접근성 트리는 "사람이 보는 것"에 가까워서 클릭 대상 선정에 적합하다.
 * iframe 은 별도 트리로 오는데, 사내 포털이 iframe 중첩을 즐겨 쓰므로 평탄화해서 하나로 준다.
 */

/** 한 번에 돌려주는 노드 상한. 넘으면 잘라내고 truncated 로 알린다. */
export const READ_PAGE_LIMIT = 200;

/** 값이 노출되면 안 되는 입력. 읽기 도구 전부에서 같은 규칙을 쓴다. */
export const MASKED_VALUE = '***';

export interface AxNode {
  /** 이번 호출에서만 유효한 참조. 호출마다 다시 부여한다(GOAL FIXED DECISIONS). */
  ref: string;
  role: string;
  name: string;
  /** 입력류의 현재 값. password 는 마스킹된다. */
  value?: string;
  /** 중첩 깊이 — 들여쓰기 렌더링용 */
  depth: number;
  /** iframe 경계를 넘었는지 표시 */
  frameId?: string;
  disabled?: boolean;
  focused?: boolean;
  checked?: boolean | 'mixed';
}

export interface ReadPageResult {
  url: string;
  title: string;
  nodes: AxNode[];
  truncated: boolean;
  /** 평탄화한 iframe 수 */
  frames: number;
}

/** ref → backendNodeId 매핑. 탭 단위로 보관한다. */
interface RefTable {
  /** ref 문자열 → { backendNodeId, frameSessionId } */
  entries: Map<string, { backendNodeId: number; sessionId?: string }>;
}

const refTables = new Map<number, RefTable>();

export function refTableFor(wc: WebContents): RefTable {
  const existing = refTables.get(wc.id);
  if (existing) return existing;
  const created: RefTable = { entries: new Map() };
  refTables.set(wc.id, created);
  return created;
}

export function resolveRef(
  wc: WebContents,
  ref: string
): { backendNodeId: number; sessionId?: string } | null {
  return refTableFor(wc).entries.get(ref) ?? null;
}

interface RawAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

/** 클릭·입력 대상이 될 수 있는 역할만 남긴다. 나머지는 텍스트로 흡수된다. */
const INTERESTING_ROLES = new Set([
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
  'tab',
  'heading',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'table',
  'list',
  'listitem',
  'img',
  'article',
  'form',
  'dialog',
  'alert',
  'status',
  'navigation',
  'main',
  'region',
  'iframe',
  'Iframe',
  'RootWebArea',
  'StaticText'
]);

function propOf(node: RawAxNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value?.value;
}

/** 불릿만으로 된 문자열(Chromium 이 비밀번호를 가린 형태)인지. */
const BULLETS_ONLY = /^[•*·●]{3,}$/;

/**
 * 프레임 안의 `input[type=password]` 의 backendNodeId 를 모은다.
 *
 * 접근성 트리의 속성 이름에 의존하지 않고 DOM 으로 직접 확인한다 —
 * Chromium 이 이미 값을 불릿으로 가려 주지만, 마스킹을 그 동작에 의존하지 않는다.
 */
async function passwordBackendIds(wc: WebContents, frameId: string): Promise<Set<number>> {
  const ids = new Set<number>();

  try {
    const doc = await send<{ root: { nodeId: number } }>(wc, 'DOM.getDocument', {
      depth: 1,
      frameId
    });

    const found = await send<{ nodeIds: number[] }>(wc, 'DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=password]'
    });

    for (const nodeId of found.nodeIds) {
      const described = await send<{ node: { backendNodeId?: number } }>(wc, 'DOM.describeNode', {
        nodeId
      });
      if (described.node.backendNodeId !== undefined) ids.add(described.node.backendNodeId);
    }
  } catch (error) {
    console.warn(`[passwordBackendIds] 조회 실패 - frame ${frameId}`, error);
  }

  return ids;
}

/**
 * 접근성 트리를 읽어 평탄한 노드 목록으로 만든다.
 *
 * `Accessibility.getFullAXTree` 는 iframe 안쪽을 포함하지 않으므로, 프레임마다 따로 호출해
 * 이어 붙인다. 프레임 경계는 frameId 로 표시해 AI 가 문맥을 알 수 있게 한다.
 */
export async function readPage(
  wc: WebContents,
  options: { limit?: number } = {}
): Promise<ReadPageResult> {
  const limit = options.limit ?? READ_PAGE_LIMIT;

  await enableDomain(wc, 'DOM');
  await enableDomain(wc, 'Accessibility');
  await enableDomain(wc, 'Page');

  const table = refTableFor(wc);
  table.entries.clear();

  const nodes: AxNode[] = [];
  let counter = 0;
  let truncated = false;

  const frameTree = await send<{ frameTree: FrameTree }>(wc, 'Page.getFrameTree');
  const frames = collectFrames(frameTree.frameTree);

  for (const frame of frames) {
    if (nodes.length >= limit) {
      truncated = true;
      break;
    }

    let tree: { nodes: RawAxNode[] };
    try {
      tree = await send<{ nodes: RawAxNode[] }>(wc, 'Accessibility.getFullAXTree', {
        frameId: frame.id
      });
    } catch (error) {
      // 크로스 오리진 iframe 등 접근이 막힌 프레임은 건너뛴다.
      console.warn(`[readPage] 프레임 트리 읽기 실패 - frameId ${frame.id}`, error);
      continue;
    }

    const secretIds = await passwordBackendIds(wc, frame.id);
    const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
    const roots = tree.nodes.filter(
      (node) => !tree.nodes.some((other) => other.childIds?.includes(node.nodeId))
    );

    const walk = (node: RawAxNode, depth: number): void => {
      if (nodes.length >= limit) {
        truncated = true;
        return;
      }

      const role = node.role?.value ?? '';
      const name = (node.name?.value ?? '').trim();

      if (!node.ignored && INTERESTING_ROLES.has(role) && (name !== '' || role !== 'StaticText')) {
        counter += 1;
        const ref = `ref_${counter}`;

        if (node.backendDOMNodeId !== undefined) {
          table.entries.set(ref, { backendNodeId: node.backendDOMNodeId });
        }

        // 비밀번호 입력이거나, 값이 불릿뿐이면(이미 가려진 값) 표기를 *** 로 통일한다.
        const isSecret =
          (node.backendDOMNodeId !== undefined && secretIds.has(node.backendDOMNodeId)) ||
          propOf(node, 'password') === true ||
          BULLETS_ONLY.test(name);

        const entry: AxNode = { ref, role, name: isSecret && BULLETS_ONLY.test(name) ? MASKED_VALUE : name, depth };

        const value = node.value?.value;
        if (typeof value === 'string' && value !== '') {
          // password 입력 값은 어떤 읽기 도구로도 새어 나가지 않는다.
          entry.value = isSecret || BULLETS_ONLY.test(value) ? MASKED_VALUE : value;
        }
        if (frame.id !== frames[0]?.id) entry.frameId = frame.id;
        if (propOf(node, 'disabled') === true) entry.disabled = true;
        if (propOf(node, 'focused') === true) entry.focused = true;

        const checked = propOf(node, 'checked');
        if (checked === true || checked === false || checked === 'mixed') {
          entry.checked = checked as boolean | 'mixed';
        }

        nodes.push(entry);
      }

      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) walk(child, depth + 1);
      }
    };

    for (const root of roots) walk(root, 0);
  }

  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    nodes,
    truncated,
    frames: frames.length
  };
}

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

function collectFrames(tree: FrameTree): { id: string; url: string }[] {
  const out = [{ id: tree.frame.id, url: tree.frame.url }];
  for (const child of tree.childFrames ?? []) out.push(...collectFrames(child));
  return out;
}

/**
 * 페이지 본문 텍스트. iframe 안쪽까지 이어 붙인다.
 *
 * `password` 입력 값은 DOM 에서 읽히지 않지만, value 속성을 노출하는 페이지가 있어
 * 추출 후 한 번 더 마스킹 규칙을 적용한다.
 */
export async function getPageText(
  wc: WebContents
): Promise<{ url: string; text: string; frames: number }> {
  await enableDomain(wc, 'Page');
  await enableDomain(wc, 'Runtime');

  const frameTree = await send<{ frameTree: FrameTree }>(wc, 'Page.getFrameTree');
  const frames = collectFrames(frameTree.frameTree);
  const chunks: string[] = [];

  for (const frame of frames) {
    const text = await evaluateInFrame<string>(
      wc,
      frame.id,
      '(document.body && document.body.innerText) ? document.body.innerText : ""'
    );
    if (typeof text === 'string' && text.trim() !== '') chunks.push(text.trim());
  }

  return { url: wc.getURL(), text: chunks.join('\n\n'), frames: frames.length };
}

/**
 * 특정 프레임 안에서 표현식을 평가한다.
 *
 * 프레임마다 격리 월드를 만들어 그 컨텍스트에서 실행한다 — 페이지 스크립트와 전역이 섞이지 않고
 * (Overlay 와 같은 원칙), iframe 안쪽도 같은 방법으로 읽을 수 있다.
 */
export async function evaluateInFrame<T>(
  wc: WebContents,
  frameId: string,
  expression: string
): Promise<T | null> {
  try {
    const world = await send<{ executionContextId: number }>(wc, 'Page.createIsolatedWorld', {
      frameId,
      worldName: 'helm-read',
      grantUniveralAccess: false
    });

    const result = await send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      wc,
      'Runtime.evaluate',
      {
        expression,
        contextId: world.executionContextId,
        returnByValue: true,
        awaitPromise: true
      }
    );

    if (result.exceptionDetails) return null;
    return (result.result?.value ?? null) as T | null;
  } catch (error) {
    // 접근이 막힌 프레임(크로스 오리진 등)은 조용히 건너뛴다 — 부분 결과가 없는 것보다 낫다.
    console.warn(`[evaluateInFrame] 평가 실패 - frame ${frameId}`, error);
    return null;
  }
}

/** 메인 프레임 id. 도구들이 프레임을 지정하지 않았을 때 쓴다. */
export async function mainFrameId(wc: WebContents): Promise<string> {
  await enableDomain(wc, 'Page');
  const tree = await send<{ frameTree: FrameTree }>(wc, 'Page.getFrameTree');
  return tree.frameTree.frame.id;
}

/** 페이지 HTML(메인 프레임). 읽기 모드 추출기와 공용으로 쓴다. */
export async function getPageHtml(wc: WebContents): Promise<string> {
  const frameId = await mainFrameId(wc);
  const html = await evaluateInFrame<string>(wc, frameId, 'document.documentElement.outerHTML');
  return html ?? '';
}
