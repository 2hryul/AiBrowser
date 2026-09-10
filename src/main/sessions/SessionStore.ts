import type { HelmDatabase } from '../persistence/Database';

/**
 * SessionStore — 이름 붙인 쿠키·localStorage 묶음.
 *
 * 사내에서는 같은 브라우저로 여러 계정을 쓴다(ITSM 은 본인 계정, 그룹웨어는 공용 계정).
 * 이름별로 파티션을 나누면 한 창에서 둘 다 로그인한 채로 쓸 수 있다.
 *
 * **기본 세션의 파티션은 `persist:helm` 이다.** `persist:helm:default` 가 아니다 —
 * M0 부터 그 이름으로 쿠키를 쌓아 왔고, 바꾸면 기존 사용자의 로그인이 전부 날아간다.
 * 이름 있는 세션만 `persist:helm:<name>` 을 쓴다.
 *
 * 비밀번호·토큰은 저장하지 않는다(불변 조건 9). 여기 남는 것은 "어떤 경로로 언제 로그인했나"
 * 뿐이고, 그조차 safeStorage 로 암호화한다.
 */

export const DEFAULT_SESSION = 'default';
export const DEFAULT_PARTITION = 'persist:helm';

/** 세션 이름 규칙 — 파티션 문자열에 그대로 들어가므로 좁게 잡는다. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type LoginMethod = 'inapp' | 'oauth_modal' | 'external';

export interface SessionInfo {
  name: string;
  partition: string;
  loginMethod: LoginMethod | null;
  loggedInAt: number | null;
  createdAt: number;
  lastUsedAt: number;
}

/** 세션 메타 — 복호화된 형태. 자격증명은 들어가지 않는다. */
export interface SessionMeta {
  loginMethod: LoginMethod | null;
  loggedInAt: number | null;
  /** 마지막으로 로그인 상태를 확인한 주소(호스트만) */
  verifiedHost?: string;
}

/**
 * safeStorage 어댑터.
 *
 * 메인 프로세스는 Electron 의 `safeStorage` 를 넘기고, 테스트는 가짜를 넘긴다.
 * 기본값을 두지 않는 이유: 배선을 잊으면 조용히 평문으로 저장되기 때문이다.
 */
export interface SessionCrypt {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export function isValidSessionName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function partitionFor(name: string): string {
  return name === DEFAULT_SESSION ? DEFAULT_PARTITION : `persist:helm:${name}`;
}

interface SessionRow {
  name: string;
  partition: string;
  login_method: string | null;
  logged_in_at: number | null;
  meta: Buffer | null;
  meta_encrypted: number;
  created_at: number;
  last_used_at: number;
}

function toInfo(row: SessionRow): SessionInfo {
  return {
    name: row.name,
    partition: row.partition,
    loginMethod: (row.login_method as LoginMethod | null) ?? null,
    loggedInAt: row.logged_in_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

export class SessionStore {
  private readonly db: HelmDatabase;
  private readonly crypt: SessionCrypt;
  private current = DEFAULT_SESSION;

  constructor(db: HelmDatabase, crypt: SessionCrypt) {
    this.db = db;
    this.crypt = crypt;
    this.ensure(DEFAULT_SESSION);
  }

  /** 지금 새 탭이 쓸 세션. `session_use` 가 바꾼다. */
  currentName(): string {
    return this.current;
  }

  list(): SessionInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY last_used_at DESC')
      .all() as SessionRow[];
    return rows.map(toInfo);
  }

  get(name: string): SessionInfo | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE name = ?').get(name) as
      | SessionRow
      | undefined;
    return row ? toInfo(row) : null;
  }

  /** 없으면 만든다. 이름이 규칙에 맞지 않으면 null. */
  ensure(name: string): SessionInfo | null {
    if (!isValidSessionName(name)) return null;

    const existing = this.get(name);
    if (existing) return existing;

    const now = Date.now();
    const partition = partitionFor(name);
    this.db
      .prepare(
        `INSERT INTO sessions (name, partition, login_method, logged_in_at, meta, meta_encrypted, created_at, last_used_at)
         VALUES (?, ?, NULL, NULL, NULL, 0, ?, ?)`
      )
      .run(name, partition, now, now);

    return {
      name,
      partition,
      loginMethod: null,
      loggedInAt: null,
      createdAt: now,
      lastUsedAt: now
    };
  }

  /** 이 세션을 현재 세션으로 삼는다. `session_use` 도구와 사이드바가 같은 경로를 쓴다. */
  use(name: string): SessionInfo | null {
    const info = this.ensure(name);
    if (!info) return null;

    this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE name = ?').run(Date.now(), name);
    this.current = name;
    return { ...info, lastUsedAt: Date.now() };
  }

  partitionOf(name: string): string {
    return this.get(name)?.partition ?? partitionFor(name);
  }

  /**
   * 로그인 획득 경로를 기록한다. 비밀번호·토큰은 받지 않는다 —
   * 인자에 그런 값이 들어올 자리를 만들지 않는 것이 가장 확실한 방어다.
   */
  recordLogin(name: string, method: LoginMethod, verifiedHost?: string): SessionInfo | null {
    const info = this.ensure(name);
    if (!info) return null;

    const now = Date.now();
    const meta: SessionMeta = {
      loginMethod: method,
      loggedInAt: now,
      ...(verifiedHost === undefined ? {} : { verifiedHost })
    };

    const plain = JSON.stringify(meta);
    let blob: Buffer;
    let encrypted = 0;

    if (this.crypt.available()) {
      blob = this.crypt.encrypt(plain);
      encrypted = 1;
    } else {
      // 암호화를 쓸 수 없는 환경(리눅스 키링 없음 등). 담긴 값은 경로·시각뿐이지만
      // 평문으로 남았다는 사실을 열에 남겨 이후에 다시 암호화할 수 있게 한다.
      blob = Buffer.from(plain, 'utf-8');
    }

    this.db
      .prepare(
        `UPDATE sessions SET login_method = ?, logged_in_at = ?, meta = ?, meta_encrypted = ?
         WHERE name = ?`
      )
      .run(method, now, blob, encrypted, name);

    return { ...info, loginMethod: method, loggedInAt: now };
  }

  meta(name: string): SessionMeta | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE name = ?').get(name) as
      | SessionRow
      | undefined;
    if (!row?.meta) return null;

    try {
      const plain =
        row.meta_encrypted === 1
          ? this.crypt.decrypt(Buffer.from(row.meta))
          : Buffer.from(row.meta).toString('utf-8');
      return JSON.parse(plain) as SessionMeta;
    } catch (error) {
      console.error(`[SessionStore.meta] 복호화 실패 - 세션: ${name}`, error);
      return null;
    }
  }

  remove(name: string): boolean {
    // 기본 세션은 지울 수 없다 — 지우면 탭이 갈 곳이 없다.
    if (name === DEFAULT_SESSION) return false;
    if (this.current === name) this.current = DEFAULT_SESSION;
    return this.db.prepare('DELETE FROM sessions WHERE name = ?').run(name).changes > 0;
  }
}
