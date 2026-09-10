import Ajv, { type ValidateFunction } from 'ajv';
import type { Session, WebContents } from 'electron';
import type { TabManager } from '../browser/TabManager';
import type { Downloads } from '../browser/Downloads';
import type { Overlay } from '../cobrowse/Overlay';
import type { Handoff } from '../control/Handoff';

/**
 * ToolSurface — AI 가 브라우저를 다루는 단일 도구 세트.
 *
 * 이름·인자는 Claude Browser 와 호환한다. 차이는 docs/tool-compat.md 에 적는다.
 * 내장 에이전트(M4)와 MCP 클라이언트가 같은 표면을 쓴다 — 여기가 유일한 진입점이다.
 */

/** JSON Schema 조각. ajv 가 검증하고 MCP 가 그대로 노출한다. */
export type JsonSchema = Record<string, unknown>;

export type SideEffect = 'read' | 'navigate' | 'input' | 'write' | 'exec' | 'persist';

/** 되돌리기 항목. M3 UndoManager 가 이 형태를 스택에 쌓는다. */
export interface UndoEntry {
  tool: string;
  describe: string;
  invert: () => Promise<void>;
}

export interface ToolContext {
  tabs: TabManager;
  session: Session;
  downloads: Downloads;
  overlay: Overlay;
  handoff: Handoff;
  /** 이 호출이 속한 스레드. M4 이전에는 MCP 연결 단위로 하나. */
  threadId: string;
  /** 도메인 접근 승인 요청. M3 정책 저장 전까지는 다이얼로그 결과만 돌려준다. */
  requestAccess: (host: string, reason: string) => Promise<boolean>;
  /** 사람에게 묻기. 로그인·캡차처럼 AI 가 진행할 수 없을 때. */
  askUser: (question: string, options: string[]) => Promise<{ answer: string }>;
  /** 업로드 파일 선택 등 파일 시스템 접근 루트. */
  downloadDir: string;
}

export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  sideEffect: SideEffect;
  /** true 면 Policy 가 승인을 강제한다(M3). */
  irreversible: boolean;
  /** 되돌리기 역연산. M3 에서 UndoManager 에 등록된다. */
  inverse?: (ctx: ToolContext, args: Args, result: Result) => UndoEntry | null;
  run(ctx: ToolContext, args: Args): Promise<Result>;
}

/** 사람이 개입해 멈춘 상태에서 도구를 부르면 이 형태로 돌아간다. */
export interface PausedResult {
  paused: true;
  reason: string;
  tabId: number | null;
}

export type ToolOutcome<T> = T | PausedResult;

export function isPaused<T>(value: ToolOutcome<T>): value is PausedResult {
  return typeof value === 'object' && value !== null && (value as PausedResult).paused === true;
}

// ─────────────────────────────────────────────────────────────
// 레지스트리
// ─────────────────────────────────────────────────────────────

const registry = new Map<string, Tool<never, never>>();
const validators = new Map<string, ValidateFunction>();

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });

export function registerTool<A, R>(tool: Tool<A, R>): void {
  if (registry.has(tool.name)) {
    throw new Error(`[tools] 이름 중복: ${tool.name}`);
  }
  registry.set(tool.name, tool as unknown as Tool<never, never>);
  validators.set(tool.name, ajv.compile(tool.input));
}

export function listTools(): Tool<never, never>[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getTool(name: string): Tool<never, never> | null {
  return registry.get(name) ?? null;
}

export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/**
 * 도구 호출 진입점.
 *
 * 순서는 CLAUDE.md 계약 그대로: 스키마 검증 → Handoff(일시정지) 확인 → run →
 * inverse 등록(M3) → 감사 로그 → Overlay 이벤트.
 * M2 에서는 Policy 훅과 UndoManager 가 아직 없으므로 자리만 비워 둔다(OUT OF SCOPE).
 */
export async function callTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown
): Promise<ToolOutcome<unknown>> {
  const tool = registry.get(name);
  if (!tool) {
    throw new ToolError('unknown_tool', `[tools] 없는 도구: ${name}`);
  }

  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const validate = validators.get(name);

  if (validate && !validate(args)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim())
      .join('; ');
    throw new ToolError('invalid_args', `[${name}] 인자 검증 실패: ${detail}`);
  }

  // 사람이 개입했으면 진행 중인 도구 호출은 여기서 멈춘다.
  const paused = ctx.handoff.pausedState(ctx.threadId);
  if (paused) return paused;

  const started = Date.now();
  try {
    const result = await (tool as unknown as Tool<Record<string, unknown>, unknown>).run(ctx, args);
    logCall(name, args, started, null);
    return result;
  } catch (error) {
    logCall(name, args, started, error as Error);
    throw error;
  }
}

/**
 * 감사 로그. M3 의 AuditLog(JSONL) 로 옮기기 전까지는 콘솔에 남긴다.
 * 인자에 자격증명이 섞일 수 있으므로 값은 길이만 남기고 내용은 적지 않는다.
 */
function logCall(name: string, args: Record<string, unknown>, started: number, error: Error | null): void {
  const shape = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? `str(${value.length})` : typeof value}`)
    .join(' ');
  const ms = Date.now() - started;

  if (error) console.warn(`[tool] ${name} 실패 ${ms}ms ${shape} :: ${error.message}`);
  else console.warn(`[tool] ${name} ok ${ms}ms ${shape}`);
}

// ─────────────────────────────────────────────────────────────
// 공통 헬퍼 — 도구 구현이 함께 쓰는 것
// ─────────────────────────────────────────────────────────────

/** tabId 를 생략하면 활성 탭. 없거나 죽었으면 에러. */
export function requireWebContents(ctx: ToolContext, tabId?: number): WebContents {
  const id = tabId ?? ctx.tabs.activeTabId;
  if (id === null || id === undefined) {
    throw new ToolError('no_tab', '[tools] 대상 탭이 없습니다. tabs_create 로 탭을 먼저 여세요.');
  }

  const wc = ctx.tabs.getWebContents(id);
  if (!wc) {
    throw new ToolError('no_tab', `[tools] 탭 ${id} 을(를) 찾을 수 없거나 언로드되었습니다.`);
  }
  return wc;
}

/** tabId 해석만 필요한 경우. */
export function requireTabId(ctx: ToolContext, tabId?: number): number {
  const id = tabId ?? ctx.tabs.activeTabId;
  if (id === null || id === undefined) {
    throw new ToolError('no_tab', '[tools] 대상 탭이 없습니다.');
  }
  return id;
}

/** 모든 도구가 공유하는 tabId 인자 스키마 조각. */
export const TAB_ID_PROPERTY = {
  tabId: {
    type: 'integer',
    minimum: 1,
    description: '대상 탭. 생략하면 활성 탭을 쓴다.'
  }
} as const;

/** 테스트가 레지스트리를 초기화할 때 쓴다. */
export function resetRegistryForTest(): void {
  registry.clear();
  validators.clear();
}
