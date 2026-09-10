import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type HelmDatabase } from '../src/main/persistence/Database';
import { MIGRATIONS } from '../src/main/persistence/migrations';
import {
  DEFAULT_STEP_LIMIT,
  LONG_RUN_STEP_LIMIT,
  ThreadStore
} from '../src/main/persistence/ThreadStore';
import { AUTO_CHECKPOINT_STEPS, CheckpointStore } from '../src/main/persistence/CheckpointStore';
import { Inbox } from '../src/main/persistence/Inbox';
import { MAX_SITE_NOTE_BYTES, NoteStore } from '../src/main/persistence/NoteStore';
import { BookmarkMeta } from '../src/main/persistence/BookmarkMeta';
import { ChangeTracker, MAX_SNAPSHOT_BYTES, diffWords } from '../src/main/persistence/ChangeTracker';
import { Bookmarks } from '../src/main/browser/Bookmarks';
import {
  DEFAULT_PARTITION,
  SessionStore,
  partitionFor,
  type SessionCrypt
} from '../src/main/sessions/SessionStore';

/**
 * 지속성 스토어 단위 테스트 (`npm run test:persistence`, GOAL-M4a 성공 조건 2).
 *
 * 실제 SQLite 파일에 쓴다. 메모리 DB 로 하면 마이그레이션과 재연결(= 재시작) 경로를
 * 검증할 수 없고, 그게 이 마일스톤의 핵심이다.
 */

let dir: string;
let db: HelmDatabase;

/** safeStorage 대역. 되돌릴 수 있는 변환이면 암호화 경로를 검증하기에 충분하다. */
const fakeCrypt: SessionCrypt = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf-8'),
  decrypt: (encrypted) => encrypted.toString('utf-8').replace(/^enc:/, '')
};

const brokenCrypt: SessionCrypt = {
  available: () => false,
  encrypt: () => {
    throw new Error('사용할 수 없음');
  },
  decrypt: () => {
    throw new Error('사용할 수 없음');
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-persistence-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 같은 파일을 다시 열어 "앱 재시작" 을 흉내낸다. */
function reopen(): HelmDatabase {
  db.close();
  db = openDatabase(dir);
  return db;
}

// ─────────────────────────────────────────────────────────────

describe('마이그레이션', () => {
  it('user_version 이 마이그레이션 수와 같고, 표가 모두 생긴다', () => {
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);

    for (const expected of [
      'visits',
      'bookmarks',
      'autofill',
      'sessions',
      'threads',
      'thread_messages',
      'checkpoints',
      'inbox',
      'notes',
      'bookmark_meta',
      'page_snapshots'
    ]) {
      expect(tables, `${expected} 표 없음`).toContain(expected);
    }
  });

  it('다시 열어도 버전이 오르지 않고 데이터가 남는다', () => {
    new ThreadStore(db).create({ id: 'keep-me', title: '유지' });

    const reopened = reopen();
    expect(reopened.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(new ThreadStore(reopened).get('keep-me')?.title).toBe('유지');
  });
});

describe('ThreadStore', () => {
  it('생성·조회·상태 변경·메시지 추가가 동작한다', () => {
    const store = new ThreadStore(db);
    const thread = store.create({ title: '공지 수집', sessionName: 'gw' });

    expect(thread.status).toBe('running');
    expect(thread.stepLimit).toBe(DEFAULT_STEP_LIMIT);
    expect(store.get(thread.id)?.sessionName).toBe('gw');

    store.append(thread.id, { role: 'human', text: '공지 200건 뽑아줘' });
    store.append(thread.id, {
      role: 'tool',
      tool: 'navigate',
      args: { url: 'app://portal-a/list?page=1' },
      result: { tabId: 2 }
    });
    store.append(thread.id, { role: 'ai', text: '1페이지를 읽었습니다' });

    const messages = store.messages(thread.id);
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(messages[1]?.tool).toBe('navigate');
    expect((messages[1]?.args as { url: string }).url).toContain('portal-a');

    // 특정 지점 이후만 읽기(체크포인트 복원 경로)
    expect(store.messages(thread.id, 2).map((message) => message.seq)).toEqual([3]);

    expect(store.setStatus(thread.id, 'done', '완료')).toBe(true);
    expect(store.get(thread.id)?.status).toBe('done');
    expect(store.get(thread.id)?.closedReason).toBe('완료');
  });

  it('스텝 상한을 넘으면 알려준다 — 장시간 모드는 상한이 다르다', () => {
    const store = new ThreadStore(db);
    const short = store.create({ stepLimit: 2 });

    expect(store.step(short.id)).toMatchObject({ count: 1, exceeded: false });
    expect(store.step(short.id)).toMatchObject({ count: 2, exceeded: false });
    expect(store.step(short.id)).toMatchObject({ count: 3, exceeded: true });

    const long = store.create({ stepLimit: LONG_RUN_STEP_LIMIT });
    expect(long.stepLimit).toBe(2000);
    expect(store.setStepLimit(short.id, LONG_RUN_STEP_LIMIT)).toBe(true);
    expect(store.step(short.id).exceeded).toBe(false);
  });

  it('재시작하면 running·waiting_approval 이 paused 로 내려간다', () => {
    const store = new ThreadStore(db);
    store.create({ id: 'r1' }); // running 그대로 둔다
    const waiting = store.create({ id: 'r2' });
    const finished = store.create({ id: 'r3' });

    store.setStatus(waiting.id, 'waiting_approval');
    store.setStatus(finished.id, 'done');

    const recovered = new ThreadStore(reopen());
    expect(recovered.recoverInterrupted()).toBe(2);

    expect(recovered.get('r1')?.status).toBe('paused');
    expect(recovered.get('r2')?.status).toBe('paused');
    expect(recovered.get('r3')?.status).toBe('done');
    expect(recovered.get('r1')?.closedReason).toContain('종료');
  });

  it('스레드를 지우면 메시지도 함께 지워진다', () => {
    const store = new ThreadStore(db);
    const thread = store.create({});
    store.append(thread.id, { role: 'human', text: '안녕' });

    expect(store.remove(thread.id)).toBe(true);
    expect(store.messageCount(thread.id)).toBe(0);
  });
});

describe('CheckpointStore', () => {
  it('저장한 내용이 그대로 복원된다(라운드트립)', () => {
    const threads = new ThreadStore(db);
    const store = new CheckpointStore(db);
    const thread = threads.create({ title: '위키 순회' });

    threads.append(thread.id, { role: 'human', text: '결함 목록 만들어줘' });

    const saved = store.save({
      threadId: thread.id,
      name: '200페이지',
      note: '절반',
      trigger: 'steps',
      messageIndex: 1,
      payload: {
        tabs: [{ url: 'app://portal-e/page?id=200', sessionName: 'default', scrollY: 480, tabId: 3 }],
        results: [{ pageId: 200, kind: 'broken' }],
        noteVersions: [{ scope: 'site:portal-e', version: 2 }],
        cursor: { nextId: 201, visited: 200 }
      }
    });

    expect(AUTO_CHECKPOINT_STEPS).toBe(10);

    const loaded = new CheckpointStore(reopen()).get(saved.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('200페이지');
    expect(loaded?.trigger).toBe('steps');
    expect(loaded?.messageIndex).toBe(1);
    expect(loaded?.payload.tabs[0]?.url).toBe('app://portal-e/page?id=200');
    expect(loaded?.payload.tabs[0]?.scrollY).toBe(480);
    expect(loaded?.payload.results).toEqual([{ pageId: 200, kind: 'broken' }]);
    expect(loaded?.payload.noteVersions).toEqual([{ scope: 'site:portal-e', version: 2 }]);
    expect(loaded?.payload.cursor).toEqual({ nextId: 201, visited: 200 });
  });

  it('최신 체크포인트를 돌려주고 스레드별로 격리된다', () => {
    const threads = new ThreadStore(db);
    const store = new CheckpointStore(db);
    const a = threads.create({ id: 'ta' });
    const b = threads.create({ id: 'tb' });

    store.save({ threadId: a.id, name: '1', trigger: 'manual', messageIndex: 0 });
    const second = store.save({ threadId: a.id, name: '2', trigger: 'navigate', messageIndex: 1 });
    store.save({ threadId: b.id, name: 'b1', trigger: 'manual', messageIndex: 0 });

    expect(store.latest(a.id)?.id).toBe(second.id);
    expect(store.count(a.id)).toBe(2);
    expect(store.count(b.id)).toBe(1);
    expect(store.latest('없는스레드')).toBeNull();
  });

  it('스레드를 지우면 체크포인트도 함께 지워진다', () => {
    const threads = new ThreadStore(db);
    const store = new CheckpointStore(db);
    const thread = threads.create({ id: 'tc' });
    store.save({ threadId: thread.id, name: 'x', trigger: 'manual', messageIndex: 0 });

    threads.remove(thread.id);
    expect(store.count(thread.id)).toBe(0);
  });
});

describe('Inbox', () => {
  it('미읽음 카운트가 게시·읽음·전체읽음을 따라간다', () => {
    let changes = 0;
    const inbox = new Inbox(db, () => {
      changes += 1;
    });

    expect(inbox.unreadCount()).toBe(0);

    const first = inbox.post({ kind: 'done', title: '공지 200건 수집 완료', summary: '행 200' });
    inbox.post({ kind: 'approval', title: '상신 승인 필요', threadId: 't1' });
    inbox.post({ kind: 'failed', title: '실패', threadId: 't1' });

    expect(inbox.unreadCount()).toBe(3);
    expect(changes).toBe(3);

    expect(inbox.markRead(first.id)).toBe(true);
    expect(inbox.markRead(first.id), '이미 읽은 항목은 다시 세지 않는다').toBe(false);
    expect(inbox.unreadCount()).toBe(2);

    expect(inbox.list({ unreadOnly: true })).toHaveLength(2);
    expect(inbox.list({ threadId: 't1' })).toHaveLength(2);

    expect(inbox.markAllRead()).toBe(2);
    expect(inbox.unreadCount()).toBe(0);
  });

  it('재시작 후에도 항목이 남는다', () => {
    new Inbox(db).post({ kind: 'result', title: '루틴 결과', evidencePath: 'C:/tmp/a.csv' });

    const after = new Inbox(reopen());
    const items = after.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.evidencePath).toBe('C:/tmp/a.csv');
    expect(after.unreadCount()).toBe(1);
  });

  it('보존 기간이 지난 읽은 항목만 버린다', () => {
    const inbox = new Inbox(db);
    const old = inbox.post({ kind: 'done', title: '오래된 것' });
    const oldUnread = inbox.post({ kind: 'done', title: '오래됐지만 안 읽음' });
    inbox.post({ kind: 'done', title: '최근' });

    const longAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE inbox SET created_at = ? WHERE id IN (?, ?)').run(longAgo, old.id, oldUnread.id);
    inbox.markRead(old.id);

    expect(inbox.prune(30)).toBe(1);
    expect(inbox.get(old.id)).toBeNull();
    expect(inbox.get(oldUnread.id)).not.toBeNull();
  });
});

describe('NoteStore', () => {
  it('버전을 쌓으며 이어 붙이고, 이전 버전으로 되돌릴 수 있다', () => {
    const notes = new NoteStore(db);

    const first = notes.append('site:portal-a.example.co.kr', '목록은 20행씩 나온다');
    expect(first.ok).toBe(true);

    const second = notes.append('site:portal-a.example.co.kr', '페이지 번호는 하단');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.note.version).toBe(2);

    expect(notes.read('site:portal-a.example.co.kr')?.text).toContain('20행씩');
    expect(notes.read('site:portal-a.example.co.kr')?.text).toContain('하단');
    expect(notes.history('site:portal-a.example.co.kr')).toHaveLength(2);

    // 되돌리기 = 이전 버전을 새 버전으로 다시 쓴다(이력이 남는다)
    const restored = notes.restore('site:portal-a.example.co.kr', 1);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.note.version).toBe(3);
    expect(notes.read('site:portal-a.example.co.kr')?.text).not.toContain('하단');
  });

  it('범위 형식이 아니면 거부한다', () => {
    const notes = new NoteStore(db);
    for (const scope of ['그냥메모', 'user:kim', 'thread', 'site:', '']) {
      const result = notes.append(scope, '내용');
      expect(result.ok, scope).toBe(false);
      if (!result.ok) expect(result.reason).toBe('scope');
    }

    expect(notes.append('thread:t-1', '내용').ok).toBe(true);
  });

  it('자격증명 패턴을 거부한다 — 키워드만 있는 문장은 막지 않는다', () => {
    const notes = new NoteStore(db);

    const rejected = [
      '비밀번호: abcd1234',
      'password=hunter2',
      '토큰 = eyJhbGciOiJIUzI1NiJ9',
      'API_KEY: sk-0123456789abcdef',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      '카드번호 4111-1111-1111-1111'
    ];

    for (const text of rejected) {
      const result = notes.append('thread:t-1', text);
      expect(result.ok, `막히지 않았다: ${text}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('credential');
    }

    // 값이 붙지 않은 언급은 통과해야 한다 — 아니면 메모를 못 쓴다.
    expect(notes.append('thread:t-1', '로그인하면 비밀번호를 물어본다').ok).toBe(true);
    expect(notes.append('thread:t-1', '토큰 만료가 잦다').ok).toBe(true);
  });

  it('개인정보 패턴을 거부한다', () => {
    const notes = new NoteStore(db);

    for (const text of ['담당자 사번 1234567', '연락처 010-1234-5678', '메일 kim@example.co.kr']) {
      const result = notes.append('site:portal-d', text);
      expect(result.ok, `막히지 않았다: ${text}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('pii');
    }
  });

  it('site 메모는 2KB 상한을 넘기면 앞부분을 버린다', () => {
    const notes = new NoteStore(db);
    const chunk = `${'가'.repeat(200)}`;

    let truncatedSeen = false;
    for (let round = 0; round < 20; round += 1) {
      const result = notes.append('site:portal-a', `${round} ${chunk}`);
      expect(result.ok).toBe(true);
      if (result.ok && result.truncated) truncatedSeen = true;
    }

    expect(truncatedSeen, '상한에 걸리지 않았다').toBe(true);
    const stored = notes.read('site:portal-a')?.text ?? '';
    expect(Buffer.byteLength(stored, 'utf-8')).toBeLessThanOrEqual(MAX_SITE_NOTE_BYTES);
    // 문자 경계에서 잘려야 한다 — 대체문자가 남으면 자르기가 틀린 것이다.
    expect(stored).not.toContain('�');
    // 최근 내용이 남는다
    expect(stored).toContain('19 ');
  });

  it('재시작 후에도 메모가 남는다', () => {
    new NoteStore(db).append('site:portal-b', '필터는 XHR 로 온다');
    expect(new NoteStore(reopen()).read('site:portal-b')?.text).toContain('XHR');
  });
});

describe('BookmarkMeta', () => {
  it('북마크에 힌트를 붙이고 질의로 찾는다', () => {
    const bookmarks = new Bookmarks(db);
    const notices = bookmarks.add('app://portal-a/list?page=1', '그룹웨어 공지');
    const tickets = bookmarks.add('app://portal-b/', 'ITSM 티켓');
    expect(notices).not.toBeNull();
    expect(tickets).not.toBeNull();

    const meta = new BookmarkMeta(db);
    const saved = meta.set(notices?.id ?? 0, {
      intent: '주간 공지 수집',
      expectedContent: '20행 표와 하단 페이지 번호',
      keyFields: ['제목', '부서', '작성일'],
      agentHints: '세션이 끊기면 로그인 페이지로 밀린다'
    });
    expect(saved.ok).toBe(true);

    expect(meta.get(notices?.id ?? 0)?.keyFields).toEqual(['제목', '부서', '작성일']);

    // 부분 갱신은 기존 값을 지우지 않는다
    meta.set(notices?.id ?? 0, { agentHints: '로그인 후 재개' });
    expect(meta.get(notices?.id ?? 0)?.intent).toBe('주간 공지 수집');
    expect(meta.get(notices?.id ?? 0)?.agentHints).toBe('로그인 후 재개');

    // 질의: 제목·주소·의도·힌트 어디에 걸려도 찾는다
    expect(meta.listWithBookmarks('주간').map((entry) => entry.bookmark.id)).toEqual([
      notices?.id
    ]);
    expect(meta.listWithBookmarks('ITSM')).toHaveLength(1);
    expect(meta.listWithBookmarks('')).toHaveLength(2);
    expect(meta.listWithBookmarks('없는말')).toHaveLength(0);

    // 메타 없는 북마크도 함께 나온다
    expect(meta.listWithBookmarks('ITSM')[0]?.meta).toBeNull();
  });

  it('힌트에도 자격증명·개인정보를 저장하지 않는다', () => {
    const bookmarks = new Bookmarks(db);
    const bookmark = bookmarks.add('app://portal-c/', '규정');
    const meta = new BookmarkMeta(db);

    const credential = meta.set(bookmark?.id ?? 0, { agentHints: '공용계정 password: share1234' });
    expect(credential.ok).toBe(false);
    if (!credential.ok) expect(credential.reason).toBe('credential');

    const pii = meta.set(bookmark?.id ?? 0, { intent: '담당자 kim@example.co.kr 확인' });
    expect(pii.ok).toBe(false);
    if (!pii.ok) expect(pii.reason).toBe('pii');

    expect(meta.get(bookmark?.id ?? 0), '거부됐는데 저장됐다').toBeNull();
  });

  it('북마크를 지우면 메타도 지워진다', () => {
    const bookmarks = new Bookmarks(db);
    const bookmark = bookmarks.add('app://portal-a/', '공지');
    const meta = new BookmarkMeta(db);
    meta.set(bookmark?.id ?? 0, { intent: '수집' });

    bookmarks.remove(bookmark?.id ?? 0);
    expect(meta.get(bookmark?.id ?? 0)).toBeNull();
  });
});

describe('ChangeTracker — 낱말 diff 골든', () => {
  it('골든 1: 낱말이 추가되면 그 낱말만 added 다', () => {
    const diff = diffWords('규정 개정 이력 없음', '규정 개정 이력 2건 없음');

    expect(diff.addedWords).toBe(1);
    expect(diff.removedWords).toBe(0);
    expect(diff.hunks.filter((hunk) => hunk.kind === 'added').map((hunk) => hunk.text)).toEqual([
      '2건'
    ]);
    expect(diff.coarse).toBe(false);
  });

  it('골든 2: 낱말이 빠지면 그 낱말만 removed 다', () => {
    const diff = diffWords('신청 후 팀장 승인 필요', '신청 후 승인 필요');

    expect(diff.removedWords).toBe(1);
    expect(diff.addedWords).toBe(0);
    expect(diff.hunks.filter((hunk) => hunk.kind === 'removed').map((hunk) => hunk.text)).toEqual([
      '팀장'
    ]);
  });

  it('골든 3: 낱말이 바뀌면 removed + added 로 나온다', () => {
    const diff = diffWords('휴가는 3일 전 신청', '휴가는 5일 전 신청');

    expect(diff.removedWords).toBe(1);
    expect(diff.addedWords).toBe(1);
    expect(diff.changedWords).toBe(2);
    expect(diff.hunks.map((hunk) => hunk.kind)).toEqual(['same', 'removed', 'added', 'same']);
    expect(diff.hunks[1]?.text).toBe('3일');
    expect(diff.hunks[2]?.text).toBe('5일');
  });

  it('바뀐 게 없으면 변경 0이고 전체가 same 이다', () => {
    const diff = diffWords('같은 본문 그대로', '같은 본문 그대로');
    expect(diff.changedWords).toBe(0);
    expect(diff.hunks).toEqual([{ kind: 'same', text: '같은 본문 그대로', words: 3 }]);
  });

  it('공백 종류가 달라도 같은 본문으로 본다', () => {
    expect(diffWords('가  나\t다', '가 나\n다').changedWords).toBe(0);
  });
});

describe('ChangeTracker — 스냅샷', () => {
  it('본문을 남기고 이력·diff 를 만든다', () => {
    const tracker = new ChangeTracker(db);
    const url = 'app://portal-c/doc?id=1';

    const first = tracker.snapshot(url, '규정 제1호', '휴가는 3일 전 신청');
    expect(first.created).toBe(true);

    // 같은 본문은 다시 쌓지 않는다
    const same = tracker.snapshot(url, '규정 제1호', '휴가는 3일 전 신청');
    expect(same.created).toBe(false);
    expect(tracker.count(url)).toBe(1);

    const second = tracker.snapshot(url, '규정 제1호', '휴가는 5일 전 신청');
    expect(second.created).toBe(true);
    expect(tracker.count(url)).toBe(2);

    const diff = tracker.diff(url);
    expect(diff).not.toBeNull();
    expect(diff?.changedWords).toBe(2);
    expect(diff?.from.id).toBe(first.snapshot.id);
    expect(diff?.to.id).toBe(second.snapshot.id);

    // 스냅샷이 하나뿐이면 비교 대상이 없다
    expect(tracker.diff('app://portal-c/doc?id=999')).toBeNull();

    expect(tracker.trackedUrls()[0]).toMatchObject({ url, snapshots: 2 });
  });

  it('200KB 를 넘는 본문은 자르고 그 사실을 남긴다', () => {
    const tracker = new ChangeTracker(db);
    const long = 'ㄱ'.repeat(120_000); // UTF-8 3바이트 × 120,000 = 360KB

    const result = tracker.snapshot('app://portal-e/page?id=1', '긴 문서', long);
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.bytes).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it('보존 기간이 지난 스냅샷을 버리되 주소별 최신 1건은 남긴다', () => {
    const tracker = new ChangeTracker(db);
    const url = 'app://portal-a/list?page=1';

    tracker.snapshot(url, '공지', '버전 1');
    tracker.snapshot(url, '공지', '버전 2');
    tracker.snapshot(url, '공지', '버전 3');

    const longAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE page_snapshots SET captured_at = ?').run(longAgo);

    expect(tracker.prune(30)).toBe(2);
    expect(tracker.count(url)).toBe(1);
    expect(tracker.latest(url)?.text).toBe('버전 3');
  });
});

describe('SessionStore', () => {
  it('기본 세션은 persist:helm 을 쓰고 이름 있는 세션만 접미사를 붙인다', () => {
    const sessions = new SessionStore(db, fakeCrypt);

    expect(sessions.partitionOf('default')).toBe(DEFAULT_PARTITION);
    expect(partitionFor('itsm')).toBe('persist:helm:itsm');

    sessions.ensure('itsm');
    sessions.ensure('gw');
    expect(sessions.partitionOf('itsm')).toBe('persist:helm:itsm');
    expect(sessions.partitionOf('gw')).toBe('persist:helm:gw');

    expect(sessions.list().map((info) => info.name).sort()).toEqual(['default', 'gw', 'itsm']);
  });

  it('이름 규칙에 맞지 않으면 만들지 않는다 — 파티션 문자열에 들어가는 값이다', () => {
    const sessions = new SessionStore(db, fakeCrypt);

    for (const name of ['ITSM', '한글', 'a b', '../etc', 'persist:x', '', 'x'.repeat(40)]) {
      expect(sessions.ensure(name), name).toBeNull();
    }
  });

  it('use 는 현재 세션을 바꾸고 마지막 사용 시각을 올린다', () => {
    const sessions = new SessionStore(db, fakeCrypt);
    expect(sessions.currentName()).toBe('default');

    expect(sessions.use('itsm')?.partition).toBe('persist:helm:itsm');
    expect(sessions.currentName()).toBe('itsm');
    expect(sessions.use('없는이름!')).toBeNull();
    expect(sessions.currentName(), '실패한 use 가 현재 세션을 바꾸면 안 된다').toBe('itsm');
  });

  it('로그인 경로·시각을 암호화해 남기고 재시작 후 읽는다', () => {
    const sessions = new SessionStore(db, fakeCrypt);
    sessions.recordLogin('itsm', 'inapp', 'portal-b');

    // 저장된 것은 평문이 아니다
    const raw = db.prepare('SELECT meta, meta_encrypted FROM sessions WHERE name = ?').get('itsm') as
      | { meta: Buffer; meta_encrypted: number }
      | undefined;
    expect(raw?.meta_encrypted).toBe(1);
    expect(raw?.meta.toString('utf-8').startsWith('enc:')).toBe(true);

    const after = new SessionStore(reopen(), fakeCrypt);
    const meta = after.meta('itsm');
    expect(meta?.loginMethod).toBe('inapp');
    expect(meta?.verifiedHost).toBe('portal-b');
    expect(after.get('itsm')?.loggedInAt).toBeGreaterThan(0);
  });

  it('safeStorage 를 못 쓰면 평문으로 남기되 그 사실을 표시한다', () => {
    const sessions = new SessionStore(db, brokenCrypt);
    sessions.recordLogin('gw', 'external');

    const raw = db.prepare('SELECT meta_encrypted FROM sessions WHERE name = ?').get('gw') as
      | { meta_encrypted: number }
      | undefined;
    expect(raw?.meta_encrypted).toBe(0);
    expect(sessions.meta('gw')?.loginMethod).toBe('external');
  });

  it('기본 세션은 지울 수 없다', () => {
    const sessions = new SessionStore(db, fakeCrypt);
    sessions.ensure('itsm');

    expect(sessions.remove('default')).toBe(false);
    expect(sessions.remove('itsm')).toBe(true);
    expect(sessions.get('itsm')).toBeNull();
  });
});
