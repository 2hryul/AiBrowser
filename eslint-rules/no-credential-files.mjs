/**
 * ESLint 커스텀 규칙 — no-credential-files
 *
 * 다른 브라우저의 자격증명 저장소를 가리키는 파일명·복호화 관용구를 소스에서 금지한다.
 * CLAUDE.md 불변 조건 9: Chrome/Edge 의 세션 쿠키·토큰을 복호화·복사하는 코드는 작성 금지.
 * ABE(Chrome 127+)·DBSC 로 복호화가 불가능하고, 시도 자체가 인포스틸러 패턴이라 EDR 에 걸린다.
 *
 * 예외는 두지 않는다 — ProfileImport 는 허용 목록(Bookmarks / History / Web Data)만 알고,
 * 가져오지 않은 파일은 디렉터리 열거의 여집합으로 보고하므로 이 이름들을 알 필요가 없다.
 *
 * `cookies` 는 Electron 정식 API(`session.cookies`)이기도 해서 단어만으로 판단하지 않는다.
 * 크롬 프로필의 파일을 가리킬 때만(경로 형태이거나 크롬 파일명 그대로) 잡는다.
 */

/** 단어만 나와도 자격증명 저장소를 뜻하는 이름들 (대소문자 무시) */
const UNAMBIGUOUS_NAMES = [
  'login data',
  'login data for account',
  'local state',
  'affiliation database'
];

/** 자격증명 복호화 관용구 */
const CRYPTO_IDIOMS = [
  /\bos_crypt\b/i,
  /\bencrypted_key\b/i,
  /\bapp[-_ ]?bound[-_ ]?encryption\b/i,
  /\bDPAPI\b/,
  /\bCryptUnprotectData\b/i,
  /\bChromeElevationService\b/i
];

/** 식별자·프로퍼티명 우회 차단 (loginData, localState, osCrypt …). cookies 는 제외. */
const IDENTIFIER_NAMES = new Set([
  'logindata',
  'localstate',
  'affiliationdatabase',
  'oscrypt',
  'encryptedkey',
  'cryptunprotectdata'
]);

/** 경로의 마지막 구간을 소문자 정규화해서 돌려준다. 확장자는 뗀다. */
function lastSegment(raw) {
  const segments = raw.split(/[\\/]+/);
  const last = segments[segments.length - 1] ?? '';
  return last.trim().replace(/\.[a-z0-9]{1,8}$/i, '');
}

function literalReason(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  for (const pattern of CRYPTO_IDIOMS) {
    if (pattern.test(raw)) return `자격증명 복호화 관용구 "${pattern.source}"`;
  }

  // 경로 안의 어느 구간이든 명확한 이름이면 잡는다.
  for (const segment of raw.split(/[\\/]+/)) {
    const normalized = segment.trim().replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase();
    if (UNAMBIGUOUS_NAMES.includes(normalized)) {
      return `자격증명 저장소 파일명 "${segment}"`;
    }
  }

  // 'Cookies' 는 경로처럼 쓰였거나 크롬 파일명 그대로일 때만 잡는다.
  const looksLikePath = /[\\/]/.test(raw);
  if (lastSegment(raw).toLowerCase() === 'cookies' && (looksLikePath || raw === 'Cookies')) {
    return `쿠키 저장소 경로 "${raw}"`;
  }

  return null;
}

export const noCredentialFiles = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '다른 브라우저의 자격증명 저장소 파일명·복호화 관용구를 소스에서 금지한다 (CLAUDE.md 불변 조건 9)'
    },
    schema: [],
    messages: {
      forbidden:
        '{{reason}} 이(가) 소스에 있습니다. 다른 브라우저의 쿠키·토큰·비밀번호는 이관하지 않습니다(CLAUDE.md 불변 조건 9). 가져올 파일은 허용 목록으로만 지정하세요.'
    }
  },

  create(context) {
    const reportIf = (node, reason) => {
      if (reason) context.report({ node, messageId: 'forbidden', data: { reason } });
    };

    return {
      Literal(node) {
        reportIf(node, literalReason(node.value));
      },
      TemplateElement(node) {
        reportIf(node, literalReason(node.value.cooked ?? node.value.raw));
      },
      Identifier(node) {
        if (IDENTIFIER_NAMES.has(node.name.replace(/[_\s]/g, '').toLowerCase())) {
          reportIf(node, `자격증명 저장소 식별자 "${node.name}"`);
        }
      }
    };
  }
};

export default {
  rules: { 'no-credential-files': noCredentialFiles }
};
