import {
  LLMError,
  type LLMAdapter,
  type LLMConfig,
  type LLMMessage,
  type LLMRawResponse,
  type LLMRequest,
  type LLMToolCall
} from '../types';

/**
 * Anthropic Messages API 어댑터 — 개발 초기 검증용 경로(GOAL-M4 PRECONDITIONS, 선택).
 *
 * 사내 배포는 로컬 모델(OpenAI 호환)로 간다. 이 어댑터는 "에이전트가 못 도는 것인지,
 * 7B 모델이 못 하는 것인지" 를 가를 때 쓴다 — 같은 프롬프트·같은 ToolSurface 로 더 큰 모델을
 * 물려 보고 차이를 본다.
 *
 * SDK(`@anthropic-ai/sdk`)를 쓰지 않고 fetch 로 직접 부른다. 이유는 두 가지다 —
 * 기술 스택 변경은 사용자 합의 사항이고(CLAUDE.md), 이 계층은 공급자 중립 어댑터라
 * 한쪽 공급자의 SDK 를 메인 번들에 들이면 대칭이 깨진다. 요청/응답 모양은
 * Messages API 계약 그대로다(`anthropic-version: 2023-06-01`).
 *
 * OpenAI 호환과 다른 점 셋:
 *   1. system 은 메시지 배열이 아니라 top-level 필드다
 *   2. 도구 결과는 `tool` 역할이 아니라 **user 메시지 안의 `tool_result` 블록**이다
 *   3. 거절(`stop_reason: 'refusal'`)이 200 으로 온다 — 내용이 비었다고 조용히 넘기지 않는다
 */

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponsePayload {
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** 우리 쪽 평면 메시지를 Anthropic 의 블록 구조로 옮긴다. */
function toWireMessages(messages: readonly LLMMessage[]): {
  system: string;
  wire: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const wire: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content
      };

      // 연속된 도구 결과는 한 user 메시지로 모은다 — 병렬 호출의 결과를 쪼개면
      // 다음 턴부터 병렬 호출이 줄어든다.
      const last = wire[wire.length - 1];
      const lastContent = last?.['content'];
      if (last?.['role'] === 'user' && Array.isArray(lastContent)) {
        const first: unknown = lastContent[0];
        if (typeof first === 'object' && first !== null && 'type' in first) {
          if ((first as { type?: string }).type === 'tool_result') {
            lastContent.push(block);
            continue;
          }
        }
      }

      wire.push({ role: 'user', content: [block] });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: Record<string, unknown>[] = [];
      if (message.content.trim() !== '') blocks.push({ type: 'text', text: message.content });

      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }

      wire.push({ role: 'assistant', content: blocks });
      continue;
    }

    wire.push({ role: message.role, content: message.content });
  }

  return { system: systemParts.join('\n\n'), wire };
}

function parseToolUse(blocks: readonly AnthropicContentBlock[]): LLMToolCall[] {
  const calls: LLMToolCall[] = [];

  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'tool_use') continue;

    const name = block.name;
    if (typeof name !== 'string' || name.length === 0) continue;

    const input = block.input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new LLMError(
        'bad_response',
        `[llm] tool_use 의 input 이 객체가 아니다 - 도구: ${name} · 값: ${JSON.stringify(input).slice(0, 200)}`
      );
    }

    calls.push({
      id: block.id ?? `toolu_${index}`,
      name,
      args: input as Record<string, unknown>
    });
  }

  return calls;
}

export const anthropicAdapter: LLMAdapter = {
  provider: 'anthropic',

  async chat(config: LLMConfig, request: LLMRequest, signal: AbortSignal): Promise<LLMRawResponse> {
    if (!config.apiKey) {
      throw new LLMError('config_missing', '[llm] Anthropic 어댑터에는 apiKey 가 필요하다');
    }

    const { system, wire } = toWireMessages(request.messages);

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
      messages: wire
    };

    if (system !== '') body['system'] = system;

    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }));
    }

    if (request.jsonSchema) {
      body['output_config'] = {
        format: { type: 'json_schema', schema: request.jsonSchema.schema }
      };
    }

    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(body),
      signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new LLMError(
        'http_error',
        `[llm] ${response.status} ${response.statusText} - ${text.slice(0, 400)}`
      );
    }

    let payload: AnthropicResponsePayload;
    try {
      payload = JSON.parse(text) as AnthropicResponsePayload;
    } catch (error) {
      throw new LLMError('bad_response', `[llm] 응답이 JSON 이 아니다 - ${String(error)}`);
    }

    if (payload.error?.message) {
      throw new LLMError('bad_response', `[llm] 공급자 오류 - ${payload.error.message}`);
    }

    const blocks = payload.content ?? [];

    // 거절은 200 으로 온다. 빈 응답으로 흘려보내면 에이전트가 "모델이 할 말이 없구나" 로 읽는다.
    if (payload.stop_reason === 'refusal') {
      const category = payload.stop_details?.category ?? '(미상)';
      throw new LLMError('bad_response', `[llm] 모델이 요청을 거절했다 - 분류: ${category}`);
    }

    const textOut = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text: textOut,
      toolCalls: parseToolUse(blocks),
      usage: {
        promptTokens: payload.usage?.input_tokens ?? null,
        completionTokens: payload.usage?.output_tokens ?? null
      },
      model: payload.model ?? config.model,
      finishReason: payload.stop_reason ?? null
    };
  }
};
