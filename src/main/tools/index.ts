import Ajv, { type ValidateFunction } from 'ajv';
import type { Session, WebContents } from 'electron';
import type { TabManager } from '../browser/TabManager';
import type { Downloads } from '../browser/Downloads';
import type { Overlay } from '../cobrowse/Overlay';
import type { Handoff } from '../control/Handoff';
import type { Approval } from '../control/Approval';
import type { Policy, PolicyVerdict } from '../control/Policy';
import type { UndoManager } from '../persistence/UndoManager';
import type { AuditLog } from '../audit/AuditLog';
import type { SessionStore } from '../sessions/SessionStore';
import type { ThreadStore } from '../persistence/ThreadStore';
import type {
  Checkpoint,
  CheckpointStore,
  CheckpointTrigger
} from '../persistence/CheckpointStore';
import type { Inbox } from '../persistence/Inbox';
import type { NoteStore } from '../persistence/NoteStore';
import type { BookmarkMeta } from '../persistence/BookmarkMeta';
import type { ChangeTracker } from '../persistence/ChangeTracker';
import { maskDeep } from '../control/Masking';
import { refLabel } from '../cdp/PageReader';

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

  // ── M3 제어 계층 ──
  policy: Policy;
  approval: Approval;
  undo: UndoManager;
  audit: AuditLog;
  /** 실행 단위. M4 에서 threadId 로 승격된다. 지금은 threadId 와 같은 값을 쓴다. */
  runId: string;
  /** 누가 부른 호출인가 — 감사 로그의 source */
  source: string;
  /**
   * 조작 도구 실행 직후 스크린샷을 찍는다(마스킹 적용됨).
   * 감사 로그가 단계별 화면을 갖도록 도구 밖에서 한 번에 처리한다.
   */
  captureStep: (tabId: number | null) => Promise<string | null>;

  // ── M4a 지속성 계층 ──
  sessions: SessionStore;
  threads: ThreadStore;
  checkpoints: CheckpointStore;
  inbox: Inbox;
  notes: NoteStore;
  bookmarkMeta: BookmarkMeta;
  changes: ChangeTracker;
  /**
   * 체크포인트를 만든다. 열린 AI 탭·스크롤 위치를 모으는 일은 메인이 안다(탭 관리자·CDP).
   * 도구는 "무엇을 남길지" 만 정한다.
   */
  saveCheckpoint: (input: {
    name: string;
    trigger: CheckpointTrigger;
    note?: string;
    cursor?: Record<string, unknown>;
    results?: unknown[];
  }) => Promise<Checkpoint>;
  /** 체크포인트로 되돌린다. 저장된 탭을 다시 열고 스크롤을 맞춘다. */
  restoreCheckpoint: (
    id: number
  ) => Promise<{ tabs: { tabId: number; url: string; sessionName: string }[] }>;
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

/**
 * 정책이 막았을 때의 결과. 오류가 아니라 결과다 —
 * 호출자가 "왜 막혔는지" 를 보고 다음 수를 정할 수 있어야 한다.
 */
export interface BlockedResult {
  blocked_by_policy: true;
  reason: string;
  tool: string;
  /** 사람이 거부했는가, 정책이 거부했는가 */
  by: 'policy' | 'user';
}

export type ToolOutcome<T> = T | PausedResult | BlockedResult;

export function isPaused<T>(value: ToolOutcome<T>): value is PausedResult {
  return typeof value === 'object' && value !== null && (value as PausedResult).paused === true;
}

export function isBlocked<T>(value: ToolOutcome<T>): value is BlockedResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as BlockedResult).blocked_by_policy === true
  );
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
 * 순서는 CLAUDE.md 계약 그대로:
 *   스키마 검증 → Handoff(일시정지) → Policy(거부 → 승인 → 마스킹) → run →
 *   inverse 등록(UndoManager) → 스크린샷 → 감사 로그.
 *
 * 마스킹은 결과를 호출자에게 돌려주기 전에 적용한다. 감사 로그도 같은 규칙을 쓰므로
 * 한쪽만 가려지는 일이 없다(GOAL-M3: 도구 결과·저장·스크린샷 3중 적용).
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
  const paused = ctx.handoff.pausedState(ctx.runId);
  if (paused) return paused;

  const started = Date.now();
  const target = describeTarget(ctx, tool, args);

  // ── Policy 훅: 거부 → 승인 필요 여부 → (마스킹은 도구 결과에서) ──
  const verdict = ctx.policy.evaluate({
    tool: name,
    host: target.host,
    ...(target.text === null ? {} : { targetText: target.text }),
    irreversible: tool.irreversible,
    sideEffect: effectiveSideEffect(tool, args),
    runId: ctx.runId
  });

  let grantScope: string | null = null;

  if (verdict.decision === 'deny') {
    const blocked: BlockedResult = {
      blocked_by_policy: true,
      reason: verdict.reason,
      tool: name,
      by: 'policy'
    };
    // 막힌 결과를 그대로 로그에 남긴다 — 나중에 "왜 안 됐나" 를 로그만 보고 알 수 있어야 한다.
    audit(ctx, name, args, target, blocked, started, verdict, null, `정책 거부: ${verdict.reason}`);
    return blocked;
  }

  if (verdict.decision === 'ask') {
    const answer = await ctx.approval.request({
      subject: verdict.subject,
      tool: name,
      action: verdict.action,
      host: target.host ?? '(no-host)',
      reason: verdict.reason,
      targetText: target.text,
      irreversible: tool.irreversible,
      runId: ctx.runId
    });

    if (!answer.granted) {
      const blocked: BlockedResult = {
        blocked_by_policy: true,
        reason: verdict.reason,
        tool: name,
        by: 'user'
      };
      audit(ctx, name, args, target, blocked, started, verdict, null, `사용자 거부: ${verdict.reason}`);
      return blocked;
    }

    grantScope = answer.scope;
    ctx.policy.recordGrant(verdict.subject, target.host ?? '(no-host)', answer.scope, ctx.runId);

    // 사이트 첫 접근을 허용했으면 이번 실행에서는 다시 묻지 않는다.
    if (verdict.action === 'site_first_visit' && target.host) ctx.policy.markVisited(target.host);
  }

  // 도구가 스스로 승인을 받는 경우(request_access)를 감사 로그에서 놓치지 않기 위한 기준선.
  const grantedBefore = ctx.approval.grantedCount(ctx.runId);

  try {
    const result = await (tool as unknown as Tool<Record<string, unknown>, unknown>).run(ctx, args);

    if (grantScope === null && ctx.approval.grantedCount(ctx.runId) > grantedBefore) {
      grantScope = ctx.approval.lastGranted(ctx.runId)?.scope ?? null;
    }

    // 되돌릴 수 있는 도구는 역연산을 스택에 쌓는다.
    if (!tool.irreversible && tool.inverse) {
      const entry = (
        tool as unknown as Tool<Record<string, unknown>, unknown>
      ).inverse?.(ctx, args, result);
      if (entry) ctx.undo.push(ctx.runId, entry);
    }

    // 제출·상신이 일어났으면 그 이전 입력은 되돌릴 수 없다.
    if (verdict.decision === 'ask' && (verdict.action === 'write_click' || verdict.action === 'form_submit')) {
      ctx.undo.seal(ctx.runId, `${target.text ?? verdict.action} 실행 후에는 되돌릴 수 없습니다`);
    }

    // 조작 도구는 실행 직후 화면을 남긴다.
    const effect = effectiveSideEffect(tool, args);
    const shot =
      effect === 'input' || effect === 'write' ? await ctx.captureStep(target.tabId) : null;

    // 결과를 돌려주기 전에 개인정보를 지운다. 이미지(base64)는 픽셀 단위로 이미 가려져 있다.
    const masked = maskDeep(result, { skipKeys: ['image'] });

    audit(ctx, name, args, target, masked.value, started, verdict, grantScope, null, shot, masked.review);

    // 스레드에 도구 호출을 남기고 스텝을 센다. 결과 전문은 감사 로그에 있으므로
    // 여기는 요약만 담는다 — 페이지 본문을 그대로 넣으면 DB 가 수십 MB 로 불어난다.
    recordStep(ctx, name, args, masked.value, effect);

    return masked.value;
  } catch (error) {
    audit(ctx, name, args, target, null, started, verdict, grantScope, (error as Error).message);
    throw error;
  }
}

/** 자동 체크포인트 간격(스텝). CheckpointStore 의 상수와 같은 값을 쓴다. */
const AUTO_CHECKPOINT_STEPS = 10;

/**
 * 스레드 기록과 자동 체크포인트.
 *
 * 자동 저장 트리거는 CLAUDE.md 그대로다: **10스텝마다 · 페이지 전환마다**
 * (ask_user 직전은 askUser 경로에서 처리한다). 실패해도 도구 결과를 버리지 않는다 —
 * 기록이 안 됐다고 이미 한 일을 되돌릴 수는 없다.
 */
function recordStep(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  effect: SideEffect
): void {
  try {
    ctx.threads.append(ctx.threadId, {
      role: 'tool',
      tool: name,
      args,
      result: compact(result)
    });

    const progress = ctx.threads.step(ctx.threadId);
    const navigated = effect === 'navigate';

    if (navigated || progress.count % AUTO_CHECKPOINT_STEPS === 0) {
      void ctx.saveCheckpoint({
        name: navigated ? `${name} 직후` : `${progress.count}스텝`,
        trigger: navigated ? 'navigate' : 'steps'
      }).catch((error) => {
        console.warn('[recordStep] 자동 체크포인트 실패', error);
      });
    }
  } catch (error) {
    console.warn('[recordStep] 스레드 기록 실패', error);
  }
}

/** 스레드 기록용 요약. 긴 문자열·배열을 잘라 DB 를 지키면서 "무엇을 했는지" 는 남긴다. */
function compact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 200)}…(${value.length}자)` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 5).map((item) => compact(item, depth + 1));
    return value.length > 5 ? [...head, `…(총 ${value.length}건)`] : head;
  }
  if (value !== null && typeof value === 'object' && depth < 3) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 이미지 base64 는 요약에서 제외한다.
      out[key] = key === 'image' ? '(생략)' : compact(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 실제 부수효과.
 *
 * `computer` 는 클릭·입력과 스크린샷을 한 도구에 담고 있어 선언된 sideEffect('input')가
 * 화면을 보는 호출에도 붙는다. 그대로 두면 화면 한 번 보는 데 승인을 요구하게 된다.
 */
function effectiveSideEffect(tool: Tool<never, never>, args: Record<string, unknown>): SideEffect {
  if (tool.name === 'computer') {
    const action = args['action'];
    if (action === 'screenshot' || action === 'zoom' || action === 'hover') return 'read';
  }
  return tool.sideEffect;
}

interface TargetInfo {
  tabId: number | null;
  host: string | null;
  url: string | null;
  /** 클릭 대상 문구 — Policy 의 쓰기 키워드 판정 근거 */
  text: string | null;
}

/**
 * 무엇을 대상으로 하는 호출인지 정리한다.
 * `ref` 로 지목된 요소의 문구를 꺼내는 것이 핵심이다 — "상신" 버튼을 누르려는지 알아야
 * Policy 가 승인을 요구할 수 있다.
 */
function describeTarget(
  ctx: ToolContext,
  tool: Tool<never, never>,
  args: Record<string, unknown>
): TargetInfo {
  const tabId =
    typeof args['tabId'] === 'number' ? (args['tabId'] as number) : ctx.tabs.activeTabId;

  // navigate 류는 "가려는 곳" 이 판정 대상이다. 현재 탭이 아니라 인자의 주소를 본다.
  const argUrl = typeof args['url'] === 'string' ? (args['url'] as string) : null;
  const wc = tabId === null ? null : ctx.tabs.getWebContents(tabId);
  const currentUrl = wc ? wc.getURL() : null;
  const url = argUrl ?? currentUrl;

  let text: string | null = null;
  const ref = typeof args['ref'] === 'string' ? (args['ref'] as string) : null;

  if (ref && wc) {
    text = refLabel(wc, ref);
  }

  /**
   * 인자의 text 를 판정 근거로 쓰는 것은 "무엇을 누르려는가" 를 알 때만이다.
   * `computer` 의 `type` 은 args.text 가 **입력할 내용**이라 여기 쓰면 안 된다 —
   * 본문에 "청구액" 을 적었다는 이유로 쓰기 클릭 승인을 요구하게 된다(시나리오 F 실측).
   */
  const typing = tool.name === 'computer' && args['action'] === 'type';
  if (!text && !typing && typeof args['text'] === 'string') text = args['text'] as string;
  if (!text && tool.name === 'javascript' && typeof args['code'] === 'string') {
    text = (args['code'] as string).slice(0, 80);
  }

  return { tabId, host: hostOf(url), url, text };
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** 감사 로그 한 줄. 인자·결과 마스킹은 AuditLog 안에서 한다. */
function audit(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  target: TargetInfo,
  result: unknown,
  started: number,
  verdict: PolicyVerdict,
  grantScope: string | null,
  error: string | null,
  screenshotPath: string | null = null,
  review = false
): void {
  ctx.audit.append({
    review,
    ts: started,
    source: ctx.source,
    runId: ctx.runId,
    tabId: target.tabId,
    url: target.url,
    tool,
    args,
    targetText: target.text,
    result,
    durationMs: Date.now() - started,
    screenshotPath,
    policyDecision: verdict.decision,
    grantScope,
    error
  });
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
