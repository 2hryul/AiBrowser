import fs from 'node:fs';
import readline from 'node:readline';
import { credentialTarget, type CredentialStore } from '../sessions/CredentialStore';

/**
 * 저장된 비밀번호 임포트 — **Chrome 내보내기 CSV** 경로.
 *
 * ## 왜 CSV 인가 (DPAPI 가 아니라)
 *
 * 프로젝트 규칙이 그렇게 정해 두었다. `no-credential-files` lint 는 `Login Data` 를
 * 비밀번호 임포트 경로에서만 열어 주는데(GOAL-M4c FIXED DECISIONS), 그 예외는
 * **복호화 관용구를 덮지 않는다** — `DPAPI`·`CryptUnprotectData`·`os_crypt` 는 그대로 금지다.
 * 그래서 프로필 DB 를 직접 복호화하는 길은 이 규칙 아래에서 쓸 수 없다.
 *
 * 대신 사용자가 Chrome 에서 직접 내보낸 CSV 를 받는다. 우회가 아니라 **더 정직한 경로**이기도
 * 하다: 무엇을 넘기는지 사용자가 Chrome 의 화면에서 보고 결정한다.
 *
 * ## 평문이 지나가는 길
 *
 * 한 줄씩 읽어 **한 건씩** 자격증명 관리자로 넘긴다. 전체를 메모리에 모으지 않고, 어디에도
 * 쓰지 않는다(CONSTRAINTS: 평문을 디스크에 쓰지 않는다). 끝나면 원본 CSV 를 0 으로 덮고
 * 지운다 — 사용자의 다운로드 폴더에 평문 비밀번호 파일이 남는 것이 이 기능의 가장 큰 위험이다.
 *
 * 감사 로그에는 **건수와 호스트만** 남는다. 값은 물론이고 사용자 이름도 마스킹 대상이다.
 */

export interface PasswordRow {
  url: string;
  username: string;
  /** 이 값은 절대 로그·결과에 담기지 않는다 */
  password: string;
}

export interface PasswordImportResult {
  /** 자격증명 관리자에 옮긴 건수 */
  imported: number;
  /** 주소를 읽을 수 없어 건너뛴 건수 */
  skipped: number;
  /** 어느 호스트로 갔는가 — 사용자 확인용. 사용자 이름·비밀번호는 없다 */
  hosts: string[];
  /** 원본 CSV 를 지웠는가 */
  sourceRemoved: boolean;
}

/**
 * CSV 한 줄 → 칸들.
 *
 * 따옴표 안의 쉼표를 살려야 한다 — 비밀번호에 쉼표가 들어 있으면 그 줄 전체가 어긋나고,
 * 조용히 잘린 비밀번호가 저장된다. 그건 "저장했는데 로그인 안 됨" 으로 나타나 원인을 찾기 어렵다.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];

    if (quoted) {
      if (ch === '"') {
        // `""` 는 따옴표 한 개다.
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }

  cells.push(cell);
  return cells;
}

/** 주소에서 호스트. 읽을 수 없으면 빈 문자열 — 그런 줄은 건너뛴다. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface PasswordImportDeps {
  credentials: CredentialStore;
  /** `{what, count, sourceProfile, ts}` — 값은 넘기지 않는다 */
  audit: (entry: { what: string; count: number; sourceProfile: string; detail?: string }) => void;
}

/**
 * CSV 를 읽어 자격증명 관리자로 옮긴다.
 *
 * @param csvPath 사용자가 Chrome 에서 내보낸 파일
 * @param sourceProfile 감사 로그에 남길 출처 이름
 */
export async function importPasswordCsv(
  csvPath: string,
  sourceProfile: string,
  deps: PasswordImportDeps
): Promise<PasswordImportResult> {
  const hosts: string[] = [];
  let imported = 0;
  let skipped = 0;
  let header: string[] | null = null;

  const stream = fs.createReadStream(csvPath, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;

      const cells = parseCsvLine(line);

      if (header === null) {
        header = cells.map((cell) => cell.trim().toLowerCase());
        continue;
      }

      const urlIndex = header.indexOf('url');
      const userIndex = header.indexOf('username');
      const passIndex = header.indexOf('password');

      if (urlIndex < 0 || userIndex < 0 || passIndex < 0) {
        throw new Error(
          `[importPasswordCsv] CSV 머리글을 알아볼 수 없습니다 - 경로: ${csvPath} (url·username·password 가 필요합니다)`
        );
      }

      const url = cells[urlIndex] ?? '';
      const username = cells[userIndex] ?? '';
      const password = cells[passIndex] ?? '';
      const host = hostOf(url);

      if (host === '' || password === '') {
        skipped += 1;
        continue;
      }

      // 한 건씩 넘긴다. 모아 두지 않는 것이 요점이다.
      await deps.credentials.write(credentialTarget(host), username, password);

      imported += 1;
      if (!hosts.includes(host)) hosts.push(host);
    }
  } finally {
    lines.close();
    stream.close();
  }

  const sourceRemoved = shredFile(csvPath);

  deps.audit({
    what: 'passwords',
    count: imported,
    sourceProfile,
    detail: `hosts=${hosts.join(',')} skipped=${skipped} sourceRemoved=${sourceRemoved}`
  });

  return { imported, skipped, hosts, sourceRemoved };
}

/**
 * 원본 CSV 를 0 으로 덮고 지운다.
 *
 * 그냥 `unlink` 만 하면 내용은 디스크에 남고 복구 도구로 읽힌다. SSD 의 wear leveling 때문에
 * 덮어쓰기가 원본 블록을 지운다는 보장은 없지만, 하지 않는 것보다는 낫고 파일 시스템 수준에서
 * 다시 읽히는 흔한 경로는 막는다.
 */
export function shredFile(filePath: string): boolean {
  try {
    const size = fs.statSync(filePath).size;

    if (size > 0) {
      const handle = fs.openSync(filePath, 'r+');
      try {
        fs.writeSync(handle, Buffer.alloc(size, 0), 0, size, 0);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }

    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    console.error(`[shredFile] 원본 삭제 실패 - 경로: ${filePath}`, error);
    return false;
  }
}
