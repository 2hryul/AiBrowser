/**
 * 주소창 입력 정규화.
 * M0은 외부 네트워크 호출을 넣지 않으므로 검색 엔진 폴백이 없다.
 * 스킴이 없는 입력은 https 를 붙여보고, 호스트로 볼 수 없으면 홈으로 되돌린다.
 */
import { HOME_URL } from '../../shared/types';

/** navigate 로 넘길 수 있는 스킴 허용 목록. file: 은 셸에서 임의로 열지 않는다. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'app:', 'about:']);

/** 스킴 없는 입력이 호스트처럼 보이는지: 점이 있거나 localhost(:포트) 형태. */
const HOST_LIKE = /^(localhost(:\d+)?|[\w-]+(\.[\w-]+)+(:\d+)?)(\/.*)?$/i;

export function normalizeAddress(rawInput: string): string | null {
  const input = rawInput.trim();
  if (input === '') return null;
  if (input === 'home' || input === 'app://home') return HOME_URL;

  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    try {
      const url = new URL(input);
      return ALLOWED_SCHEMES.has(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  if (HOST_LIKE.test(input)) {
    try {
      return new URL(`https://${input}`).toString();
    } catch {
      return null;
    }
  }

  return null;
}
