import { boxOfRef, setFormValue } from '../cdp/Actor';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, ToolError, type Tool } from './index';

/**
 * form_input — 폼 요소 값 설정.
 *
 * 체크박스·라디오는 boolean, 셀렉트·텍스트는 문자열을 받는다. 값을 넣은 뒤 input·change 를
 * 발생시켜 SPA 가 상태 변화를 알아채게 한다(포털 B 의 필터 패널이 이 경로다).
 *
 * inverse 로 이전 값을 복원한다 — 제출 전이라면 되돌릴 수 있다(M3 UndoManager 연결).
 */

interface Args {
  ref: string;
  value: string | boolean;
  tabId?: number;
}

interface Result {
  tabId: number;
  ref: string;
  applied: boolean;
  /** 설정 직전 값 — 되돌리기와 확인에 쓴다. */
  previousValue: string | boolean | null;
}

/** 현재 값을 읽는다. 되돌리기와 "정말 바뀌었나" 확인에 쓴다. */
async function currentValue(
  wc: Electron.WebContents,
  ref: string
): Promise<string | boolean | null> {
  const box = await boxOfRef(wc, ref);
  if (!box) return null;

  // 값 읽기는 ref → backendNodeId 경로가 이미 Actor 에 있으므로 그쪽 함수를 재사용한다.
  try {
    const { resolveRef } = await import('../cdp/PageReader');
    const { send } = await import('../cdp/Debugger');
    const entry = resolveRef(wc, ref);
    if (!entry) return null;

    const resolved = await send<{ object: { objectId?: string } }>(wc, 'DOM.resolveNode', {
      backendNodeId: entry.backendNodeId
    });
    if (!resolved.object.objectId) return null;

    const result = await send<{ result?: { value?: unknown } }>(wc, 'Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const type = (this.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return this.checked;
        return this.value === undefined ? null : String(this.value);
      }`
    });

    const value = result.result?.value;
    return typeof value === 'string' || typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

const formInput: Tool<Args, Result> = {
  name: 'form_input',
  description:
    'read_page/find 가 준 ref 의 폼 요소에 값을 넣는다. 체크박스·라디오는 true/false, ' +
    '셀렉트는 값 또는 표시 문자열, 나머지는 문자열을 받는다. 값 설정 후 input·change 이벤트가 발생한다.',
  input: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      value: { type: ['string', 'boolean'] },
      ...TAB_ID_PROPERTY
    },
    required: ['ref', 'value'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      ref: { type: 'string' },
      applied: { type: 'boolean' },
      previousValue: { type: ['string', 'boolean', 'null'] }
    }
  },
  sideEffect: 'input',
  irreversible: false,
  inverse(ctx, args, result) {
    if (result.previousValue === null) return null;
    const tabId = result.tabId;
    const previous = result.previousValue;

    return {
      tool: 'form_input',
      describe: `${args.ref} 값을 이전 값으로 복원`,
      invert: async () => {
        const wc = ctx.tabs.getWebContents(tabId);
        if (wc) await setFormValue(wc, args.ref, previous);
      }
    };
  },
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    const previousValue = await currentValue(wc, args.ref);
    const box = await boxOfRef(wc, args.ref);

    // 무엇에 값을 넣는지 보여준다.
    if (box) {
      await ctx.overlay.show({
        badge: 'AI 입력 중',
        cursor: box.center,
        boxes: [{ x: box.x, y: box.y, width: box.width, height: box.height }]
      });
    }

    const applied = await ctx.handoff.duringAction(() => setFormValue(wc, args.ref, args.value));
    if (!applied) {
      throw new ToolError('not_applied', `[form_input] ${args.ref} 에 값을 넣지 못했습니다`);
    }

    return { tabId, ref: args.ref, applied, previousValue };
  }
};

export function registerFormInputTool(): void {
  registerTool(formInput);
}
