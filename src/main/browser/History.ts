import type { HelmDatabase } from '../persistence/Database';
import type { HistoryEntry, HistorySuggestion } from '../../shared/types';

/**
 * 방문 기록. 방문 1회 = 행 1개(크롬의 visits 모델)로 두고,
 * 옴니박스 제안에서만 URL 단위로 집계한다.
 */

/** 기록하지 않는 스킴·주소. 내부 페이지와 빈 탭이 기록을 오염시키지 않게 한다. */
const SKIP_PREFIXES = ['about:', 'devtools:', 'chrome-extension:', 'data:', 'blob:'];

export class History {
  private readonly db: HelmDatabase;

  constructor(db: HelmDatabase) {
    this.db = db;
  }

  /** 기록 대상인지. 검증 실패는 조용히 무시한다(방문마다 호출되므로 로그를 남기지 않는다). */
  private static shouldRecord(url: string): boolean {
    if (url.trim() === '') return false;
    return !SKIP_PREFIXES.some((prefix) => url.startsWith(prefix));
  }

  add(url: string, title: string, visitedAt = Date.now()): void {
    if (!History.shouldRecord(url)) return;

    try {
      this.db
        .prepare('INSERT INTO visits (url, title, visited_at) VALUES (?, ?, ?)')
        .run(url, title, visitedAt);
    } catch (error) {
      console.error(`[History.add] 방문 기록 저장 실패 - url: ${url}`, error);
    }
  }

  /**
   * 마지막 방문의 제목을 갱신한다.
   * 페이지는 이동 직후 제목이 비어 있고 잠시 뒤 채워지므로, 방문 시점에 넣은 빈 제목을 메꾼다.
   */
  updateTitle(url: string, title: string): void {
    if (!History.shouldRecord(url) || title.trim() === '') return;

    try {
      this.db
        .prepare(
          `UPDATE visits SET title = ?
             WHERE id = (SELECT id FROM visits WHERE url = ? ORDER BY visited_at DESC LIMIT 1)`
        )
        .run(title, url);
    } catch (error) {
      console.error(`[History.updateTitle] 제목 갱신 실패 - url: ${url}`, error);
    }
  }

  /** 최근 방문 목록. query 가 있으면 URL·제목 부분 일치로 필터한다. */
  list(query = '', limit = 200): HistoryEntry[] {
    const trimmed = query.trim();

    try {
      if (trimmed === '') {
        return this.db
          .prepare(
            'SELECT id, url, title, visited_at AS visitedAt FROM visits ORDER BY visited_at DESC LIMIT ?'
          )
          .all(limit) as HistoryEntry[];
      }

      const like = `%${escapeLike(trimmed)}%`;
      return this.db
        .prepare(
          `SELECT id, url, title, visited_at AS visitedAt FROM visits
             WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
             ORDER BY visited_at DESC LIMIT ?`
        )
        .all(like, like, limit) as HistoryEntry[];
    } catch (error) {
      console.error(`[History.list] 조회 실패 - query: ${trimmed}`, error);
      return [];
    }
  }

  /** 옴니박스 제안용 — URL 단위로 접고 방문 횟수가 많은 순. */
  suggest(prefix: string, limit = 5): HistorySuggestion[] {
    const trimmed = prefix.trim();
    if (trimmed === '') return [];

    try {
      const like = `%${escapeLike(trimmed)}%`;
      return this.db
        .prepare(
          `SELECT url,
                  MAX(title)          AS title,
                  COUNT(*)            AS visitCount,
                  MAX(visited_at)     AS lastVisitedAt
             FROM visits
            WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
            GROUP BY url
            ORDER BY visitCount DESC, lastVisitedAt DESC
            LIMIT ?`
        )
        .all(like, like, limit) as HistorySuggestion[];
    } catch (error) {
      console.error(`[History.suggest] 제안 조회 실패 - prefix: ${trimmed}`, error);
      return [];
    }
  }

  remove(id: number): void {
    try {
      this.db.prepare('DELETE FROM visits WHERE id = ?').run(id);
    } catch (error) {
      console.error(`[History.remove] 삭제 실패 - id: ${id}`, error);
    }
  }

  clear(): void {
    try {
      this.db.prepare('DELETE FROM visits').run();
    } catch (error) {
      console.error('[History.clear] 전체 삭제 실패', error);
    }
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: number };
    return row.n;
  }

  /** 프로필 가져오기용 일괄 삽입. 한 트랜잭션으로 처리해 수만 건도 빠르게 넣는다. */
  addMany(rows: readonly { url: string; title: string; visitedAt: number }[]): number {
    const insert = this.db.prepare('INSERT INTO visits (url, title, visited_at) VALUES (?, ?, ?)');
    let inserted = 0;

    const run = this.db.transaction((items: readonly typeof rows[number][]) => {
      for (const row of items) {
        if (!History.shouldRecord(row.url)) continue;
        insert.run(row.url, row.title, row.visitedAt);
        inserted += 1;
      }
    });

    run(rows);
    return inserted;
  }
}

/** LIKE 패턴에서 와일드카드를 리터럴로 취급하게 이스케이프한다. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
