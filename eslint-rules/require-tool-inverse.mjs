/**
 * ESLint 커스텀 규칙 — require-tool-inverse
 *
 * 도구 계약(CLAUDE.md): `irreversible: false` 인 도구는 `inverse` 가 필수다.
 * 역연산이 없는데 "되돌릴 수 있다" 고 표시하면 UndoManager 가 조용히 아무것도 하지 않고,
 * 사용자는 되돌렸다고 믿게 된다. 그게 가장 나쁘다.
 *
 * **적용 범위**: 상태를 바꾸는 도구(`sideEffect` 가 'read' 가 아닌 것)에만 요구한다.
 * 읽기 도구는 되돌릴 것이 없어서 inverse 를 만들 수 없고, 그렇다고 irreversible: true 로 두면
 * Policy 가 페이지를 읽을 때마다 승인을 요구하게 된다 — 규칙의 의도(모르는 채 못 되돌리는 일을
 * 막는 것)와 어긋난다. 이 경계는 artifacts/m3/REPORT.md 에 근거와 함께 적었다.
 */

/** 도구 정의로 볼 수 있는 객체인지 — name·sideEffect·irreversible·run 을 모두 가진 것. */
function toolShape(node) {
  const keys = new Map();

  for (const property of node.properties) {
    if (property.type !== 'Property') continue;
    const key =
      property.key.type === 'Identifier'
        ? property.key.name
        : property.key.type === 'Literal'
          ? String(property.key.value)
          : null;
    if (key) keys.set(key, property);
  }

  const hasRun = keys.has('run');
  const looksLikeTool = keys.has('name') && keys.has('sideEffect') && keys.has('irreversible') && hasRun;
  return looksLikeTool ? keys : null;
}

function literalValue(property) {
  const value = property.value;
  if (value.type === 'Literal') return value.value;
  return undefined;
}

function toolName(keys) {
  const property = keys.get('name');
  const value = property ? literalValue(property) : undefined;
  return typeof value === 'string' ? value : '(이름 미상)';
}

export const requireToolInverse = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'irreversible: false 인 상태 변경 도구는 inverse(역연산)를 반드시 정의해야 한다'
    },
    schema: [],
    messages: {
      missingInverse:
        '도구 "{{name}}" 은(는) irreversible: false 인데 inverse 가 없습니다. ' +
        '역연산을 정의하거나 irreversible: true 로 표시하세요 — 되돌릴 수 없는 것을 ' +
        '되돌릴 수 있다고 표시하면 UndoManager 가 조용히 실패합니다.',
      inverseOnIrreversible:
        '도구 "{{name}}" 은(는) irreversible: true 인데 inverse 가 있습니다. ' +
        '둘 중 하나가 틀렸습니다.'
    }
  },

  create(context) {
    return {
      ObjectExpression(node) {
        const keys = toolShape(node);
        if (!keys) return;

        const irreversibleProperty = keys.get('irreversible');
        const irreversible = irreversibleProperty ? literalValue(irreversibleProperty) : undefined;
        if (typeof irreversible !== 'boolean') return;

        const sideEffectProperty = keys.get('sideEffect');
        const sideEffect = sideEffectProperty ? literalValue(sideEffectProperty) : undefined;

        const hasInverse = keys.has('inverse');
        const name = toolName(keys);

        if (irreversible === true && hasInverse) {
          context.report({
            node: keys.get('inverse'),
            messageId: 'inverseOnIrreversible',
            data: { name }
          });
          return;
        }

        // 읽기 도구는 되돌릴 것이 없다.
        if (sideEffect === 'read') return;

        if (irreversible === false && !hasInverse) {
          context.report({
            node: irreversibleProperty,
            messageId: 'missingInverse',
            data: { name }
          });
        }
      }
    };
  }
};

export default {
  rules: { 'require-tool-inverse': requireToolInverse }
};
