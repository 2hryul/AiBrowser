import { esc, html, json, notFound, page } from './html';

/**
 * 포털 G — 사내 메신저형. Handoff(사람 개입)와 근거 링크 검증의 시험대다.
 *
 * 재현하는 난관:
 *   - **가상 스크롤**: DOM 에 30줄만 남는다. 위로 올려야 과거 메시지가 오고, 화면을 벗어난 줄은
 *     지워진다 — 스크롤하며 누적하지 않으면 전체를 볼 수 없다.
 *   - **스레드 접힘**: 답글은 접혀 있고 펼칠 때 XHR 로 온다. 결정사항이 답글에 숨어 있다.
 *   - **`/messages` JSON**: 화면을 긁는 대신 이 응답을 모으는 것이 정석이다.
 *
 * 각 메시지에는 고정 링크(`/message?id=`)가 있다. 주간보고 초안의 "근거 링크" 가 이것이다.
 */

export const PORTAL_G = {
  total: 240,
  pageSize: 30,
  /** 답글이 달린 메시지 간격 — 12·24·… = 20개 스레드 */
  threadEvery: 12,
  repliesPerThread: 3,
  /** 결정사항이 담긴 메시지 간격 — 40·80·… = 6건 */
  decisionEvery: 40
} as const;

const SPEAKERS = ['김주임', '이대리', '박과장', '최차장', '정부장'];
const ROOMS = ['정보관리팀', '릴리스', '장애대응'];

const SUBJECTS = [
  '배포 일정',
  '테스트 서버',
  '접근 권한',
  '데이터 이관',
  '점검 창구',
  '릴리스 노트'
];

export interface ChatMessage {
  id: number;
  room: string;
  speaker: string;
  /** ISO 날짜 — 주간보고가 기간으로 묶는다 */
  sentAt: string;
  text: string;
  hasThread: boolean;
  /** 결정사항이면 본문이 "결정:" 으로 시작한다 */
  decision: boolean;
  permalink: string;
}

function messageAt(id: number): ChatMessage {
  const subject = SUBJECTS[(id - 1) % SUBJECTS.length] ?? '기타';
  const decision = id % PORTAL_G.decisionEvery === 0;
  const day = 1 + ((id - 1) % 28);

  return {
    id,
    room: ROOMS[(id - 1) % ROOMS.length] ?? '정보관리팀',
    speaker: SPEAKERS[(id - 1) % SPEAKERS.length] ?? '김주임',
    sentAt: `2026-08-${String(day).padStart(2, '0')}`,
    text: decision
      ? `결정: ${subject} 은(는) ${day}일에 진행한다`
      : `${subject} 관련해서 확인 부탁드립니다 (#${id})`,
    hasThread: id % PORTAL_G.threadEvery === 0,
    decision,
    permalink: `app://portal-g/message?id=${id}`
  };
}

export function allMessages(): ChatMessage[] {
  return Array.from({ length: PORTAL_G.total }, (_unused, index) => messageAt(index + 1));
}

function repliesOf(id: number): ChatMessage[] {
  if (id % PORTAL_G.threadEvery !== 0) return [];

  return Array.from({ length: PORTAL_G.repliesPerThread }, (_unused, index) => {
    const replyId = id * 1000 + index + 1;
    const decision = index === PORTAL_G.repliesPerThread - 1;
    const parent = messageAt(id);

    return {
      id: replyId,
      room: parent.room,
      speaker: SPEAKERS[(replyId - 1) % SPEAKERS.length] ?? '이대리',
      sentAt: parent.sentAt,
      text: decision
        ? `결정: ${parent.text.replace(/ 관련해서.*$/, '')} 은(는) 담당자 지정 후 진행`
        : `동의합니다 (${index + 1})`,
      hasThread: false,
      decision,
      permalink: `app://portal-g/message?id=${replyId}`
    };
  });
}

/** 결정사항 전체 — 본문 6건 + 스레드 답글 20건 = 26건 */
export function allDecisions(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let id = 1; id <= PORTAL_G.total; id += 1) {
    const message = messageAt(id);
    if (message.decision) out.push(message);
    out.push(...repliesOf(id).filter((reply) => reply.decision));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 화면
// ─────────────────────────────────────────────────────────────

/**
 * 대화방. 최신 30줄만 그리고, 위로 스크롤하면 이전 묶음을 붙이며 아래쪽을 지운다
 * (진짜 가상 스크롤처럼 DOM 길이가 늘지 않는다).
 */
function chatRoom(): string {
  return page(
    '사내 메신저',
    `<header>사내 메신저</header>
     <main>
       <p id="hint">위로 올리면 이전 메시지를 불러옵니다. 답글은 눌러서 펼칩니다.</p>
       <div id="scroller" style="height:360px;overflow-y:auto;border:1px solid #d5d5dd;padding:8px;">
         <div id="spacer" style="height:1px;"></div>
         <ul id="messages" style="list-style:none;margin:0;padding:0;"></ul>
       </div>
       <p id="status">불러온 묶음 0 · 화면 0줄</p>
     </main>
     <script>
       const WINDOW = ${PORTAL_G.pageSize};
       let oldest = ${PORTAL_G.total + 1};
       let batches = 0;
       let loading = false;

       function render(items, prepend) {
         const list = document.getElementById('messages');
         const html = items
           .map((m) =>
             '<li class="msg" data-id="' + m.id + '" data-decision="' + m.decision + '">' +
             '<b class="msg-speaker">' + m.speaker + '</b> ' +
             '<span class="msg-date">' + m.sentAt + '</span> ' +
             '<span class="msg-text">' + m.text + '</span> ' +
             '<a class="msg-link" href="' + m.permalink + '">고정 링크</a>' +
             (m.hasThread
               ? ' <button class="thread-toggle" data-id="' + m.id + '" aria-expanded="false">답글 ' + ${PORTAL_G.repliesPerThread} + '개</button><ul class="replies" id="replies-' + m.id + '" hidden></ul>'
               : '') +
             '</li>'
           )
           .join('');

         if (prepend) list.insertAdjacentHTML('afterbegin', html);
         else list.insertAdjacentHTML('beforeend', html);

         // 창을 넘는 줄은 버린다 — 누적하지 않으면 전체를 볼 수 없게 만드는 부분이다.
         while (list.children.length > WINDOW) list.removeChild(list.lastElementChild);

         document.getElementById('status').textContent =
           '불러온 묶음 ' + batches + ' · 화면 ' + list.children.length + '줄';
       }

       async function loadOlder() {
         if (loading || oldest <= 1) return;
         loading = true;
         const before = oldest;
         const response = await fetch('app://portal-g/messages?before=' + before + '&limit=' + WINDOW);
         const data = await response.json();
         oldest = data.oldest;
         batches += 1;
         render(data.messages, true);
         loading = false;
       }

       document.getElementById('scroller').addEventListener('scroll', (event) => {
         if (event.target.scrollTop <= 4) void loadOlder();
       });

       document.addEventListener('click', async (event) => {
         const button = event.target.closest('.thread-toggle');
         if (!button) return;
         const id = button.getAttribute('data-id');
         const list = document.getElementById('replies-' + id);
         if (button.getAttribute('aria-expanded') === 'true') {
           button.setAttribute('aria-expanded', 'false');
           list.hidden = true;
           return;
         }
         const response = await fetch('app://portal-g/thread?id=' + id);
         const data = await response.json();
         list.innerHTML = data.replies
           .map((r) =>
             '<li class="reply" data-id="' + r.id + '" data-decision="' + r.decision + '">' +
             r.speaker + ' — ' + r.text +
             ' <a class="msg-link" href="' + r.permalink + '">고정 링크</a></li>'
           )
           .join('');
         list.hidden = false;
         button.setAttribute('aria-expanded', 'true');
       });

       void loadOlder();
     </script>`
  );
}

function messagePage(message: ChatMessage): string {
  return page(
    `메시지 ${message.id}`,
    `<header>사내 메신저 — 고정 링크</header>
     <main>
       <p id="msg-id">${message.id}</p>
       <p id="msg-room">${esc(message.room)}</p>
       <p id="msg-speaker">${esc(message.speaker)}</p>
       <p id="msg-date">${esc(message.sentAt)}</p>
       <p id="msg-text">${esc(message.text)}</p>
     </main>`
  );
}

export function routePortalG(url: URL): Response {
  const route = url.pathname;

  if (route === '/' || route === '/index') return html(chatRoom());

  if (route === '/messages') {
    // 위로 스크롤하며 과거로 간다. before 보다 작은 id 를 limit 개 돌려준다.
    const before = Number(url.searchParams.get('before') ?? String(PORTAL_G.total + 1));
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '30'), 100);

    const end = Math.min(Math.max(before - 1, 0), PORTAL_G.total);
    const start = Math.max(end - limit + 1, 1);
    const messages: ChatMessage[] = [];
    for (let id = start; id <= end; id += 1) messages.push(messageAt(id));

    return json({ total: PORTAL_G.total, oldest: start, messages });
  }

  if (route === '/thread') {
    const id = Number(url.searchParams.get('id') ?? '0');
    const replies = repliesOf(id);
    if (replies.length === 0) return json({ id, replies: [] });
    return json({ id, replies });
  }

  if (route === '/message') {
    const id = Number(url.searchParams.get('id') ?? '0');

    // 답글의 고정 링크도 열려야 한다 — 근거 링크 유효성 검증의 대상이다.
    if (id > 1000) {
      const parentId = Math.floor(id / 1000);
      const reply = repliesOf(parentId).find((item) => item.id === id);
      return reply ? html(messagePage(reply)) : notFound();
    }

    if (!Number.isInteger(id) || id < 1 || id > PORTAL_G.total) return notFound();
    return html(messagePage(messageAt(id)));
  }

  return notFound();
}

export const portalGHooks = {
  total: PORTAL_G.total,
  pageSize: PORTAL_G.pageSize,
  messages: allMessages,
  decisions: allDecisions,
  decisionCount: (): number => allDecisions().length
};
