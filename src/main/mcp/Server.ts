import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { callTool, isPaused, listTools, type ToolContext } from '../tools/index';
import { registerAllTools } from '../tools/register';

/**
 * MCP 서버 — 외부 클라이언트(Claude Code)가 ToolSurface 를 그대로 쓰게 한다.
 *
 * 내장 에이전트(M4)와 같은 레지스트리를 노출한다. 도구 정의가 이미 JSON Schema 라
 * 저수준 `Server` 에 그대로 실어 보낸다(Zod 변환 없음).
 *
 * localhost 에만 바인딩한다. 외부 네트워크로 나가지 않으며(CLAUDE.md 보안 기본값),
 * 고정 개발 토큰 1개로 접근을 막는다. 토큰 발급·회수 UI 는 M3.
 */

export const DEFAULT_MCP_PORT = 3100;

export interface McpServerOptions {
  port?: number;
  /** 고정 개발 토큰. 미지정이면 기동 시 1개를 만들어 로그에 남긴다. */
  token?: string;
  /** 도구 호출에 쓸 컨텍스트를 만들어 준다. 연결마다 threadId 가 달라진다. */
  createContext: (threadId: string) => ToolContext;
}

export interface McpEndpointInfo {
  url: string;
  port: number;
  token: string;
  /** Claude Code 에 붙일 때 쓰는 명령 */
  addCommand: string;
}

export class HelmMcpServer {
  private readonly options: McpServerOptions;
  private http: HttpServer | null = null;
  private readonly token: string;
  private readonly port: number;
  /** 세션 id → 전송 계층. Streamable HTTP 는 세션 단위로 상태를 갖는다. */
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(options: McpServerOptions) {
    this.options = options;
    this.port = options.port ?? DEFAULT_MCP_PORT;
    this.token = options.token ?? randomUUID();
  }

  endpoint(): McpEndpointInfo {
    const url = `http://127.0.0.1:${this.port}/mcp`;
    return {
      url,
      port: this.port,
      token: this.token,
      addCommand: `claude mcp add helm --transport http ${url} --header "Authorization: Bearer ${this.token}"`
    };
  }

  /** MCP 프로토콜 서버 1개를 만든다. 연결(세션)마다 새로 만든다. */
  private buildServer(threadId: string): Server {
    registerAllTools();

    const server = new Server(
      { name: 'helm', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: listTools().map((tool) => ({
        name: tool.name,
        description: `${tool.description}\n\n[sideEffect: ${tool.sideEffect}${tool.irreversible ? ', 되돌릴 수 없음' : ''}]`,
        inputSchema: tool.input as { type: 'object' }
      }))
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const ctx = this.options.createContext(threadId);

      try {
        const result = await callTool(ctx, request.params.name, request.params.arguments ?? {});

        // 사람이 개입해 멈춘 상태는 오류가 아니다. 그대로 결과로 돌려준다(불변 조건 3·6).
        if (isPaused(result)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            isError: false
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: false
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: (error as Error).message,
                tool: request.params.name
              })
            }
          ],
          isError: true
        };
      }
    });

    return server;
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (header === `Bearer ${this.token}`) return true;

    // 헤더를 못 붙이는 클라이언트를 위해 쿼리 토큰도 받는다. 로컬 전용이라 위험이 제한된다.
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    return url.searchParams.get('token') === this.token;
  }

  async start(): Promise<McpEndpointInfo> {
    if (this.http) return this.endpoint();

    const http = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        console.error('[mcp] 요청 처리 실패', error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      // 127.0.0.1 에만 바인딩한다 — 다른 기기에서 붙을 수 없다.
      http.listen(this.port, '127.0.0.1', () => resolve());
    });

    this.http = http;
    const info = this.endpoint();
    console.warn(`[mcp] Streamable HTTP 준비됨: ${info.url}`);
    return info;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tools: listTools().length }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? this.transports.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res, await readBody(req));
      return;
    }

    // 새 세션. 초기화 요청에서만 만들어진다.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        this.transports.set(id, transport);
      },
      onsessionclosed: (id: string) => {
        this.transports.delete(id);
      }
    });

    // 클라이언트가 스레드를 지정할 수 있다. 앱이 재시작된 뒤 같은 작업을 이어가려면
    // 같은 스레드에 붙어야 하고(체크포인트·메시지가 거기 매달려 있다), 연결마다 새 id 를
    // 발급하면 그게 불가능하다. 형식은 좁게 제한한다 — 파일·DB 키로 쓰이는 값이다.
    const requested = req.headers['x-helm-thread'];
    const threadId =
      typeof requested === 'string' && /^[\w.-]{1,64}$/.test(requested)
        ? requested
        : `mcp-${randomUUID().slice(0, 8)}`;

    const server = this.buildServer(threadId);

    // SDK 의 Transport 는 optional 콜백을 `() => void` 로 선언해 우리 쪽
    // exactOptionalPropertyTypes 와 어긋난다. 외부 라이브러리 경계에서만 좁혀 준다.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, await readBody(req));
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      try {
        await transport.close();
      } catch (error) {
        console.warn('[mcp] 전송 계층 종료 실패', error);
      }
    }
    this.transports.clear();

    const http = this.http;
    this.http = null;
    if (!http) return;

    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      // 열려 있는 연결이 있으면 close 가 늦어진다. 강제로 끊는다.
      http.closeAllConnections?.();
    });
  }
}

/** POST 본문을 JSON 으로 읽는다. GET/DELETE 는 본문이 없다. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.trim() === '') return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
