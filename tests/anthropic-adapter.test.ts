import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../src/main/llm/adapters/anthropic';
import type { LLMConfig, LLMMessage, LLMRequest } from '../src/main/llm/types';

/**
 * Anthropic 어댑터 배선 테스트.
 *
 * 돈을 쓰기 전에 **모양이 맞는지**부터 본다. 이 어댑터는 "설계 문제인가 모델 문제인가" 를
 * 가르는 데 쓰려고 만들었는데, 정작 어댑터가 틀려서 실패하면 아무것도 가르지 못한다.
 *
 * 로컬 http 서버가 Anthropic 역할을 한다. 보는 것은 우리가 **보내는 모양**과
 * 우리가 **읽는 방식**이다. 모델의 판단은 여기서 볼 것이 아니다.
 *
 * OpenAI 호환과 다른 세 자리를 특히 본다:
 *   1. system 은 메시지 배열이 아니라 top-level 필드다
 *   2. 도구 결과는 `tool` 역할이 아니라 **user 메시지 안의 `tool_result` 블록**이다
 *   3. 거절이 200 으로 온다
 */

interface Captured {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl = '';
let captured: Captured | null = null;
let reply: { status?: number; body: unknown } = { body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      captured = { headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1/messages`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(): LLMConfig {
  return {
    provider: 'anthropic',
    baseUrl,
    apiKey: 'sk-ant-test',
    model: 'claude-opus-5',
    maxPromptTokens: 8000,
    maxOutputTokens: 1024,
    timeoutMs: 5000
  };
}

async function send(messages: LLMMessage[], extra: Partial<LLMRequest> = {}): Promise<void> {
  await anthropicAdapter.chat(
    config(),
    { purpose: 'test', messages, ...extra },
    AbortSignal.timeout(5000)
  );
}

const OK_TEXT = {
  model: 'claude-opus-5',
  content: [{ type: 'text', text: '알겠습니다' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 8 }
};

describe('Anthropic 어댑터 — 보내는 모양', () => {
  it('인증 헤더와 버전을 붙인다', async () => {
    reply = { body: OK_TEXT };
    await send([{ role: 'user', content: '안녕' }]);

    expect(captured?.headers['x-api-key']).toBe('sk-ant-test');
    expect(captured?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('system 은 메시지가 아니라 top-level 필드로 간다', async () => {
    reply = { body: OK_TEXT };
    await send([
      { role: 'system', content: '너는 브라우저를 다룬다' },
      { role: 'system', content: '두 번째 규칙' },
      { role: 'user', content: '공지를 읽어라' }
    ]);

    expect(captured?.body['system']).toBe('너는 브라우저를 다룬다\n\n두 번째 규칙');

    const wire = captured?.body['messages'] as { role: string }[];
    expect(wire.every((message) => message.role !== 'system')).toBe(true);
    expect(wire).toHaveLength(1);
  });

  it('도구 정의는 input_schema 라는 이름으로 간다', async () => {
    reply = { body: OK_TEXT };
    await send([{ role: 'user', content: '가라' }], {
      tools: [
        {
          name: 'navigate',
          description: '이동',
          parameters: { type: 'object', properties: { url: { type: 'string' } } }
        }
      ]
    });

    const tools = captured?.body['tools'] as { name: string; input_schema: unknown }[];
    expect(tools[0]?.name).toBe('navigate');
    expect(tools[0]?.input_schema).toEqual({ type: 'object', properties: { url: { type: 'string' } } });
  });

  it('도구 호출과 결과가 블록 구조로 옮겨진다', async () => {
    reply = { body: OK_TEXT };
    await send([
      { role: 'user', content: '읽어라' },
      {
        role: 'assistant',
        content: '읽겠습니다',
        toolCalls: [{ id: 'toolu_1', name: 'get_page_text', args: { tabId: 2 } }]
      },
      { role: 'tool', toolCallId: 'toolu_1', name: 'get_page_text', content: '공지 목록' }
    ]);

    const wire = captured?.body['messages'] as { role: string; content: unknown }[];

    const assistant = wire[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toEqual([
      { type: 'text', text: '읽겠습니다' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_page_text', input: { tabId: 2 } }
    ]);

    // 도구 결과는 tool 역할이 아니라 user 메시지 안의 블록이다.
    const result = wire[2];
    expect(result?.role).toBe('user');
    expect(result?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '공지 목록' }
    ]);
  });

  it('연속된 도구 결과는 한 user 메시지로 모은다', async () => {
    reply = { body: OK_TEXT };
    await send([
      { role: 'user', content: '읽어라' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'get_page_text', args: {} },
          { id: 'b', name: 'read_network_requests', args: {} }
        ]
      },
      { role: 'tool', toolCallId: 'a', name: 'get_page_text', content: '본문' },
      { role: 'tool', toolCallId: 'b', name: 'read_network_requests', content: '{}' }
    ]);

    const wire = captured?.body['messages'] as { role: string; content: unknown[] }[];

    // 병렬 호출의 결과를 쪼개면 다음 턴부터 병렬 호출이 줄어든다.
    expect(wire).toHaveLength(3);
    expect(wire[2]?.content).toHaveLength(2);
  });

  it('생각 깊이는 output_config.effort 로 간다', async () => {
    reply = { body: OK_TEXT };
    await anthropicAdapter.chat(
      { ...config(), effort: 'low' },
      { purpose: 'test', messages: [{ role: 'user', content: 'x' }] },
      AbortSignal.timeout(5000)
    );

    expect(captured?.body['output_config']).toEqual({ effort: 'low' });
  });

  it('깊이를 안 정하면 output_config 를 보내지 않는다 — 공급자 기본값을 쓴다', async () => {
    reply = { body: OK_TEXT };
    await send([{ role: 'user', content: 'x' }]);

    expect(captured?.body['output_config']).toBeUndefined();
  });

  it('구조화 출력은 output_config.format 으로 간다', async () => {
    reply = { body: OK_TEXT };
    await send([{ role: 'user', content: '뽑아라' }], {
      jsonSchema: { name: 'rows', schema: { type: 'object' } }
    });

    expect(captured?.body['output_config']).toEqual({
      format: { type: 'json_schema', schema: { type: 'object' } }
    });
  });
});

describe('Anthropic 어댑터 — 읽는 방식', () => {
  it('text 블록을 이어 붙이고 usage 를 옮긴다', async () => {
    reply = {
      body: {
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: '앞부분 ' },
          { type: 'text', text: '뒷부분' }
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 20 }
      }
    };

    const response = await anthropicAdapter.chat(
      config(),
      { purpose: 'test', messages: [{ role: 'user', content: 'x' }] },
      AbortSignal.timeout(5000)
    );

    expect(response.text).toBe('앞부분 뒷부분');
    expect(response.usage).toEqual({ promptTokens: 300, completionTokens: 20 });
    expect(response.finishReason).toBe('end_turn');
  });

  it('tool_use 를 공급자 중립 모양으로 돌려준다', async () => {
    reply = {
      body: {
        content: [
          { type: 'text', text: '이동합니다' },
          { type: 'tool_use', id: 'toolu_9', name: 'navigate', input: { url: 'app://home' } }
        ],
        stop_reason: 'tool_use'
      }
    };

    const response = await anthropicAdapter.chat(
      config(),
      { purpose: 'test', messages: [{ role: 'user', content: 'x' }] },
      AbortSignal.timeout(5000)
    );

    expect(response.toolCalls).toEqual([
      { id: 'toolu_9', name: 'navigate', args: { url: 'app://home' } }
    ]);
  });

  it('거절은 200 으로 오지만 빈 응답으로 넘기지 않는다', async () => {
    reply = {
      body: {
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' }
      }
    };

    await expect(
      anthropicAdapter.chat(
        config(),
        { purpose: 'test', messages: [{ role: 'user', content: 'x' }] },
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('HTTP 오류는 http_error 로 올린다', async () => {
    reply = { status: 400, body: { error: { message: 'bad request' } } };

    await expect(
      anthropicAdapter.chat(
        config(),
        { purpose: 'test', messages: [{ role: 'user', content: 'x' }] },
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'http_error' });
  });

  it('키가 없으면 부르기 전에 막는다', async () => {
    await expect(
      anthropicAdapter.chat(
        { ...config(), apiKey: '' },
        { purpose: 'test', messages: [{ role: 'user', content: 'x' }] },
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'config_missing' });
  });
});
