import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app, protocol, type Session } from 'electron';

/**
 * 번들 페이지를 `app://` 로 서비스한다.
 * 외부 네트워크 없이 홈 화면을 띄우기 위한 것이며, 서비스 루트는 resources\home 하나뿐이다.
 */

export const APP_SCHEME = 'app';

/** app://<host> 로 노출할 번들 디렉터리. 화이트리스트 방식(허용 목록)만 사용한다. */
const ROOTS: Record<string, string[]> = {
  home: ['resources', 'home']
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/**
 * `app:` 스킴을 표준 스킴으로 등록한다.
 * app.whenReady() 이전에 호출해야 하며(Electron 제약), standard/secure 여야
 * origin 이 생기고 fetch·쿠키·localStorage 가 정상 동작한다.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // supportFetchAPI 만 켜고 corsEnabled 를 끄면 교차 출처 읽기가 열린다(GHSA-v3j7-r9gq-3gjw).
        corsEnabled: true
      }
    }
  ]);
}

/**
 * 요청 URL을 실제 파일 경로로 변환한다.
 * 허용된 host가 아니거나 루트를 벗어나면 null 을 돌려 즉시 404 로 끝낸다.
 */
function resolveRequestPath(requestUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }

  const root = ROOTS[parsed.hostname];
  if (!root) return null;

  const rootDir = path.join(app.getAppPath(), ...root);
  const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  const target = path.resolve(rootDir, relative === '' ? 'index.html' : relative);

  // 경로 탈출(`..`, 심볼릭 우회) 차단: 정규화 후에도 루트 아래여야 한다.
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (target !== rootDir && !target.startsWith(rootWithSep)) return null;

  return target;
}

async function handleAppRequest(request: GlobalRequest): Promise<GlobalResponse> {
  const filePath = resolveRequestPath(request.url);
  if (!filePath) {
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  try {
    const body = await readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } });
  } catch (error) {
    // 내부 경로를 응답 본문에 노출하지 않고, 진단은 콘솔 로그로만 남긴다.
    console.error(`[AppProtocol] app:// 파일 읽기 실패 - 경로: ${filePath}`, error);
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
}

/**
 * 세션별로 핸들러를 붙인다.
 * protocol.handle 은 세션 단위이므로 셸이 쓰는 기본 세션과 탭이 쓰는
 * persist:helm 파티션 모두에 등록해야 한다.
 */
export function installAppProtocol(sessions: Session[]): void {
  for (const s of sessions) {
    if (s.protocol.isProtocolHandled(APP_SCHEME)) continue;
    s.protocol.handle(APP_SCHEME, handleAppRequest);
  }
}
