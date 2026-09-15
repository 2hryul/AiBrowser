import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importPasswordCsv,
  parseCsvLine,
  shredFile,
  type PasswordImportDeps
} from '../src/main/browser/PasswordImport';
import { MemoryCredentialStore, credentialTarget } from '../src/main/sessions/CredentialStore';

/**
 * 비밀번호 임포트 — CSV → 자격증명 관리자 (M4c 성공 조건 3).
 *
 * 여기서 지켜야 하는 것 셋: **값이 로그에 새지 않는다**, **원본 평문이 남지 않는다**,
 * 그리고 **쉼표·따옴표가 든 비밀번호가 조용히 잘리지 않는다**. 세 번째가 특히 고약한데,
 * 잘린 비밀번호는 "저장은 됐는데 로그인만 안 되는" 모양으로 나타나 원인을 찾기 어렵다.
 */

const FIXTURE = path.join(process.cwd(), 'fixtures', 'profiles', 'passwords.csv');

let dir: string;
let credentials: MemoryCredentialStore;
let audited: { what: string; count: number; sourceProfile: string; detail?: string }[];
let deps: PasswordImportDeps;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-pw-'));
  credentials = new MemoryCredentialStore();
  audited = [];
  deps = { credentials, audit: (entry) => audited.push(entry) };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** fixture 를 임시 폴더로 복사한다 — 임포트는 원본을 지우므로 저장소 파일을 직접 쓰면 안 된다. */
function copyFixture(): string {
  const target = path.join(dir, 'passwords.csv');
  fs.copyFileSync(FIXTURE, target);
  return target;
}

describe('CSV 한 줄 가르기', () => {
  it('따옴표 안의 쉼표를 살린다', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('두 번 쓴 따옴표는 따옴표 한 개다', () => {
    expect(parseCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('빈 칸도 자리를 지킨다', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('가져오기', () => {
  it('주소를 읽을 수 있는 3건을 옮기고 나머지는 건너뛴다', async () => {
    const csv = copyFixture();
    const result = await importPasswordCsv(csv, 'chrome/Default', deps);

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.hosts.sort()).toEqual([
      'gw.example.co.kr',
      'itsm.example.co.kr',
      'mail.example.co.kr'
    ]);

    const stored = credentials.list().map((entry) => entry.target).sort();
    expect(stored).toEqual([
      credentialTarget('gw.example.co.kr'),
      credentialTarget('itsm.example.co.kr'),
      credentialTarget('mail.example.co.kr')
    ]);
  });

  it('쉼표·따옴표가 든 비밀번호가 잘리지 않는다', async () => {
    const csv = copyFixture();
    await importPasswordCsv(csv, 'chrome/Default', deps);

    /**
     * 값 자체는 대역이 돌려주지 않는다(일부러 그렇게 만들었다). 대신 길이로 본다 —
     * `gw-pw,with-comma` 는 16자다. 쉼표에서 잘렸다면 5자가 된다.
     */
    const lengths = (credentials as unknown as {
      entries: Map<string, { username: string; length: number }>;
    }).entries;

    expect(lengths.get(credentialTarget('gw.example.co.kr'))?.length).toBe('gw-pw,with-comma'.length);
    expect(lengths.get(credentialTarget('itsm.example.co.kr'))?.length).toBe('itsm "quoted" pw'.length);
  });

  it('원본 CSV 를 0 으로 덮고 지운다', async () => {
    const csv = copyFixture();
    const result = await importPasswordCsv(csv, 'chrome/Default', deps);

    expect(result.sourceRemoved).toBe(true);
    expect(fs.existsSync(csv)).toBe(false);
  });

  it('감사 로그에 건수와 호스트만 남고 값은 없다', async () => {
    const csv = copyFixture();
    await importPasswordCsv(csv, 'chrome/Default', deps);

    expect(audited).toHaveLength(1);
    expect(audited[0]?.what).toBe('passwords');
    expect(audited[0]?.count).toBe(3);
    expect(audited[0]?.sourceProfile).toBe('chrome/Default');

    const blob = JSON.stringify(audited);
    for (const secret of ['gw-pw,with-comma', 'mail-pw-42', 'itsm "quoted" pw', 'orphan-pw']) {
      expect(blob, `감사 로그에 ${secret}`).not.toContain(secret);
    }
  });

  it('머리글을 알아볼 수 없으면 던진다 — 엉뚱한 칸을 비밀번호로 저장하지 않는다', async () => {
    const bad = path.join(dir, 'bad.csv');
    fs.writeFileSync(bad, 'a,b,c\n1,2,3\n', 'utf-8');

    await expect(importPasswordCsv(bad, 'chrome/Default', deps)).rejects.toThrow('머리글');
  });
});

describe('원본 지우기', () => {
  it('내용을 0 으로 덮은 뒤 지운다', () => {
    const file = path.join(dir, 'secret.txt');
    fs.writeFileSync(file, 'super-secret-value', 'utf-8');

    expect(shredFile(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('없는 파일에도 조용히 실패한다 — 임포트 전체를 멈출 일이 아니다', () => {
    expect(shredFile(path.join(dir, '없다.csv'))).toBe(false);
  });
});
