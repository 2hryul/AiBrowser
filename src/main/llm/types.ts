/**
 * LLM 계층의 공용 타입.
 *
 * 어댑터(openai / anthropic)와 `LLMClient` 가 서로를 import 하면 순환이 생긴다.
 * 모양은 여기 한 곳에만 둔다.
 *
 * 이 타입들은 **공급자 중립**이다 — OpenAI 의 `tool_calls` 나 Anthropic 의 `tool_use` 같은
 * 공급자별 모양은 어댑터 안에서만 다루고, 밖으로는 아래 모양만 나온다. 에이전트가 공급자를
 * 아는 순간 모델을 바꿀 수 없게 된다.
 */

/** JSON Schema 조각. ToolSurface 의 input 스키마를 그대로 넘긴다. */
export type JsonSchema = Record<string, unknown>;

/** `openai` 는 OpenAI 호환 `/v1/chat/completions` 를 말한다(Ollama·vLLM·사내 게이트웨이). */
export type LLMProvider = 'openai' | 'anthropic';

export interface LLMConfig {
  provider: LLMProvider;
  /** 전체 엔드포인트 URL. 코드에 기본 호스트를 박지 않는다(CLAUDE.md 보안 기본값). */
  baseUrl: string;
  /** 빈 문자열이면 인증 헤더를 붙이지 않는다 — 로컬 Ollama 가 그렇다. */
  apiKey: string;
  model: string;
  /** 프롬프트 토큰 상한(GOAL-M4 M4b: 8k). 넘으면 오래된 단계부터 줄인다. */
  maxPromptTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LLMToolDef {
  name: string;
  description: string;
  /** ToolSurface 의 `input` 스키마 */
  parameters: JsonSchema;
}

export interface LLMToolCall {
  /** 공급자가 준 호출 id. tool 결과를 되돌려줄 때 짝을 맞춘다. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LLMMessage {
  role: LLMRole;
  content: string;
  /** assistant 가 도구를 부른 경우 */
  toolCalls?: LLMToolCall[];
  /** tool 결과 메시지가 어느 호출에 대한 답인지 */
  toolCallId?: string;
  /** tool 결과 메시지의 도구 이름 */
  name?: string;
}

export interface LLMRequest {
  /** 감사 로그에 남는 호출 목적 — `agent.step`, `find.rank`, `extract.table` 처럼 */
  purpose: string;
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  /** 구조화 출력. 주면 도구 호출 대신 이 스키마에 맞는 JSON 을 받는다. */
  jsonSchema?: { name: string; schema: JsonSchema };
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LLMUsage {
  /** 공급자가 usage 를 주지 않으면 null — 추정값으로 덮어쓰지 않는다. */
  promptTokens: number | null;
  completionTokens: number | null;
}

/** 어댑터가 돌려주는 것. 소요 시간·트리밍 같은 관리 정보는 클라이언트가 붙인다. */
export interface LLMRawResponse {
  text: string;
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  /** 모델이 왜 멈췄는가 — 길이 초과를 조용히 넘기지 않기 위해 본다. */
  finishReason: string | null;
}

export interface LLMResponse extends LLMRawResponse {
  elapsedMs: number;
  /** 예산 때문에 줄인 메시지 수. 0 이 아니면 에이전트가 맥락을 잃었다는 뜻이다. */
  trimmed: number;
  /** 실제로 보낸 프롬프트의 추정 토큰 */
  estimatedPromptTokens: number;
}

export type LLMErrorCode =
  | 'config_missing'
  | 'prompt_too_large'
  | 'http_error'
  | 'bad_response'
  | 'timeout'
  | 'aborted';

export class LLMError extends Error {
  readonly code: LLMErrorCode;

  constructor(code: LLMErrorCode, message: string) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
  }
}

export interface LLMAdapter {
  readonly provider: LLMProvider;
  /** `request.messages` 는 이미 예산에 맞게 줄여진 상태로 들어온다. */
  chat(config: LLMConfig, request: LLMRequest, signal: AbortSignal): Promise<LLMRawResponse>;
}
