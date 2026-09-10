import { nativeImage, type WebContents } from 'electron';
import {
  boxOfRef,
  click,
  doubleClick,
  drag,
  hover,
  key,
  resolveTarget,
  scroll,
  type as typeText,
  type Point,
  type Target
} from '../cdp/Actor';
import { readPage } from '../cdp/PageReader';
import { collectMaskBoxes, type PiiBox } from '../control/Masking';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, ToolError, type Tool } from './index';

/**
 * computer — 마우스·키보드·스크린샷.
 *
 * 조작 직전에 Overlay 로 대상 bbox 와 커서를 그린다. 사람이 "AI 가 지금 무엇을 누르는지" 를
 * 화면에서 볼 수 있어야 한다(불변 조건 2). 오버레이는 페이지 DOM 이 아니라 별도 View 다.
 *
 * 스크린샷에서 비밀번호 입력 영역은 가린다 — 화면 캡처로 자격증명이 새는 경로를 막는다.
 */

type Action =
  | 'screenshot'
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'hover'
  | 'zoom';

interface Args {
  action: Action;
  tabId?: number;
  ref?: string;
  coordinate?: [number, number];
  /** drag 의 시작점 */
  startCoordinate?: [number, number];
  text?: string;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  /** zoom 대상 영역 [x0, y0, x1, y1] */
  region?: [number, number, number, number];
  /** screenshot 축소 비율 0.1~1 */
  scale?: number;
}

interface Result {
  tabId: number;
  action: Action;
  /** action==='type' 일 때 입력 전 값 — 되돌리기에 쓴다. */
  previousValue?: string | null;
  /** screenshot/zoom 일 때 PNG base64 */
  image?: string;
  width?: number;
  height?: number;
  /** 가려진 영역 수(비밀번호 + 개인정보) */
  maskedRegions?: number;
  point?: Point;
  ok: boolean;
}

const SCROLL_STEP = 120;

/**
 * 스크린샷에서 가릴 사각형.
 * 비밀번호 입력과 개인정보(사번·전화·이메일) 텍스트를 모두 포함한다 — 규칙은 Masking 이 갖는다.
 */
async function maskTargets(wc: WebContents): Promise<PiiBox[]> {
  return collectMaskBoxes(wc);
}

/**
 * 캡처 이미지에서 비밀번호·개인정보 영역을 지운다.
 *
 * 블러 대신 단색으로 덮는다 — 블러는 원본 정보가 남아 복원될 여지가 있고, 검증도 애매하다.
 * 픽셀 검사로 "가려졌음" 을 단언할 수 있는 편이 낫다.
 */
function maskBitmap(
  bitmap: Buffer,
  width: number,
  height: number,
  scaleFactor: number,
  boxes: readonly PiiBox[]
): number {
  let masked = 0;

  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x * scaleFactor));
    const y0 = Math.max(0, Math.floor(box.y * scaleFactor));
    const x1 = Math.min(width, Math.ceil((box.x + box.width) * scaleFactor));
    const y1 = Math.min(height, Math.ceil((box.y + box.height) * scaleFactor));
    if (x1 <= x0 || y1 <= y0) continue;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * width + x) * 4;
        // BGRA 순서. 눈에 띄는 단색으로 덮어 "가렸다" 는 사실이 보이게 한다.
        bitmap[offset] = 40;
        bitmap[offset + 1] = 40;
        bitmap[offset + 2] = 40;
        bitmap[offset + 3] = 255;
      }
    }
    masked += 1;
  }

  return masked;
}

/**
 * 마스킹이 적용된 화면 캡처.
 *
 * 감사 로그의 단계 스크린샷도 이 함수를 쓴다 — 도구 호출을 한 번 더 거치면 Policy 훅에 걸려
 * 승인을 기다리다 교착된다(스크린샷 하나 때문에 사람에게 묻는 것도 이상하다).
 */
export async function captureMasked(
  wc: WebContents,
  options: { region?: [number, number, number, number]; scale?: number } = {}
): Promise<{ image: string; width: number; height: number; maskedRegions: number }> {
  const rect = options.region
    ? {
        x: Math.round(options.region[0]),
        y: Math.round(options.region[1]),
        width: Math.round(options.region[2] - options.region[0]),
        height: Math.round(options.region[3] - options.region[1])
      }
    : undefined;

  const shot = rect ? await wc.capturePage(rect) : await wc.capturePage();
  const size = shot.getSize();
  const bitmap = Buffer.from(shot.toBitmap());

  // 캡처는 device px, DOM 좌표는 CSS px 이다. 페이지에 직접 물어 배율을 구한다
  // (창 배율을 추측하면 125% 같은 환경에서 마스킹 위치가 어긋난다).
  const viewportWidth = await cssViewportWidth(wc);
  const scaleFactor = rect
    ? size.width / Math.max(1, rect.width)
    : size.width / Math.max(1, viewportWidth);

  const boxes = (await maskTargets(wc)).map((box) =>
    rect ? { ...box, x: box.x - rect.x, y: box.y - rect.y } : box
  );
  const maskedRegions = maskBitmap(bitmap, size.width, size.height, scaleFactor, boxes);

  let image = nativeImage.createFromBitmap(bitmap, size);
  if (options.scale && options.scale > 0 && options.scale < 1) {
    image = image.resize({
      width: Math.max(1, Math.round(size.width * options.scale)),
      quality: 'good'
    });
  }

  const finalSize = image.getSize();
  return {
    image: image.toPNG().toString('base64'),
    width: finalSize.width,
    height: finalSize.height,
    maskedRegions
  };
}

/** 페이지의 CSS 뷰포트 폭. 실패하면 0 을 돌려 배율 1배로 떨어진다. */
async function cssViewportWidth(wc: WebContents): Promise<number> {
  try {
    const width = (await wc.executeJavaScript('window.innerWidth')) as unknown;
    return typeof width === 'number' && width > 0 ? width : 0;
  } catch {
    return 0;
  }
}

const computer: Tool<Args, Result> = {
  name: 'computer',
  description:
    '마우스·키보드로 페이지를 조작하고 화면을 캡처한다. 대상은 read_page/find 가 준 ref 또는 ' +
    '좌표로 지정한다. 조작 직전에 화면에 대상 표시(하이라이트·커서)가 나타난다. ' +
    '스크린샷에서 비밀번호 입력과 개인정보(사번·전화·이메일) 영역은 가려진다.',
  input: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'screenshot',
          'left_click',
          'right_click',
          'double_click',
          'type',
          'key',
          'scroll',
          'drag',
          'hover',
          'zoom'
        ]
      },
      ref: { type: 'string', description: 'read_page/find 가 준 참조' },
      coordinate: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2
      },
      startCoordinate: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2
      },
      text: { type: 'string', description: 'type 의 입력 문자열, key 의 조합(예: ctrl+a)' },
      scrollDirection: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scrollAmount: { type: 'integer', minimum: 1, maximum: 50 },
      region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
      scale: { type: 'number', minimum: 0.1, maximum: 1 },
      ...TAB_ID_PROPERTY
    },
    required: ['action'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      action: { type: 'string' },
      ok: { type: 'boolean' },
      image: { type: 'string' },
      maskedRegions: { type: 'integer' }
    }
  },
  sideEffect: 'input',
  irreversible: false,
  /**
   * `type` 만 되돌릴 수 있다 — 입력 전 값을 복원한다(제출 전 한정).
   * 클릭·스크롤·키는 되돌릴 대상이 없어 null 을 돌려준다. 쓰기 클릭은 Policy 가 승인으로 막고,
   * 승인이 나면 그 이전 입력이 봉인된다(UndoManager.seal).
   */
  inverse(ctx, args, result) {
    if (args.action !== 'type' || typeof result.previousValue !== 'string') return null;
    if (!args.ref) return null;

    const previous = result.previousValue;
    const ref = args.ref;

    return {
      tool: 'computer',
      describe: `${ref} 입력 되돌리기`,
      invert: async () => {
        const wc = ctx.tabs.getWebContents(result.tabId);
        if (!wc) return;
        const { setFormValue } = await import('../cdp/Actor');
        await setFormValue(wc, ref, previous);
      }
    };
  },
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    if (args.action === 'screenshot' || args.action === 'zoom') {
      const shot = await captureMasked(wc, {
        ...(args.region ? { region: args.region } : {}),
        ...(args.scale ? { scale: args.scale } : {})
      });
      return { tabId, action: args.action, ok: true, ...shot };
    }

    const target: Target = {
      ...(args.ref ? { ref: args.ref } : {}),
      ...(args.coordinate ? { coordinate: args.coordinate } : {})
    };

    // 조작 전에 무엇을 건드리는지 보여준다.
    const showTarget = async (point: Point): Promise<void> => {
      const box = args.ref ? await boxOfRef(wc, args.ref) : null;
      await ctx.overlay.show({
        badge: 'AI 조작 중',
        cursor: point,
        boxes: box ? [{ x: box.x, y: box.y, width: box.width, height: box.height }] : []
      });
    };

    return ctx.handoff.duringAction(async () => {
      switch (args.action) {
        case 'left_click':
        case 'right_click':
        case 'double_click':
        case 'hover': {
          const { point } = await resolveTarget(wc, target);
          await showTarget(point);

          if (args.action === 'hover') await hover(wc, point);
          else if (args.action === 'double_click') await doubleClick(wc, point);
          else await click(wc, point, { button: args.action === 'right_click' ? 'right' : 'left' });

          return { tabId, action: args.action, ok: true, point };
        }

        case 'type': {
          if (typeof args.text !== 'string') {
            throw new ToolError('missing_text', '[computer] type 에는 text 가 필요합니다');
          }
          const { point } = await resolveTarget(wc, target);

          // 되돌리기를 위해 입력 전 값을 먼저 읽는다.
          const previousValue = args.ref ? await readFieldValue(wc, args.ref) : null;

          await showTarget(point);
          await typeText(wc, target, args.text);
          return { tabId, action: args.action, ok: true, point, previousValue };
        }

        case 'key': {
          if (typeof args.text !== 'string') {
            throw new ToolError('missing_text', '[computer] key 에는 text(예: enter)가 필요합니다');
          }
          await key(wc, args.text);
          return { tabId, action: args.action, ok: true };
        }

        case 'scroll': {
          const point = args.coordinate
            ? { x: args.coordinate[0], y: args.coordinate[1] }
            : (await resolveScrollPoint(wc, args.ref)) ?? { x: 200, y: 200 };

          const amount = (args.scrollAmount ?? 3) * SCROLL_STEP;
          const direction = args.scrollDirection ?? 'down';
          const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
          const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;

          await scroll(wc, point, deltaX, deltaY);
          return { tabId, action: args.action, ok: true, point };
        }

        case 'drag': {
          if (!args.startCoordinate || !args.coordinate) {
            throw new ToolError('missing_points', '[computer] drag 에는 startCoordinate 와 coordinate 가 필요합니다');
          }
          const from = { x: args.startCoordinate[0], y: args.startCoordinate[1] };
          const to = { x: args.coordinate[0], y: args.coordinate[1] };
          await showTarget(to);
          await drag(wc, from, to);
          return { tabId, action: args.action, ok: true, point: to };
        }

        default:
          throw new ToolError('unknown_action', `[computer] 알 수 없는 action: ${String(args.action)}`);
      }
    });
  }
};

/**
 * 입력 필드의 현재 값. 되돌리기 전 상태를 남기기 위해 읽는다.
 * contenteditable 도 함께 다룬다 — 사내 결재 시스템의 본문 편집기가 그 모양이다.
 */
async function readFieldValue(wc: WebContents, ref: string): Promise<string | null> {
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
        if (this.isContentEditable) return this.innerText;
        return this.value === undefined ? null : String(this.value);
      }`
    });

    const value = result.result?.value;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** 스크롤 대상이 ref 로 주어지면 그 요소 위에서 굴린다(가상 스크롤 컨테이너). */
async function resolveScrollPoint(wc: WebContents, ref?: string): Promise<Point | null> {
  if (!ref) return null;
  const box = await boxOfRef(wc, ref);
  return box ? box.center : null;
}

/** find 없이 곧바로 조작할 때를 대비해 ref 매핑을 갱신해 두는 보조 도구. */
export async function refreshRefs(wc: WebContents): Promise<void> {
  await readPage(wc, { limit: 500 });
}

export function registerComputerTool(): void {
  registerTool(computer);
}
