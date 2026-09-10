import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findUnsupportedPermissions,
  loadExtensionConfig
} from '../src/main/browser/Extensions';

/**
 * 확장 설정·manifest 해석의 단위 테스트.
 * 실제 session.loadExtension 은 Electron 런타임이 필요하므로 스모크에서 검증한다.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const EXTENSIONS = path.join(REPO, 'fixtures', 'extensions');

describe('확장 설정 읽기', () => {
  it('저장소의 config/extensions.json 은 기본이 빈 배열이다', () => {
    expect(loadExtensionConfig(path.join(REPO, 'config'))).toEqual([]);
  });

  it('파일이 없으면 빈 목록', () => {
    expect(loadExtensionConfig(path.join(os.tmpdir(), 'helm-no-config'))).toEqual([]);
  });

  it('name·path 가 없는 항목은 걸러낸다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ext-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'extensions.json'),
        JSON.stringify([
          { name: '정상', path: 'C:/ext/a' },
          { name: '경로없음' },
          { path: 'C:/ext/c' },
          '문자열'
        ])
      );
      const entries = loadExtensionConfig(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('정상');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('배열이 아니면 빈 목록', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ext-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'extensions.json'), '{"a":1}');
      expect(loadExtensionConfig(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('미지원 확장 API 판별', () => {
  it('지원되는 권한만 쓰는 확장은 경고가 없다', () => {
    expect(findUnsupportedPermissions(path.join(EXTENSIONS, 'helm-devtest'))).toEqual([]);
  });

  it('Electron 이 지원하지 않는 권한을 골라낸다', () => {
    expect(findUnsupportedPermissions(path.join(EXTENSIONS, 'helm-unsupported'))).toEqual([
      'bookmarks',
      'history',
      'notifications'
    ]);
  });

  it('manifest 가 없으면 빈 목록', () => {
    expect(findUnsupportedPermissions(path.join(os.tmpdir(), 'helm-no-ext'))).toEqual([]);
  });
});
