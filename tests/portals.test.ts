import { describe, expect, it } from 'vitest';
import {
  PORTAL_E,
  PORTAL_E_TOTAL,
  allDefects,
  routePortalE
} from '../src/main/browser/portals/wiki';
import {
  PORTAL_G,
  allDecisions,
  allMessages,
  routePortalG
} from '../src/main/browser/portals/messenger';

/**
 * 모의 포털 E·G 의 불변식.
 *
 * 시나리오 E 의 성공 조건("결함 50건 · 방문 400 · 중복 0")은 이 fixture 가 정확히 그만큼을
 * 만들어 낸다는 전제 위에 있다. 전제가 틀리면 시나리오는 통과해도 아무것도 증명하지 못한다.
 */

async function bodyOf(response: Response): Promise<string> {
  return response.text();
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('포털 E — 위키형', () => {
  it('문서 400개, 20장 × 20개', () => {
    expect(PORTAL_E_TOTAL).toBe(400);
    expect(PORTAL_E.sections * PORTAL_E.pagesPerSection).toBe(400);
  });

  it('결함은 깨진 링크 30 + 구 도메인 20 = 50건이고, 겹치는 페이지가 1개다', () => {
    const defects = allDefects();
    const broken = defects.filter((defect) => defect.kind === 'broken');
    const legacy = defects.filter((defect) => defect.kind === 'legacy');

    expect(broken).toHaveLength(30);
    expect(legacy).toHaveLength(20);
    expect(defects).toHaveLength(50);

    // 결함 단위 50건 / 페이지 단위 49개 — 260 이 둘 다 가진다(13과 20의 공배수).
    const pages = new Set(defects.map((defect) => defect.pageId));
    expect(pages.size).toBe(49);
    expect(defects.filter((defect) => defect.pageId === 260)).toHaveLength(2);
  });

  it('목차는 섹션만 주고 자식은 /tree 로만 온다', async () => {
    const index = await bodyOf(routePortalE(new URL('app://portal-e/')));

    // 20개 섹션 버튼은 있지만 자식 목록은 모두 빈 채로 온다(스크립트가 채운다).
    expect(index.match(/class="section-toggle"/g)).toHaveLength(20);
    expect(index.match(/<ul class="section-children" id="section-\d+" hidden><\/ul>/g)).toHaveLength(
      20
    );

    const tree = await jsonOf<{ pages: { id: number }[] }>(
      routePortalE(new URL('app://portal-e/tree?section=3'))
    );
    expect(tree.pages).toHaveLength(20);
    expect(tree.pages[0]?.id).toBe(41);
    expect(tree.pages[19]?.id).toBe(60);
  });

  it('모든 문서가 열리고, 결함 링크가 가리키는 곳은 404 다', async () => {
    for (const id of [1, 13, 260, 400]) {
      const response = routePortalE(new URL(`app://portal-e/page?id=${id}`));
      expect(response.status, `문서 ${id}`).toBe(200);
    }

    expect(routePortalE(new URL('app://portal-e/page?id=10013')).status).toBe(404);
    expect(routePortalE(new URL('app://portal-e/page?id=401')).status).toBe(404);
    expect(routePortalE(new URL('app://portal-e/page?id=0')).status).toBe(404);
  });

  it('구 도메인 링크는 다른 호스트를 가리킨다', async () => {
    const body = await bodyOf(routePortalE(new URL('app://portal-e/page?id=20')));
    expect(body).toContain('data-defect="legacy"');
    expect(body).toContain('old-intra.example.co.kr');
  });
});

describe('포털 G — 메신저형', () => {
  it('메시지 240개, 결정사항 26건(본문 6 + 답글 20)', () => {
    expect(allMessages()).toHaveLength(PORTAL_G.total);
    expect(PORTAL_G.total).toBe(240);

    const decisions = allDecisions();
    expect(decisions.filter((item) => item.id <= PORTAL_G.total)).toHaveLength(6);
    expect(decisions.filter((item) => item.id > 1000)).toHaveLength(20);
    expect(decisions).toHaveLength(26);
  });

  it('첫 화면에는 메시지가 없다 — /messages 로만 온다', async () => {
    const room = await bodyOf(routePortalG(new URL('app://portal-g/')));
    // 서버가 주는 목록은 빈 <ul> 하나뿐이다 — 내용은 /messages 응답으로만 채워진다.
    expect(room).toMatch(/<ul id="messages"[^>]*><\/ul>/);
  });

  it('/messages 는 before 커서로 과거로 거슬러 올라간다', async () => {
    const first = await jsonOf<{ oldest: number; messages: { id: number }[] }>(
      routePortalG(new URL('app://portal-g/messages?before=241&limit=30'))
    );
    expect(first.messages).toHaveLength(30);
    expect(first.messages[0]?.id).toBe(211);
    expect(first.messages[29]?.id).toBe(240);
    expect(first.oldest).toBe(211);

    // 커서를 이어 붙이면 240개를 정확히 한 번씩 받는다.
    const seen = new Set<number>();
    let cursor = PORTAL_G.total + 1;
    let rounds = 0;

    while (cursor > 1 && rounds < 20) {
      const batch = await jsonOf<{ oldest: number; messages: { id: number }[] }>(
        routePortalG(new URL(`app://portal-g/messages?before=${cursor}&limit=30`))
      );
      for (const message of batch.messages) seen.add(message.id);
      cursor = batch.oldest;
      rounds += 1;
    }

    expect(seen.size).toBe(240);
    expect(rounds).toBe(8);
  });

  it('접힌 스레드는 /thread 로 펼치고 마지막 답글이 결정사항이다', async () => {
    const thread = await jsonOf<{ replies: { id: number; decision: boolean }[] }>(
      routePortalG(new URL('app://portal-g/thread?id=12'))
    );
    expect(thread.replies).toHaveLength(3);
    expect(thread.replies[2]?.decision).toBe(true);

    // 스레드가 없는 메시지는 빈 배열
    const none = await jsonOf<{ replies: unknown[] }>(
      routePortalG(new URL('app://portal-g/thread?id=11'))
    );
    expect(none.replies).toEqual([]);
  });

  it('모든 고정 링크가 열린다 — 근거 링크 유효성의 전제', async () => {
    for (const message of [...allMessages(), ...allDecisions()]) {
      const url = new URL(message.permalink);
      const response = routePortalG(url);
      expect(response.status, message.permalink).toBe(200);
    }
  });
});
