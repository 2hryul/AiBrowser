import type { WebContents } from 'electron';
import { enableDomain, send } from './Debugger';
import { resolveRef } from './PageReader';

/**
 * 페이지 조작 — 클릭·입력·키·스크롤·드래그.
 *
 * 좌표는 `DOM.getBoxModel` 로 요소 중심을 구하고 `Input.dispatchMouseEvent` 로 보낸다
 * (GOAL-M2 FIXED DECISIONS). 합성 이벤트를 DOM 에 직접 쏘지 않는 이유는, 사내 포털이
 * 신뢰된 이벤트(isTrusted)만 처리하는 경우가 있고 그게 진짜 사용자 조작에 가깝기 때문이다.
 * 봇 탐지 우회 목적의 입력 위조는 하지 않는다(CLAUDE.md 불변 조건 9).
 */

export interface Point {
  x: number;
  y: number;
}

export interface BoxModel {
  /** 뷰포트 좌표계의 사각형 */
  x: number;
  y: number;
  width: number;
  height: number;
  center: Point;
}

/** ref 또는 좌표로 대상을 지정한다. Claude Browser 와 같은 방식. */
export interface Target {
  ref?: string;
  coordinate?: [number, number];
}

export async function boxOfRef(wc: WebContents, ref: string): Promise<BoxModel | null> {
  const entry = resolveRef(wc, ref);
  if (!entry) return null;

  await enableDomain(wc, 'DOM');

  try {
    const result = await send<{ model?: { content: number[]; width: number; height: number } }>(
      wc,
      'DOM.getBoxModel',
      { backendNodeId: entry.backendNodeId }
    );

    const quad = result.model?.content;
    if (!quad || quad.length < 8) return null;

    // content quad 는 [x1,y1, x2,y2, x3,y3, x4,y4] 순서다.
    const xs = [quad[0], quad[2], quad[4], quad[6]].filter((n): n is number => typeof n === 'number');
    const ys = [quad[1], quad[3], quad[5], quad[7]].filter((n): n is number => typeof n === 'number');
    if (xs.length < 4 || ys.length < 4) return null;

    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;

    return { x, y, width, height, center: { x: x + width / 2, y: y + height / 2 } };
  } catch (error) {
    console.warn(`[boxOfRef] 박스 계산 실패 - ref ${ref}`, error);
    return null;
  }
}

/** 대상을 화면 좌표로 바꾼다. ref 면 먼저 화면 안으로 스크롤한다. */
export async function resolveTarget(
  wc: WebContents,
  target: Target
): Promise<{ point: Point; box: BoxModel | null }> {
  if (target.coordinate) {
    const [x, y] = target.coordinate;
    return { point: { x, y }, box: null };
  }

  if (!target.ref) throw new Error('[resolveTarget] ref 또는 coordinate 중 하나가 필요합니다');

  const entry = resolveRef(wc, target.ref);
  if (!entry) {
    throw new Error(
      `[resolveTarget] 알 수 없는 ref: ${target.ref}. read_page 를 다시 호출해 ref 를 갱신하세요.`
    );
  }

  await enableDomain(wc, 'DOM');
  try {
    await send(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId });
  } catch {
    // 스크롤이 불가능한 요소(문서 밖 등)여도 좌표 계산은 시도한다.
  }

  const box = await boxOfRef(wc, target.ref);
  if (!box) {
    throw new Error(`[resolveTarget] ref ${target.ref} 의 위치를 구하지 못했습니다(화면에 없음)`);
  }

  return { point: box.center, box };
}

export type MouseButton = 'left' | 'right' | 'middle';

async function mouse(
  wc: WebContents,
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  point: Point,
  button: MouseButton,
  clickCount: number
): Promise<void> {
  await enableDomain(wc, 'Input');
  await send(wc, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: type === 'mouseMoved' ? 'none' : button,
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount
  });
}

export async function click(
  wc: WebContents,
  point: Point,
  options: { button?: MouseButton; clickCount?: number } = {}
): Promise<void> {
  const button = options.button ?? 'left';
  const clickCount = options.clickCount ?? 1;

  // 이동 → 누름 → 뗌 순서로 보내야 hover 로 열리는 메뉴도 정상 동작한다.
  await mouse(wc, 'mouseMoved', point, button, 0);
  await mouse(wc, 'mousePressed', point, button, clickCount);
  await mouse(wc, 'mouseReleased', point, button, clickCount);
}

export async function doubleClick(wc: WebContents, point: Point): Promise<void> {
  await click(wc, point, { clickCount: 1 });
  await click(wc, point, { clickCount: 2 });
}

export async function hover(wc: WebContents, point: Point): Promise<void> {
  await mouse(wc, 'mouseMoved', point, 'left', 0);
}

export async function drag(wc: WebContents, from: Point, to: Point): Promise<void> {
  await mouse(wc, 'mouseMoved', from, 'left', 0);
  await mouse(wc, 'mousePressed', from, 'left', 1);
  // 중간 지점을 하나 거쳐야 드래그로 인식하는 UI 가 있다.
  await mouse(wc, 'mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, 'left', 1);
  await mouse(wc, 'mouseMoved', to, 'left', 1);
  await mouse(wc, 'mouseReleased', to, 'left', 1);
}

/**
 * 텍스트 입력. 포커스를 준 뒤 `Input.insertText` 로 한 번에 넣는다.
 * 글자마다 키 이벤트를 만드는 방식은 느리고, IME 가 필요한 한글에서 어차피 정확하지 않다.
 */
export async function type(
  wc: WebContents,
  target: Target,
  text: string,
  options: { clear?: boolean } = {}
): Promise<void> {
  await enableDomain(wc, 'DOM');
  await enableDomain(wc, 'Input');

  if (target.ref) {
    const entry = resolveRef(wc, target.ref);
    if (!entry) throw new Error(`[type] 알 수 없는 ref: ${target.ref}`);
    await send(wc, 'DOM.focus', { backendNodeId: entry.backendNodeId });
  } else if (target.coordinate) {
    await click(wc, { x: target.coordinate[0], y: target.coordinate[1] });
  }

  if (options.clear) {
    // 전체 선택 후 덮어쓴다. 필드 종류에 상관없이 동작한다.
    await key(wc, 'ctrl+a');
  }

  await send(wc, 'Input.insertText', { text });
}

/** 키 이름 → CDP 키 정보. 필요한 것만 표로 둔다. */
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  a: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }
};

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, shift: 8 };

/** `ctrl+a`, `enter` 같은 표기를 받아 키를 보낸다. */
export async function key(wc: WebContents, combo: string): Promise<void> {
  await enableDomain(wc, 'Input');

  const parts = combo.toLowerCase().split('+').map((part) => part.trim());
  const name = parts[parts.length - 1] ?? '';
  const modifiers = parts
    .slice(0, -1)
    .reduce((bits, part) => bits | (MODIFIER_BITS[part] ?? 0), 0);

  const mapped = KEY_MAP[name];
  if (!mapped) {
    throw new Error(`[key] 지원하지 않는 키: ${combo}. 지원 목록: ${Object.keys(KEY_MAP).join(', ')}`);
  }

  const base = {
    modifiers,
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    nativeVirtualKeyCode: mapped.windowsVirtualKeyCode
  };

  // 문자 키는 keyDown 에 text 를 실어야 입력이 들어간다. 조합키가 있으면 rawKeyDown 이다.
  await send(wc, 'Input.dispatchKeyEvent', {
    ...base,
    type: modifiers === 0 && mapped.text ? 'keyDown' : 'rawKeyDown',
    ...(modifiers === 0 && mapped.text ? { text: mapped.text } : {})
  });
  await send(wc, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

export async function scroll(
  wc: WebContents,
  point: Point,
  deltaX: number,
  deltaY: number
): Promise<void> {
  await enableDomain(wc, 'Input');
  await send(wc, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(point.x),
    y: Math.round(point.y),
    deltaX,
    deltaY
  });
}

/**
 * 셀렉트·체크박스 등 폼 요소 값 설정.
 * 값을 넣은 뒤 input·change 를 발생시켜야 SPA 가 상태 변화를 알아챈다.
 */
export async function setFormValue(
  wc: WebContents,
  ref: string,
  value: string | boolean
): Promise<boolean> {
  const entry = resolveRef(wc, ref);
  if (!entry) throw new Error(`[setFormValue] 알 수 없는 ref: ${ref}`);

  await enableDomain(wc, 'DOM');
  const resolved = await send<{ object: { objectId?: string } }>(wc, 'DOM.resolveNode', {
    backendNodeId: entry.backendNodeId
  });

  const objectId = resolved.object.objectId;
  if (!objectId) return false;

  const result = await send<{ result?: { value?: unknown } }>(wc, 'Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: `function (value) {
      const el = this;
      const tag = (el.tagName || '').toLowerCase();
      const type = (el.type || '').toLowerCase();

      if (type === 'checkbox' || type === 'radio') {
        el.checked = value === true || value === 'true';
      } else if (tag === 'select') {
        el.value = String(value);
        if (el.selectedIndex === -1) {
          const option = Array.from(el.options).find((o) => o.textContent.trim() === String(value));
          if (option) el.value = option.value;
        }
      } else {
        el.value = String(value);
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`,
    arguments: [{ value }]
  });

  return result.result?.value === true;
}
