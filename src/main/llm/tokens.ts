import type { LLMMessage, LLMToolDef } from './types';

/**
 * 프롬프트 토큰 예산.
 *
 * 토크나이저를 번들에 넣지 않는다 — 모델마다 다르고, 모델을 바꿀 때마다 의존성이 따라 바뀐다.
 * 대신 **글자 종류별 가중치로 추정**하고, 응답이 실제 `usage.prompt_tokens` 를 주면
 * `LLMClient` 가 그 비율로 추정치를 보정한다(`calibration`). 추정은 보수적으로 — 실제보다
 * 적게 잡으면 상한을 넘긴 요청이 그대로 나가서 공급자가 자르거나 거절한다.
 *
 * 줄일 때 지키는 것: **도구 호출과 그 결과의 짝을 깨지 않는다.** OpenAI 호환 API 는
 * `tool` 메시지가 자기를 부른 `assistant` 의 `tool_calls` 뒤에 와야 한다. 그래서 메시지를
 * 배열에서 빼지 않고 **내용만 자리 표시로 바꾼다** — 구조는 남고 토큰만 준다.
 */

/** 한글 음절·자모, CJK, 가나 — 토크나이저가 글자당 1 토큰에 가깝게 쪼개는 구간. */
function isWideScript(code: number): boolean {
  return (
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0x1100 && code <= 0x11ff) || // 한글 자모
    (code >= 0x3130 && code <= 0x318f) || // 호환 자모
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 한자
    (code >= 0x3040 && code <= 0x30ff) // 가나
  );
}

/** 글자당 토큰 가중치. 실측(qwen2.5 계열)에서 한글은 1 토큰/글자에 가깝고 라틴은 4 글자/토큰이다. */
const WIDE_WEIGHT = 1;
const NARROW_WEIGHT = 1 / 3.5;

/** JSON 구조 문자(중괄호·따옴표·콤마)는 라틴보다 촘촘하게 쪼개진다 — 메시지당 고정 비용으로 본다. */
const PER_MESSAGE_OVERHEAD = 8;

export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isWideScript(code)) wide += 1;
    else narrow += 1;
  }

  return Math.ceil(wide * WIDE_WEIGHT + narrow * NARROW_WEIGHT);
}

export function estimateMessageTokens(message: LLMMessage): number {
  let total = estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;

  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args)) + 4;
  }

  return total;
}

export function estimateMessagesTokens(messages: readonly LLMMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** 도구 정의도 프롬프트에 실린다 — 20개를 넘어가면 무시할 수 없는 크기다. */
export function estimateToolsTokens(tools: readonly LLMToolDef[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum +
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.parameters)) +
      6,
    0
  );
}

/** 줄인 자리에 남기는 표시. 사람이 감사 로그에서 "여기서 잘렸다" 를 알아볼 수 있어야 한다. */
export const ELIDED_MARK = '(예산 초과로 줄임)';

/** 마지막 몇 개는 건드리지 않는다 — 직전 단계의 결과까지 지우면 다음 수를 고를 수 없다. */
const KEEP_RECENT = 6;

export interface FitResult {
  messages: LLMMessage[];
  /** 내용을 줄인 메시지 수 */
  trimmed: number;
  estimatedTokens: number;
  /** 다 줄여도 예산을 못 맞췄는가 */
  overBudget: boolean;
}

/**
 * 예산에 맞게 메시지를 줄인다.
 *
 * 순서: 오래된 `tool` 결과 → 오래된 `assistant` 본문. `system` 과 최근 KEEP_RECENT 개,
 * 그리고 **마지막 사람 지시**는 건드리지 않는다. 목표를 잊은 채로 도는 것이 맥락을 잃는 것보다 나쁘다.
 */
export function fitToBudget(
  messages: readonly LLMMessage[],
  budget: number,
  scale = 1
): FitResult {
  const working = messages.map((message) => ({ ...message }));
  const scaled = (): number => Math.ceil(estimateMessagesTokens(working) * scale);

  let trimmed = 0;
  if (scaled() <= budget) {
    return { messages: working, trimmed, estimatedTokens: scaled(), overBudget: false };
  }

  const lastHumanIndex = working.map((m) => m.role).lastIndexOf('user');
  const protectedFrom = Math.max(0, working.length - KEEP_RECENT);

  const canElide = (index: number, message: LLMMessage, role: LLMMessage['role']): boolean =>
    message.role === role &&
    index !== lastHumanIndex &&
    index < protectedFrom &&
    message.content !== ELIDED_MARK &&
    message.content.length > 0;

  for (const role of ['tool', 'assistant'] as const) {
    for (let i = 0; i < working.length; i += 1) {
      if (scaled() <= budget) break;

      const message = working[i];
      if (!message || !canElide(i, message, role)) continue;

      message.content = ELIDED_MARK;
      trimmed += 1;
    }
  }

  const estimatedTokens = scaled();
  return { messages: working, trimmed, estimatedTokens, overBudget: estimatedTokens > budget };
}
