import fs from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';
import type { ExtensionLoadResult } from '../../shared/types';

/**
 * 사내 확장 로드.
 *
 * 로드 실패는 버그가 아니라 호환성 기록 대상이다(GOAL FIXED DECISIONS).
 * 결과를 그대로 docs/extensions.md 에 적을 수 있는 형태로 돌려준다.
 */

export interface ExtensionEntry {
  name: string;
  path: string;
  required?: boolean;
}

/**
 * Electron 이 지원하지 않는 확장 API.
 * manifest 의 permissions 에 이 값이 있으면 로드는 되더라도 해당 기능이 동작하지 않으므로
 * 미리 경고로 남긴다. 목록은 Electron 공식 문서(Chrome Extension Support)를 따른다.
 */
const UNSUPPORTED_PERMISSIONS = new Set([
  'alarms',
  'bookmarks',
  'browsingData',
  'commands',
  'contextMenus',
  'downloads',
  'history',
  'identity',
  'nativeMessaging',
  'notifications',
  'permissions',
  'privacy',
  'sessions',
  'tabGroups',
  'topSites',
  'webNavigation'
]);

interface Manifest {
  name?: string;
  version?: string;
  manifest_version?: number;
  permissions?: string[];
  optional_permissions?: string[];
}

/** config/extensions.json 을 읽는다. 파일이 없거나 형식이 어긋나면 빈 목록. */
export function loadExtensionConfig(configDir: string): ExtensionEntry[] {
  const file = path.join(configDir, 'extensions.json');

  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(`[loadExtensionConfig] 배열이 아닙니다 - 경로: ${file}`);
      return [];
    }

    return parsed.filter(
      (entry): entry is ExtensionEntry =>
        typeof (entry as ExtensionEntry)?.name === 'string' &&
        typeof (entry as ExtensionEntry)?.path === 'string'
    );
  } catch (error) {
    console.error(`[loadExtensionConfig] 확장 설정 읽기 실패 - 경로: ${file}`, error);
    return [];
  }
}

/** manifest 를 읽어 Electron 이 지원하지 않는 권한을 골라낸다. */
export function findUnsupportedPermissions(extensionDir: string): string[] {
  const manifestPath = path.join(extensionDir, 'manifest.json');

  try {
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
    const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
    return declared.filter((permission) => UNSUPPORTED_PERMISSIONS.has(permission)).sort();
  } catch (error) {
    console.warn(`[findUnsupportedPermissions] manifest 읽기 실패 - 경로: ${manifestPath}`, error);
    return [];
  }
}

export interface LoadedExtension extends ExtensionLoadResult {
  /** Electron 이 지원하지 않는 권한 — docs/extensions.md 에 기록한다. */
  unsupportedPermissions: string[];
}

/**
 * 설정에 등록된 확장을 순서대로 로드한다.
 * 하나가 실패해도 나머지를 계속 시도하고, 결과를 전부 돌려준다.
 */
export async function loadExtensions(
  session: Session,
  entries: readonly ExtensionEntry[]
): Promise<LoadedExtension[]> {
  const results: LoadedExtension[] = [];

  for (const entry of entries) {
    const resolved = path.resolve(entry.path);
    const base: LoadedExtension = {
      name: entry.name,
      path: resolved,
      ok: false,
      manifestName: null,
      version: null,
      error: null,
      unsupportedPermissions: []
    };

    if (!fs.existsSync(path.join(resolved, 'manifest.json'))) {
      results.push({ ...base, error: 'manifest.json 없음 (unpacked 디렉터리 경로인지 확인)' });
      continue;
    }

    base.unsupportedPermissions = findUnsupportedPermissions(resolved);

    try {
      // allowFileAccess 는 켜지 않는다 — 확장이 로컬 파일을 읽을 이유가 없다(최소 권한).
      const loaded = await session.loadExtension(resolved, { allowFileAccess: false });
      results.push({
        ...base,
        ok: true,
        manifestName: loaded.name,
        version: loaded.version
      });
    } catch (error) {
      results.push({ ...base, error: (error as Error).message });
    }
  }

  return results;
}
