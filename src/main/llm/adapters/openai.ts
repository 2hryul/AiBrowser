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
 * OpenAI 호환 `/v1/chat/completions` 어댑터.
 *
 * 로컬 Ollama·vLLM·사내 게이트웨이가 모두 이 모양을 낸다. 공급자별 차이는 여기서 흡수하고
 * 밖으로는 `types.ts` 의 중립 모양만 내보낸다.
 *
 * 관대하게 받지 않는 곳이 하나 있다 — **도구 인자가 JSON 으로 안 풀리면 던진다.**
 * 빈 인자로 눙치면 에이전트가 "인자 없는 호출" 을 진짜 의도로 읽고 엉뚱한 페이지를 만진다.
 * 실패는 실패로 올려 보내고, 에이전트가 다시 묻게 한다.
 */

interface OpenAIToolCallPayload {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessagePayload {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCallPayload[];
}

interface OpenAIChoicePayload {
  message?: OpenAIMessagePayload;
  finish_reason?: string | null;
}

interface OpenAIResponsePayload {
  model?: string;
  choices?: OpenAIChoicePayload[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function toWireMessage(message: LLMMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content
    };
  }

  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) }
      }))
    };
  }

  return { role: message.role, content: message.content };
}

function parseToolCalls(payload: OpenAIToolCallPayload[] | undefined): LLMToolCall[] {
  const calls: LLMToolCall[] = [];

  for (const [index, raw] of (payload ?? []).entries()) {
    const name = raw.function?.name;
    if (typeof name !== 'string' || name.length === 0) continue;

    const rawArgs = raw.function?.arguments ?? '{}';
    let args: Record<string, unknown>;

    try {
      const parsed: unknown = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('객체가 아님');
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      throw new LLMError(
        'bad_response',
        `[llm] 도구 인자를 JSON 으로 읽을 수 없다 - 도구: ${name} · 원문: ${rawArgs.slice(0, 200)} · ${String(error)}`
      );
    }

    calls.push({ id: raw.id ?? `call_${index}`, name, args });
  }

  return calls;
}

export const openAIAdapter: LLMAdapter = {
  provider: 'openai',

  async chat(config: LLMConfig, request: LLMRequest, signal: AbortSignal): Promise<LLMRawResponse> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: request.messages.map(toWireMessage),
      temperature: request.temperature ?? 0,
      max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
      stream: false
    };

    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
    }

    if (request.jsonSchema) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: true
        }
      };
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;

    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers,
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

    let payload: OpenAIResponsePayload;
    try {
      payload = JSON.parse(text) as OpenAIResponsePayload;
    } catch (error) {
      throw new LLMError('bad_response', `[llm] 응답이 JSON 이 아니다 - ${String(error)}`);
    }

    if (payload.error?.message) {
      throw new LLMError('bad_response', `[llm] 공급자 오류 - ${payload.error.message}`);
    }

    const choice = payload.choices?.[0];
    if (!choice) {
      throw new LLMError('bad_response', `[llm] choices 가 비었다 - ${text.slice(0, 400)}`);
    }

    return {
      text: choice.message?.content ?? '',
      toolCalls: parseToolCalls(choice.message?.tool_calls),
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null
      },
      model: payload.model ?? config.model,
      finishReason: choice.finish_reason ?? null
    };
  }
};
