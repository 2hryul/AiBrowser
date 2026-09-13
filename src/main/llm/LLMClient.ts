import fs from 'node:fs';
import path from 'node:path';
import type { AuditLog } from '../audit/AuditLog';
import { anthropicAdapter } from './adapters/anthropic';
import { openAIAdapter } from './adapters/openai';
import { estimateMessagesTokens, estimateToolsTokens, fitToBudget } from './tokens';
import {
  LLMError,
  type LLMAdapter,
  type LLMConfig,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse
} from './types';

/**
 * LLM 호출의 단일 진입점.
 *
 * 여기가 하는 일은 넷이다 — 공급자 고르기, **예산 지키기**, **감사 로그 남기기**, 시간 끊기.
 * 모델을 고르거나 프롬프트를 쓰는 일은 하지 않는다(그건 Agent 의 몫이다).
 *
 * 엔드포인트는 설정된 하나뿐이다(CLAUDE.md CONSTRAINTS). 코드에 기본 호스트를 박지 않는다 —
 * `config/llm.json` 이 없으면 내장 에이전트는 기동하지 않고, 브라우저는 그대로 쓸 수 있다.
 */

export const DEFAULT_MAX_PROMPT_TOKENS = 8000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const ADAPTERS: Record<LLMProvider, LLMAdapter> = {
  openai: openAIAdapter,
  anthropic: anthropicAdapter
};

/**
 * 설정 파일 모양. **키 값은 파일에 적지 않는다** — 환경변수 이름만 적는다.
 * 저장소에 들어가는 파일에 자격증명을 두지 않기 위한 것이다(CLAUDE.md 보안 기본값).
 */
interface LLMConfigFile {
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  effort?: string;
}

function isProvider(value: unknown): value is LLMProvider {
  return value === 'openai' || value === 'anthropic';
}

function isEffort(value: unknown): value is NonNullable<LLMConfig['effort']> {
  return (
    value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
  );
}

/**
 * `config/llm.json` 을 읽는다. 파일이 없거나 형식이 어긋나면 `null` —
 * 기동을 세우지 않는다. LLM 이 없다고 브라우저를 못 쓰게 만들 이유가 없다.
 */
/**
 * 환경변수로 설정을 덮어쓴다.
 *
 * 왜 필요한가 — "같은 에이전트를 다른 모델로 돌려 보고 비교한다" 는 일이 실제로 생긴다
 * (설계 문제인지 모델 문제인지 가르는 것). 그때마다 추적되는 `config/llm.json` 을 고치면
 * 비교 실행이 저장소에 흔적을 남기고, 되돌리는 것을 잊으면 다음 사람이 다른 설정으로 돈다.
 *
 * 값은 여전히 **키가 아니라 키의 환경변수 이름**이다(`HELM_LLM_API_KEY_ENV`).
 */
function applyEnvOverrides(config: LLMConfig): LLMConfig {
  const provider = process.env['HELM_LLM_PROVIDER'];
  const baseUrl = process.env['HELM_LLM_BASE_URL'];
  const model = process.env['HELM_LLM_MODEL'];
  const apiKeyEnv = process.env['HELM_LLM_API_KEY_ENV'];
  const maxOutput = Number(process.env['HELM_LLM_MAX_OUTPUT'] ?? '');
  const maxPrompt = Number(process.env['HELM_LLM_MAX_PROMPT'] ?? '');
  const effort = process.env['HELM_LLM_EFFORT'];

  const next: LLMConfig = { ...config };

  if (isProvider(provider)) next.provider = provider;
  if (baseUrl) next.baseUrl = baseUrl;
  if (model) next.model = model;
  if (apiKeyEnv) next.apiKey = process.env[apiKeyEnv] ?? '';
  if (Number.isFinite(maxOutput) && maxOutput > 0) next.maxOutputTokens = maxOutput;
  // 8k 는 로컬 7B 를 전제로 쓰인 값이다(GOAL-M4). 더 큰 모델로 비교할 때 이 값이 병목인지
  // 아닌지를 보려면 상한 자체를 움직여 봐야 한다.
  if (Number.isFinite(maxPrompt) && maxPrompt > 0) next.maxPromptTokens = maxPrompt;
  if (isEffort(effort)) next.effort = effort;

  if (next.provider !== config.provider || next.model !== config.model) {
    console.warn(`[llm] 환경변수 덮어쓰기 - ${next.provider} · ${next.model}`);
  }

  return next;
}

export function loadLLMConfig(configDir: string): LLMConfig | null {
  const file = path.join(configDir, 'llm.json');

  try {
    if (!fs.existsSync(file)) return null;

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as LLMConfigFile;

    if (!isProvider(parsed.provider)) {
      console.error(`[llm] provider 가 openai|anthropic 이 아니다 - 경로: ${file}`);
      return null;
    }
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl === '') {
      console.error(`[llm] baseUrl 이 없다 - 경로: ${file}`);
      return null;
    }
    if (typeof parsed.model !== 'string' || parsed.model === '') {
      console.error(`[llm] model 이 없다 - 경로: ${file}`);
      return null;
    }

    const apiKeyEnv = parsed.apiKeyEnv ?? '';
    const apiKey = apiKeyEnv === '' ? '' : (process.env[apiKeyEnv] ?? '');

    if (apiKeyEnv !== '' && apiKey === '') {
      console.warn(`[llm] 환경변수 ${apiKeyEnv} 가 비어 있다 - 인증 없이 호출한다`);
    }

    return applyEnvOverrides({
      provider: parsed.provider,
      baseUrl: parsed.baseUrl,
      apiKey,
      model: parsed.model,
      maxPromptTokens: parsed.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS,
      maxOutputTokens: parsed.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(isEffort(parsed.effort) ? { effort: parsed.effort } : {})
    });
  } catch (error) {
    console.error(`[llm] 설정 읽기 실패 - 경로: ${file}`, error);
    return null;
  }
}

export interface ToolSupportProbe {
  supported: boolean;
  detail: string;
}

export class LLMClient {
  private readonly adapter: LLMAdapter;
  private audit: AuditLog | null;
  private runId: string;

  /**
   * 추정 토큰 대비 실제 토큰 비율. 응답이 usage 를 주면 여기로 보정한다 —
   * 토크나이저를 들이지 않고도 상한을 실제에 맞춰 두기 위한 것이다.
   */
  private calibration = 1;

  constructor(
    readonly config: LLMConfig,
    audit: AuditLog | null = null,
    runId = 'llm'
  ) {
    const adapter = ADAPTERS[config.provider];
    if (!adapter) {
      throw new LLMError('config_missing', `[llm] 모르는 provider: ${config.provider}`);
    }
    this.adapter = adapter;
    this.audit = audit;
    this.runId = runId;
  }

  get model(): string {
    return this.config.model;
  }

  /** 감사 로그는 실행 단위로 바뀐다 — 에이전트가 스레드를 시작할 때 갈아 끼운다. */
  bindAudit(audit: AuditLog | null, runId: string): void {
    this.audit = audit;
    this.runId = runId;
  }

  /** 추정 보정 계수. 테스트와 리포트가 본다. */
  get calibrationFactor(): number {
    return this.calibration;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const toolTokens = estimateToolsTokens(request.tools ?? []);
    const budget = this.config.maxPromptTokens - Math.ceil(toolTokens * this.calibration);

    if (budget <= 0) {
      throw new LLMError(
        'prompt_too_large',
        `[llm] 도구 정의만으로 상한을 넘는다 - 도구 ${request.tools?.length ?? 0}개 · 추정 ${toolTokens} 토큰 · 상한 ${this.config.maxPromptTokens}`
      );
    }

    const fitted = fitToBudget(request.messages, budget, this.calibration);

    if (fitted.overBudget) {
      throw new LLMError(
        'prompt_too_large',
        `[llm] 줄여도 상한을 넘는다 - 추정 ${fitted.estimatedTokens} + 도구 ${toolTokens} · 상한 ${this.config.maxPromptTokens}`
      );
    }

    if (fitted.trimmed > 0) {
      console.warn(`[llm] 예산 때문에 ${fitted.trimmed}개 단계를 줄였다 (purpose: ${request.purpose})`);
    }

    const sent: LLMRequest = { ...request, messages: fitted.messages };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);

    const started = Date.now();

    try {
      const raw = await this.adapter.chat(this.config, sent, controller.signal);
      const elapsedMs = Date.now() - started;

      this.recalibrate(raw.usage.promptTokens, fitted.estimatedTokens + toolTokens);

      const response: LLMResponse = {
        ...raw,
        elapsedMs,
        trimmed: fitted.trimmed,
        estimatedPromptTokens: fitted.estimatedTokens + toolTokens
      };

      // 길이로 잘린 응답을 조용히 넘기면 도구 인자가 반쪽인 채로 실행된다.
      if (raw.finishReason === 'length' || raw.finishReason === 'max_tokens') {
        console.warn(
          `[llm] 응답이 출력 상한에서 잘렸다 - purpose: ${request.purpose} · max_tokens: ${sent.maxOutputTokens ?? this.config.maxOutputTokens}`
        );
      }

      this.record(request, response, null);
      return response;
    } catch (error) {
      const elapsedMs = Date.now() - started;

      const failure =
        error instanceof LLMError
          ? error
          : timedOut
            ? new LLMError('timeout', `[llm] ${this.config.timeoutMs}ms 안에 응답이 없다`)
            : new LLMError('http_error', `[llm] 호출 실패 - ${String(error)}`);

      this.record(
        request,
        {
          text: '',
          toolCalls: [],
          usage: { promptTokens: null, completionTokens: null },
          model: this.config.model,
          finishReason: null,
          elapsedMs,
          trimmed: fitted.trimmed,
          estimatedPromptTokens: fitted.estimatedTokens + toolTokens
        },
        failure
      );

      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 도구 호출을 지원하는 모델인가. 기동 시 한 번 확인하고 경고만 남긴다(GOAL-M4 FIXED DECISIONS).
   * 못 한다고 기동을 막지는 않는다 — 요약 같은 가벼운 요청은 도구 없이도 된다.
   */
  async probeToolSupport(): Promise<ToolSupportProbe> {
    try {
      const response = await this.chat({
        purpose: 'probe.tools',
        temperature: 0,
        maxOutputTokens: 128,
        messages: [
          {
            role: 'system',
            content: '너는 브라우저를 조작한다. 도구를 쓸 수 있으면 반드시 도구로 답한다.'
          },
          { role: 'user', content: 'app://home 으로 이동해라.' }
        ],
        tools: [
          {
            name: 'navigate',
            description: '탭을 주어진 URL 로 이동시킨다.',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string', description: '이동할 주소' } },
              required: ['url'],
              additionalProperties: false
            }
          }
        ]
      });

      if (response.toolCalls.length > 0) {
        return { supported: true, detail: `tool_calls: ${response.toolCalls[0]?.name ?? ''}` };
      }

      return {
        supported: false,
        detail: `도구를 주었는데 본문으로 답했다: ${response.text.slice(0, 120)}`
      };
    } catch (error) {
      return { supported: false, detail: `probe 실패 - ${String(error)}` };
    }
  }

  /** 실제 usage 가 오면 추정 계수를 맞춘다. 한 번에 크게 흔들지 않도록 절반씩 옮긴다. */
  private recalibrate(actual: number | null, estimated: number): void {
    if (actual === null || actual <= 0 || estimated <= 0) return;

    const ratio = actual / estimated;
    const blended = this.calibration * 0.5 + ratio * 0.5;
    this.calibration = Math.min(3, Math.max(0.5, blended));
  }

  /**
   * 모든 호출을 감사 로그에 남긴다(GOAL-M4 IN SCOPE).
   * 프롬프트 원문은 넣지 않는다 — 페이지 본문이 통째로 들어가 개인정보가 로그에 고인다.
   * 남기는 것은 "무엇을 위해 · 얼마나 · 무엇을 부르기로 했는가" 다.
   */
  private record(request: LLMRequest, response: LLMResponse, error: LLMError | null): void {
    if (!this.audit) return;

    this.audit.append({
      ts: Date.now(),
      source: 'agent',
      runId: this.runId,
      tabId: null,
      url: null,
      tool: 'llm.chat',
      args: {
        purpose: request.purpose,
        model: this.config.model,
        provider: this.config.provider,
        messages: request.messages.length,
        tools: (request.tools ?? []).map((tool) => tool.name),
        jsonSchema: request.jsonSchema?.name ?? null
      },
      targetText: null,
      result: {
        toolCalls: response.toolCalls.map((call) => call.name),
        textChars: response.text.length,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        estimatedPromptTokens: response.estimatedPromptTokens,
        trimmed: response.trimmed,
        finishReason: response.finishReason
      },
      durationMs: response.elapsedMs,
      screenshotPath: null,
      policyDecision: 'allow',
      grantScope: null,
      error: error === null ? null : `${error.code}: ${error.message}`
    });
  }
}

export { estimateMessagesTokens };
