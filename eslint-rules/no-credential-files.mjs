/**
 * ESLint 커스텀 규칙 — no-credential-files
 *
 * 다른 브라우저의 자격증명 저장소를 가리키는 파일명·복호화 관용구를 소스에서 금지한다.
 * CLAUDE.md 불변 조건 9: Chrome/Edge 의 세션 쿠키·토큰을 복호화·복사하는 코드는 작성 금지.
 * ABE(Chrome 127+)·DBSC 로 복호화가 불가능하고, 시도 자체가 인포스틸러 패턴이라 EDR 에 걸린다.
 *
 * 예외는 **하나뿐이고 좁다**(GOAL-M4c FIXED DECISIONS): `Login Data` 는 비밀번호 임포트
 * 경로에서만 쓸 수 있고, 그러려면 그 파일에 `// policy:password-import` 주석과 감사 로그
 * 호출이 **둘 다** 있어야 한다. 주석만으로는 열리지 않는다 — 기록 없이 자격증명을 만지는
 * 코드를 막는 것이 요점이고, 주석은 의도 표시일 뿐 보증이 아니다.
 *
 * 예외가 **덮지 않는 것**: `Cookies`, `Local State`, 그리고 복호화 관용구 전부
 * (`DPAPI`, `CryptUnprotectData`, `os_crypt`, `app_bound_encryption`). 그래서 같은 사용자
 * DPAPI 복호화 경로는 이 규칙 아래에서 작성할 수 없고, 비밀번호 임포트는 **Chrome 내보내기
 * CSV** 로만 구현된다. 그 경로는 `Login Data` 를 아예 건드리지 않는다.
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

/** 비밀번호 임포트 경로에서만 열리는 이름. `Cookies`·`Local State` 는 여기 없다. */
const PASSWORD_IMPORT_NAMES = ['login data', 'login data for account'];

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

/** 비밀번호 임포트 경로임을 밝히는 표시. 이것과 감사 호출이 함께 있어야 예외가 열린다. */
const POLICY_MARK = 'policy:password-import';

/** 감사 로그를 실제로 부르는가. 이름만 맞으면 통과시킨다 — 정적 분석으로는 여기까지다. */
const AUDIT_CALL = /\b(audit|auditLog|appendAudit)\b\s*[.(]/;

/**
 * 이 파일이 `Login Data` 예외를 받을 자격이 있는가.
 *
 * 둘 다 있어야 한다. 주석은 "여기가 그 경로다" 라는 사람의 선언이고, 감사 호출은
 * "만진 것이 기록에 남는다" 는 확인이다. 선언만 받으면 주석 한 줄로 규칙이 무력해진다.
 */
function allowsPasswordImport(sourceText) {
  return sourceText.includes(POLICY_MARK) && AUDIT_CALL.test(sourceText);
}

/** 경로의 마지막 구간을 소문자 정규화해서 돌려준다. 확장자는 뗀다. */
function lastSegment(raw) {
  const segments = raw.split(/[\\/]+/);
  const last = segments[segments.length - 1] ?? '';
  return last.trim().replace(/\.[a-z0-9]{1,8}$/i, '');
}

function literalReason(raw, passwordImportAllowed) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  for (const pattern of CRYPTO_IDIOMS) {
    if (pattern.test(raw)) return `자격증명 복호화 관용구 "${pattern.source}"`;
  }

  // 경로 안의 어느 구간이든 명확한 이름이면 잡는다.
  for (const segment of raw.split(/[\\/]+/)) {
    const normalized = segment.trim().replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase();

    // 좁은 예외: 비밀번호 임포트 경로에서의 `Login Data` 만. 나머지 이름은 그대로 막힌다.
    if (passwordImportAllowed && PASSWORD_IMPORT_NAMES.includes(normalized)) continue;

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
    const sourceText = context.sourceCode?.getText?.() ?? context.getSourceCode?.().getText?.() ?? '';
    const passwordImportAllowed = allowsPasswordImport(sourceText);

    const reportIf = (node, reason) => {
      if (reason) context.report({ node, messageId: 'forbidden', data: { reason } });
    };

    return {
      Literal(node) {
        reportIf(node, literalReason(node.value, passwordImportAllowed));
      },
      TemplateElement(node) {
        reportIf(node, literalReason(node.value.cooked ?? node.value.raw, passwordImportAllowed));
      },
      Identifier(node) {
        const normalized = node.name.replace(/[_\s]/g, '').toLowerCase();

        // 식별자 우회도 같은 예외를 받는다 — `loginData` 라는 변수는 그 경로에서 자연스럽다.
        if (passwordImportAllowed && (normalized === 'logindata' || normalized === 'logindataforaccount')) {
          return;
        }

        if (IDENTIFIER_NAMES.has(normalized)) {
          reportIf(node, `자격증명 저장소 식별자 "${node.name}"`);
        }
      }
    };
  }
};

export default {
  rules: { 'no-credential-files': noCredentialFiles }
};
