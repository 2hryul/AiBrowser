import { AdapterBrokenError, type Adapter, type AdapterResult, type ToolContract } from '../Engine';
import type { ValueSource } from '../types';
import { parseTextTable, type PortalIo } from './io';

/**
 * 정산 포털 어댑터 — 구조화 우선 사다리의 본보기.
 *
 * 사다리를 내려가는 순서와 그 뜻:
 *
 *   1. **`network`** — 화면을 그리는 XHR(`/api/settlements`) 응답을 그대로 읽는다.
 *      화면 서식(쉼표·말줄임)을 거치지 않은 값이라 가장 믿을 만하다.
 *   2. **`dom`** — API 가 죽었으면(503) 서버 렌더링 표를 읽는다. 값은 같아야 하지만
 *      경로가 달라졌다는 **사실이 기록에 남아야** 한다(`AdapterResult.source`).
 *
 * 폴백을 조용히 하지 않는 것이 요점이다. `source` 가 `dom` 으로 바뀌면 증거 팩과 단계 기록에
 * 그대로 찍히고, 나중에 "왜 이 날은 값이 달랐나" 를 되짚을 수 있다.
 *
 * 표 구조 자체가 사라지면(헤더를 못 찾으면) `ADAPTER_BROKEN` 이다. 빈 목록으로 내려가면
 * "거래가 0건" 과 "화면이 바뀜" 이 구별되지 않고, 0건은 오라클을 통과해 버린다.
 */

const HEADERS = ['거래번호', '공급사', '정산금액', '결재자'] as const;

export const SETTLE_CONTRACT: ToolContract = {
  name: 'portal_settle_daily',
  version: 1,
  input: ['date'],
  output: ['rows'],
  // 조회만 한다 — 바깥 상태를 바꾸지 않으므로 M3 승인 대상이 아니다.
  write: false,
  source: 'network',
  // 결재자 이름·사번은 대사에 쓰지 않는다. 증거 팩에서 가려진다.
  pii: ['rows[].approver', 'rows[].approverNo']
};

interface ApiPayload {
  date: string;
  total: number;
  rows: Record<string, unknown>[];
}

function parseApi(body: string, stepId: string): ApiPayload {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new AdapterBrokenError(
      SETTLE_CONTRACT.name,
      `${stepId}: 정산 API 응답이 JSON 이 아닙니다 — ${(error as Error).message}`
    );
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record['rows'])) {
    throw new AdapterBrokenError(SETTLE_CONTRACT.name, `${stepId}: 정산 API 응답에 rows 가 없습니다`);
  }

  return {
    date: String(record['date'] ?? ''),
    total: Number(record['total'] ?? (record['rows'] as unknown[]).length),
    rows: record['rows'] as Record<string, unknown>[]
  };
}

/**
 * 화면 표 → 행.
 *
 * **항목 이름과 모양을 API 응답과 같게 맞춘다.** 폴백했다고 모양이 달라지면 뒤 단계가
 * 깨진다 — 실측으로 잡았다: 화면 표에는 날짜 칸이 없어(페이지 전체가 하루치다) `date` 가
 * 빠졌고, `normalize` 의 날짜 정규화가 빈 값에서 터져 그 날 판정이 FAIL 로 나왔다.
 * 폴백이 판정을 바꾸면 폴백이 아니라 장애다. 요청 날짜를 그 자리에 채운다.
 *
 * 반대로 화면에 정말 없는 항목(`approverNo`)은 **만들지 않는다**. 빈 문자열로 채우면
 * "값이 없다" 와 "빈 값이다" 가 구별되지 않는다.
 */
function rowsFromDom(text: string, date: string, stepId: string): Record<string, unknown>[] {
  const table = parseTextTable(text, HEADERS);

  if (table === null) {
    throw new AdapterBrokenError(
      SETTLE_CONTRACT.name,
      `${stepId}: 정산 화면에서 표 머리글(${HEADERS.join('·')})을 찾을 수 없습니다`
    );
  }

  return table.map((row) => ({
    txId: row['거래번호'] ?? '',
    date,
    vendor: row['공급사'] ?? '',
    amount: row['정산금액'] ?? '',
    approver: row['결재자'] ?? ''
  }));
}

export function createSettleAdapter(io: PortalIo): Adapter {
  return {
    contract: SETTLE_CONTRACT,

    async run(context): Promise<AdapterResult> {
      const date = String(context.args['date'] ?? context.inputs['date'] ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`정산 어댑터: 날짜 형식이 아닙니다 (${date})`);
      }

      const tabId = await io.open(`app://portal-h-settle/?date=${encodeURIComponent(date)}`);

      // 도청을 먼저 켜고 조회를 누른다 — 켜기 전에 지나간 응답은 잡히지 않는다.
      await io.tap(tabId, '/api/settlements');
      await io.click(tabId, '조회', 'button');
      await io.wait(300);

      const entries = await io.tap(tabId, '/api/settlements');
      const answered = entries.filter((entry) => entry.url.includes(encodeURIComponent(date)) || entry.url.includes(date));
      const ok = answered.find((entry) => entry.status === 200 && entry.body !== null);

      const screenshot = await io.screenshot(tabId, `${context.stepId}-settle`);
      const shot = screenshot === null ? {} : { screenshot };

      if (ok && ok.body !== null) {
        const payload = parseApi(ok.body, context.stepId);

        // 응답이 화면과 다른 날짜를 말하면 조회가 안 먹은 것이다 — 억지로 쓰지 않는다.
        if (payload.date !== date) {
          throw new AdapterBrokenError(
            SETTLE_CONTRACT.name,
            `${context.stepId}: 요청 ${date} 과 응답 ${payload.date} 의 날짜가 다릅니다`
          );
        }

        return {
          value: payload.rows,
          source: 'network' satisfies ValueSource,
          raw: payload,
          note: `정산 API ${payload.rows.length}건`,
          ...shot
        };
      }

      // ── 폴백: API 가 답하지 않았다. 화면으로 내려간다. ──
      const failed = answered.find((entry) => entry.status !== null && entry.status >= 500);
      const rows = rowsFromDom(await io.text(tabId), date, context.stepId);

      return {
        value: rows,
        source: 'dom' satisfies ValueSource,
        raw: { fallback: 'dom', apiStatus: failed?.status ?? null, rows },
        note: `정산 API 응답 없음(${failed?.status ?? '기록 없음'}) → 화면 표 ${rows.length}건으로 폴백`,
        ...shot
      };
    }
  };
}
