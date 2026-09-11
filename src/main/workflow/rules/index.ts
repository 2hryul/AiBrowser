import { z } from 'zod';
import type { Rule, RuleContext, RuleResult } from '../types';
import { lookupProvenanced } from '../values';

/**
 * 오라클 규칙 7종.
 *
 * 규칙은 **결정적**이다. 같은 값이면 같은 판정이 나와야 하고, 그래야 골든셋이 의미를 갖는다.
 * 그래서 여기에는 LLM 호출이 없다(lint 규칙으로도 막혀 있다).
 *
 * 각 규칙은 `used` 에 자기가 본 값 이름을 적는다. Verifier 가 그 목록의 출처를 보고
 * LLM 이 섞였으면 PASS 를 REVIEW 로 내린다 — 규칙이 스스로 판단하지 않는다(한 곳에서만 강등).
 */

/**
 * 값 하나를 이름(또는 `recon.onlyLeft` 같은 경로)으로 꺼낸다.
 * 없으면 규칙이 실패한다 — 조용히 통과하지 않는다.
 */
function pick(context: RuleContext, name: string): unknown {
  context.used.push(name);
  return lookupProvenanced(context.values, name)?.value;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

// ─────────────────────────────────────────────────────────────
// 1. sum_equal — 두 합계가 같은가
// ─────────────────────────────────────────────────────────────

const sumEqualArgs = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  /** 허용 오차(원). 0 이면 완전 일치를 요구한다. */
  tolerance: z.number().min(0).default(0)
});

export const sumEqual: Rule<z.infer<typeof sumEqualArgs>> = {
  id: 'sum_equal',
  version: 1,
  description: '두 값(또는 두 합계)이 허용 오차 안에서 같은가',
  validate: (args) => sumEqualArgs.parse(args),
  run(args, context): RuleResult {
    const left = asNumber(pick(context, args.left));
    const right = asNumber(pick(context, args.right));

    if (left === null || right === null) {
      return {
        ok: false,
        message: `합계를 숫자로 읽을 수 없습니다 (${args.left}=${left}, ${args.right}=${right})`,
        detail: { left, right, tolerance: args.tolerance }
      };
    }

    const diff = Math.abs(left - right);
    const ok = diff <= args.tolerance;

    return {
      ok,
      message: ok
        ? `합계 일치 (차이 ${diff})`
        : `합계가 ${diff} 만큼 어긋납니다 (${left} vs ${right}, 허용 ${args.tolerance})`,
      detail: { left, right, diff, tolerance: args.tolerance }
    };
  }
};

// ─────────────────────────────────────────────────────────────
// 2. ratio_gte — 비율이 기준 이상인가
// ─────────────────────────────────────────────────────────────

const ratioArgs = z.object({
  numerator: z.string().min(1),
  denominator: z.string().min(1),
  min: z.number().min(0).max(1)
});

export const ratioGte: Rule<z.infer<typeof ratioArgs>> = {
  id: 'ratio_gte',
  version: 1,
  description: '분자/분모 비율이 기준 이상인가 (매칭률 등)',
  validate: (args) => ratioArgs.parse(args),
  run(args, context): RuleResult {
    const numerator = asNumber(pick(context, args.numerator));
    const denominator = asNumber(pick(context, args.denominator));

    if (numerator === null || denominator === null) {
      return {
        ok: false,
        message: `비율을 계산할 수 없습니다 (${args.numerator}=${numerator}, ${args.denominator}=${denominator})`,
        detail: { numerator, denominator, min: args.min }
      };
    }

    // 분모가 0 이면 비율이 정의되지 않는다. 통과시키면 "0건 중 0건 성공" 이 PASS 가 된다.
    if (denominator === 0) {
      return {
        ok: false,
        message: '분모가 0 입니다 — 비율을 정의할 수 없습니다',
        detail: { numerator, denominator, min: args.min }
      };
    }

    const ratio = numerator / denominator;
    const ok = ratio >= args.min;

    return {
      ok,
      message: ok
        ? `비율 ${ratio.toFixed(4)} ≥ ${args.min}`
        : `비율 ${ratio.toFixed(4)} 이 기준 ${args.min} 에 못 미칩니다`,
      detail: { numerator, denominator, ratio, min: args.min }
    };
  }
};

// ─────────────────────────────────────────────────────────────
// 3. empty — 비어 있어야 하는 목록이 비었는가
// ─────────────────────────────────────────────────────────────

const emptyArgs = z.object({
  target: z.string().min(1),
  /** 실패 메시지에 몇 건까지 보여줄지 */
  sample: z.number().int().min(0).max(50).default(5)
});

export const empty: Rule<z.infer<typeof emptyArgs>> = {
  id: 'empty',
  version: 1,
  description: '목록이 비어 있는가 (미매칭·예외 목록 검사)',
  validate: (args) => emptyArgs.parse(args),
  run(args, context): RuleResult {
    const list = asArray(pick(context, args.target));

    if (list === null) {
      return {
        ok: false,
        message: `${args.target} 이 목록이 아닙니다`,
        detail: { target: args.target }
      };
    }

    return {
      ok: list.length === 0,
      message:
        list.length === 0 ? `${args.target} 비어 있음` : `${args.target} 에 ${list.length}건 남음`,
      detail: { count: list.length, sample: list.slice(0, args.sample) }
    };
  }
};

// ─────────────────────────────────────────────────────────────
// 4. required_fields — 행마다 필수 항목이 채워졌는가
// ─────────────────────────────────────────────────────────────

const requiredArgs = z.object({
  target: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1)
});

export const requiredFields: Rule<z.infer<typeof requiredArgs>> = {
  id: 'required_fields',
  version: 1,
  description: '목록의 모든 행에 필수 항목이 있는가',
  validate: (args) => requiredArgs.parse(args),
  run(args, context): RuleResult {
    const list = asArray(pick(context, args.target));

    if (list === null) {
      return { ok: false, message: `${args.target} 이 목록이 아닙니다`, detail: {} };
    }

    const missing: { index: number; field: string }[] = [];

    list.forEach((row, index) => {
      if (row === null || typeof row !== 'object') {
        missing.push({ index, field: '(행이 객체가 아님)' });
        return;
      }

      const record = row as Record<string, unknown>;
      for (const field of args.fields) {
        const value = record[field];
        if (value === undefined || value === null || value === '') {
          missing.push({ index, field });
        }
      }
    });

    return {
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? `필수 항목 ${args.fields.join('·')} 모두 있음 (${list.length}행)`
          : `필수 항목 누락 ${missing.length}건`,
      detail: { rows: list.length, fields: args.fields, missing: missing.slice(0, 10) }
    };
  }
};

// ─────────────────────────────────────────────────────────────
// 5. format — 값이 정해진 형식인가
// ─────────────────────────────────────────────────────────────

const formatArgs = z.object({
  target: z.string().min(1),
  /** 목록이면 이 항목을 검사한다. 생략하면 값 자체. */
  field: z.string().optional(),
  /** 이름 있는 형식 또는 정규식 문자열 */
  pattern: z.string().min(1)
});

/** 자주 쓰는 형식은 이름으로 준다 — YAML 에 정규식을 쓰면 읽기 어렵고 틀리기 쉽다. */
const NAMED_FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  amount: /^-?\d+(\.\d+)?$/,
  txid: /^[A-Z]{2}-\d{8}-\d{2}$/,
  voucher: /^[A-Z]-\d{8}-\d{2}$/
};

export const format: Rule<z.infer<typeof formatArgs>> = {
  id: 'format',
  version: 1,
  description: '값(또는 목록의 항목)이 정해진 형식인가',
  validate: (args) => formatArgs.parse(args),
  run(args, context): RuleResult {
    const raw = pick(context, args.target);
    const regex = NAMED_FORMATS[args.pattern] ?? new RegExp(args.pattern);

    const check = (value: unknown): boolean => regex.test(String(value ?? ''));

    if (args.field === undefined) {
      const ok = check(raw);
      return {
        ok,
        message: ok ? `${args.target} 형식 일치 (${args.pattern})` : `${args.target} 형식 불일치`,
        detail: { value: raw, pattern: args.pattern }
      };
    }

    const list = asArray(raw);
    if (list === null) {
      return { ok: false, message: `${args.target} 이 목록이 아닙니다`, detail: {} };
    }

    const bad: { index: number; value: unknown }[] = [];
    list.forEach((row, index) => {
      const value = (row as Record<string, unknown> | null)?.[args.field as string];
      if (!check(value)) bad.push({ index, value });
    });

    return {
      ok: bad.length === 0,
      message:
        bad.length === 0
          ? `${args.field} 형식 일치 (${list.length}행, ${args.pattern})`
          : `${args.field} 형식 불일치 ${bad.length}건`,
      detail: { rows: list.length, pattern: args.pattern, bad: bad.slice(0, 10) }
    };
  }
};

// ─────────────────────────────────────────────────────────────
// 6. cross_equal — 두 목록의 같은 키가 같은 값을 갖는가
// ─────────────────────────────────────────────────────────────

const crossArgs = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  /** 매칭 키 항목 이름 */
  key: z.string().min(1),
  /** 비교할 항목 이름들 */
  fields: z.array(z.string().min(1)).min(1)
});

export const crossEqual: Rule<z.infer<typeof crossArgs>> = {
  id: 'cross_equal',
  version: 1,
  description: '두 목록에서 같은 키를 가진 행의 항목 값이 같은가',
  validate: (args) => crossArgs.parse(args),
  run(args, context): RuleResult {
    const left = asArray(pick(context, args.left));
    const right = asArray(pick(context, args.right));

    if (left === null || right === null) {
      return { ok: false, message: '비교할 목록이 없습니다', detail: {} };
    }

    const rightByKey = new Map<string, Record<string, unknown>>();
    for (const row of right) {
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      rightByKey.set(String(record[args.key]), record);
    }

    const diffs: { key: string; field: string; left: unknown; right: unknown }[] = [];
    let compared = 0;

    for (const row of left) {
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const key = String(record[args.key]);
      const other = rightByKey.get(key);

      // 짝이 없는 행은 이 규칙이 볼 것이 아니다(empty 규칙이 본다).
      if (!other) continue;

      compared += 1;
      for (const field of args.fields) {
        if (String(record[field] ?? '') !== String(other[field] ?? '')) {
          diffs.push({ key, field, left: record[field], right: other[field] });
        }
      }
    }

    return {
      ok: diffs.length === 0,
      message:
        diffs.length === 0
          ? `${compared}건 대조 — 항목 값 모두 일치`
          : `${diffs.length}건 값이 다릅니다`,
      detail: { compared, fields: args.fields, diffs: diffs.slice(0, 10) }
    };
  }
};

// ─────────────────────────────────────────────────────────────
// 7. date_order — 날짜가 기대한 순서인가
// ─────────────────────────────────────────────────────────────

const dateOrderArgs = z.object({
  target: z.string().min(1),
  field: z.string().optional(),
  order: z.enum(['asc', 'desc', 'same']).default('asc')
});

export const dateOrder: Rule<z.infer<typeof dateOrderArgs>> = {
  id: 'date_order',
  version: 1,
  description: '날짜가 오름차순·내림차순인가, 또는 모두 같은 날인가',
  validate: (args) => dateOrderArgs.parse(args),
  run(args, context): RuleResult {
    const raw = pick(context, args.target);
    const list = asArray(raw);

    if (list === null) {
      return { ok: false, message: `${args.target} 이 목록이 아닙니다`, detail: {} };
    }

    const dates = list.map((row) =>
      args.field === undefined
        ? String(row ?? '')
        : String((row as Record<string, unknown> | null)?.[args.field] ?? '')
    );

    const bad: { index: number; previous: string; current: string }[] = [];

    for (let index = 1; index < dates.length; index += 1) {
      const previous = dates[index - 1] as string;
      const current = dates[index] as string;

      const wrong =
        args.order === 'asc'
          ? current < previous
          : args.order === 'desc'
            ? current > previous
            : current !== previous;

      if (wrong) bad.push({ index, previous, current });
    }

    return {
      ok: bad.length === 0,
      message:
        bad.length === 0
          ? `날짜 순서 ${args.order} 만족 (${dates.length}건)`
          : `날짜 순서가 어긋난 곳 ${bad.length}군데`,
      detail: { order: args.order, count: dates.length, bad: bad.slice(0, 10) }
    };
  }
};

// ─────────────────────────────────────────────────────────────

export const RULES: readonly Rule<never>[] = [
  sumEqual,
  ratioGte,
  empty,
  requiredFields,
  format,
  crossEqual,
  dateOrder
] as unknown as readonly Rule<never>[];

const BY_ID = new Map<string, Rule<never>>(RULES.map((rule) => [rule.id, rule]));

export function getRule(id: string): Rule<never> | null {
  return BY_ID.get(id) ?? null;
}

export function ruleIds(): string[] {
  return [...BY_ID.keys()].sort();
}
