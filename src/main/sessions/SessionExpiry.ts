import { looksLikeLoginUrl, redirectedToLogin } from '../agent/prompt';

/**
 * SessionExpiry — 세션 만료를 **에이전트 밖에서** 알아채는 판정 (M4c).
 *
 * 내장 에이전트는 자기 루프 안에서 로그인 게이트를 본다(`Agent.loginGate`). 그런데 같은 일이
 * 에이전트 밖에서도 일어난다 — MCP 클라이언트가 도구로 몰던 탭, 체크포인트 복원으로 다시 열린
 * 탭이 어느 순간 로그인 화면으로 되밀린다. 그때도 똑같이 스레드를 `waiting_login` 으로 내리고
 * 받은편지함에 `login_required` 를 남겨야 사람이 로그인 경로(3종)를 골라 이어갈 수 있다.
 *
 * 판정은 M2 휴리스틱 두 가지를 겹쳐 쓴다:
 *
 *   1. **리다이렉트** — 요청한 주소와 도착한 주소가 다르고, 도착이 로그인 주소다
 *      (`redirectedToLogin`, 에이전트와 같은 함수)
 *   2. **폼 등장** — 주소는 그대로인데 페이지에 비밀번호 입력이 나타났다.
 *      모의 IdP 의 보호 자원(`/app`)처럼 리다이렉트 없이 200 으로 로그인 폼을
 *      되돌려주는 사이트가 실제로 있어서, 리다이렉트만 보면 놓친다
 *
 * 처음부터 로그인 주소로 가라고 한 이동은 게이트가 아니다 — `login_start(inapp)` 가 여는
 * 로그인 탭이 바로 그 경우다.
 */

export interface GateSignal {
  /** 탭이 이동을 시작한 주소 */
  requestedUrl: string;
  /** 실제로 도착한 주소 */
  finalUrl: string;
  /** 도착한 페이지에 비밀번호 입력이 있는가 */
  hasLoginForm: boolean;
}

/** 로그인 게이트면 밀려난 주소를, 아니면 null 을 돌려준다. */
export function loginGateOf(signal: GateSignal): string | null {
  // 로그인하러 간 이동은 게이트가 아니다. 사람이(또는 login_start 가) 그렇게 시킨 것이다.
  if (looksLikeLoginUrl(signal.requestedUrl)) return null;

  if (redirectedToLogin(signal.requestedUrl, signal.finalUrl)) return signal.finalUrl;

  // 주소가 로그인 주소도 아닌데 비밀번호 폼이 나타났다 — 200 으로 되밀린 모양이다.
  if (signal.hasLoginForm && !looksLikeLoginUrl(signal.finalUrl)) return signal.finalUrl;

  return null;
}
