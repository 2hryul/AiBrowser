import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/main/audit/AuditLog';
import { LLMClient, loadLLMConfig } from '../src/main/llm/LLMClient';
import { ELIDED_MARK, estimateTokens, fitToBudget } from '../src/main/llm/tokens';
import { LLMError, type LLMConfig, type LLMMessage } from '../src/main/llm/types';

/**
 * LLM 계층 단위 테스트.
 *
 * 모델을 부르지 않는다 — 로컬 http 서버가 공급자 역할을 하고, 우리가 보는 것은
 * **우리 쪽 계약**이다: 예산을 지키는가, 짝이 깨지지 않는가, 감사 로그가 남는가,
 * 실패를 실패로 올리는가. 모델의 판단은 `npm run probe:llm` 과 시나리오 E2E 의 몫이다.
 */

// ─────────────────────────────────────────────────────────────
// 토큰 추정과 예산
// ─────────────────────────────────────────────────────────────

describe('토큰 추정', () => {
  it('빈 문자열은 0 이다', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('같은 글자 수라면 한글이 라틴보다 무겁다', () => {
    const korean = estimateTokens('공지사항목록을가져온다'.repeat(10));
    const latin = estimateTokens('noticeboard'.repeat(10));

    expect(korean).toBeGreaterThan(latin);
  });

  it('길이에 비례해서 커진다', () => {
    const once = estimateTokens('공지사항');
    const tenfold = estimateTokens('공지사항'.repeat(10));

    expect(tenfold).toBeGreaterThan(once * 8);
  });
});

function conversation(steps: number): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: '너는 사내 브라우저를 조작하는 에이전트다.' },
    { role: 'user', content: '공지 200건을 표로 뽑아라.' }
  ];

  for (let i = 0; i < steps; i += 1) {
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${i}`, name: 'get_page_text', args: { tabId: 1 } }]
    });
    messages.push({
      role: 'tool',
      toolCallId: `call_${i}`,
      name: 'get_page_text',
      content: `공지 본문 ${i} — ${'가나다라마바사'.repeat(60)}`
    });
  }

  return messages;
}

describe('예산 맞추기', () => {
  it('예산 안이면 손대지 않는다', () => {
    const messages = conversation(1);
    const result = fitToBudget(messages, 100_000);

    expect(result.trimmed).toBe(0);
    expect(result.overBudget).toBe(false);
    expect(result.messages.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it('예산을 넘으면 오래된 도구 결과부터 줄인다', () => {
    const messages = conversation(12);
    const result = fitToBudget(messages, 2000);

    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(2000);

    // 줄어든 것은 앞쪽의 도구 결과다 — 마지막 도구 결과는 살아 있어야 다음 수를 고를 수 있다.
    const tools = result.messages.filter((m) => m.role === 'tool');
    expect(tools[0]?.content).toBe(ELIDED_MARK);
    expect(tools[tools.length - 1]?.content).not.toBe(ELIDED_MARK);
  });

  it('줄여도 메시지 수와 도구 호출 짝은 그대로다', () => {
    const messages = conversation(12);
    const result = fitToBudget(messages, 1500);

    expect(result.messages).toHaveLength(messages.length);

    const callIds = result.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id));
    const resultIds = result.messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.toolCallId ?? '');

    expect(resultIds).toEqual(callIds);
  });

  it('시스템 프롬프트와 사람의 지시는 줄이지 않는다', () => {
    const messages = conversation(20);
    const result = fitToBudget(messages, 500);

    expect(result.messages[0]?.content).toBe('너는 사내 브라우저를 조작하는 에이전트다.');
    expect(result.messages[1]?.content).toBe('공지 200건을 표로 뽑아라.');
  });
});

// ─────────────────────────────────────────────────────────────
// 설정 읽기
// ─────────────────────────────────────────────────────────────

describe('설정 읽기', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-llm-config-'));

  it('파일이 없으면 null 이다 — 기동을 세우지 않는다', () => {
    expect(loadLLMConfig(dir)).toBeNull();
  });

  it('provider 가 어긋나면 null 이다', () => {
    fs.writeFileSync(
      path.join(dir, 'llm.json'),
      JSON.stringify({ provider: 'gemini', baseUrl: 'http://x', model: 'm' })
    );

    expect(loadLLMConfig(dir)).toBeNull();
  });

  it('키는 파일이 아니라 환경변수에서 읽는다', () => {
    process.env['HELM_TEST_LLM_KEY'] = 'sk-test-value';
    fs.writeFileSync(
      path.join(dir, 'llm.json'),
      JSON.stringify({
        provider: 'anthropic',
        baseUrl: 'https://example.invalid/v1/messages',
        apiKeyEnv: 'HELM_TEST_LLM_KEY',
        model: 'claude-opus-5'
      })
    );

    const config = loadLLMConfig(dir);

    expect(config?.apiKey).toBe('sk-test-value');
    expect(config?.maxPromptTokens).toBe(8000);
    delete process.env['HELM_TEST_LLM_KEY'];
  });
});

// ─────────────────────────────────────────────────────────────
// 호출 — 로컬 http 서버를 공급자로 세운다
// ─────────────────────────────────────────────────────────────

interface FakeTurn {
  status?: number;
  body: unknown;
  delayMs?: number;
}

let server: http.Server;
let baseUrl = '';
let queue: FakeTurn[] = [];
let lastRequestBody: Record<string, unknown> | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      lastRequestBody = JSON.parse(raw) as Record<string, unknown>;
      const turn = queue.shift() ?? { body: { error: { message: '준비된 응답이 없다' } } };

      const send = (): void => {
        res.writeHead(turn.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(turn.body));
      };

      if (turn.delayMs) setTimeout(send, turn.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'openai',
    baseUrl,
    apiKey: '',
    model: 'qwen2.5:7b-instruct',
    maxPromptTokens: 8000,
    maxOutputTokens: 256,
    timeoutMs: 2000,
    ...overrides
  };
}

function toolCallTurn(name: string, args: unknown, promptTokens = 1200): FakeTurn {
  return {
    body: {
      model: 'qwen2.5:7b-instruct',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: promptTokens, completion_tokens: 20 }
    }
  };
}

describe('LLMClient 호출', () => {
  it('도구 호출을 공급자 중립 모양으로 돌려준다', async () => {
    queue = [toolCallTurn('navigate', { url: 'app://portal-a/list?page=1' })];
    const client = new LLMClient(config());

    const response = await client.chat({
      purpose: 'test.step',
      messages: [{ role: 'user', content: '1페이지로 가라' }],
      tools: [
        {
          name: 'navigate',
          description: '이동',
          parameters: { type: 'object', properties: { url: { type: 'string' } } }
        }
      ]
    });

    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'navigate', args: { url: 'app://portal-a/list?page=1' } }
    ]);
    expect(response.usage.promptTokens).toBe(1200);
    expect(lastRequestBody?.['stream']).toBe(false);
  });

  it('도구 인자가 JSON 이 아니면 던진다 — 빈 인자로 눙치지 않는다', async () => {
    queue = [
      {
        body: {
          choices: [
            {
              message: {
                tool_calls: [
                  { id: 'c', type: 'function', function: { name: 'navigate', arguments: '{url:' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      }
    ];

    const client = new LLMClient(config());

    await expect(
      client.chat({ purpose: 'test.bad-args', messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('HTTP 오류는 http_error 로 올린다', async () => {
    queue = [{ status: 500, body: { error: { message: '모델이 없다' } } }];
    const client = new LLMClient(config());

    await expect(
      client.chat({ purpose: 'test.http', messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ code: 'http_error' });
  });

  it('시간이 지나면 끊는다', async () => {
    queue = [{ body: { choices: [{ message: { content: '늦은 답' } }] }, delayMs: 400 }];
    const client = new LLMClient(config({ timeoutMs: 80 }));

    await expect(
      client.chat({ purpose: 'test.timeout', messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('상한을 넘는 프롬프트는 보내기 전에 막는다', async () => {
    queue = [];
    const client = new LLMClient(config({ maxPromptTokens: 50 }));

    const huge: LLMMessage[] = [
      { role: 'system', content: '지시'.repeat(200) },
      { role: 'user', content: '본문'.repeat(200) }
    ];

    await expect(client.chat({ purpose: 'test.budget', messages: huge })).rejects.toBeInstanceOf(
      LLMError
    );
    expect(lastRequestBody).not.toBeNull();
  });

  it('모든 호출이 감사 로그에 남고, 프롬프트 원문은 남지 않는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-llm-audit-'));
    const audit = new AuditLog(dir, 'run-llm');
    const client = new LLMClient(config(), audit, 'run-llm');

    queue = [toolCallTurn('get_page_text', { tabId: 1 })];

    await client.chat({
      purpose: 'agent.step',
      messages: [
        { role: 'system', content: '시스템 프롬프트' },
        { role: 'user', content: '주민등록번호가 들어간 페이지 본문 900101-1234567' }
      ]
    });

    const entries = audit.read();
    const entry = entries.find((item) => item.tool === 'llm.chat');

    expect(entry).toBeDefined();
    expect(entry?.source).toBe('agent');
    expect((entry?.result as { toolCalls: string[] }).toolCalls).toEqual(['get_page_text']);

    const dumped = JSON.stringify(entries);
    expect(dumped).not.toContain('900101-1234567');
    expect(dumped).not.toContain('시스템 프롬프트');
  });

  it('실제 usage 로 추정 계수를 보정한다', async () => {
    const client = new LLMClient(config());
    expect(client.calibrationFactor).toBe(1);

    // 추정보다 실제가 훨씬 크면 계수가 올라간다 — 다음 요청의 예산이 보수적으로 잡힌다.
    queue = [toolCallTurn('navigate', { url: 'app://home' }, 4000)];
    await client.chat({ purpose: 'test.calib', messages: [{ role: 'user', content: '짧은 지시' }] });

    expect(client.calibrationFactor).toBeGreaterThan(1);
  });
});
