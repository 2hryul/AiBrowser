import fs from 'node:fs';
import path from 'node:path';
import type { DownloadItem } from '../../shared/types';
import { registerTool, requireTabId, requireWebContents, TAB_ID_PROPERTY, ToolError, type Tool } from './index';

/**
 * download — 파일 받기.
 *
 * 탭의 webContents 로 내려받는다. 사용자가 링크를 누르는 것과 같은 경로라 출처·쿠키 맥락이
 * 페이지와 일치하고, 커스텀 프로토콜(app://)도 처리된다(M1 에서 확인한 경로).
 *
 * 되돌리기는 파일 삭제 + 목록 제거다. 사람 확인 1회가 필요하므로 M3 에서 UndoManager 가
 * 그 흐름을 붙인다. 여기서는 역연산만 준비해 둔다.
 */

interface Args {
  url: string;
  tabId?: number;
  /** 완료까지 기다리는 최대 시간 */
  timeoutMs?: number;
}

interface Result {
  tabId: number;
  url: string;
  fileName: string;
  savePath: string;
  state: DownloadItem['state'];
  bytes: number;
}

const downloadTool: Tool<Args, Result> = {
  name: 'download',
  description:
    '주어진 주소의 파일을 받아 다운로드 폴더에 저장한다. 완료될 때까지 기다린 뒤 저장 경로와 ' +
    '크기를 돌려준다. 같은 이름이 있으면 " (1)" 이 붙는다.',
  input: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 120000 },
      ...TAB_ID_PROPERTY
    },
    required: ['url'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      url: { type: 'string' },
      fileName: { type: 'string' },
      savePath: { type: 'string' },
      state: { type: 'string' },
      bytes: { type: 'integer' }
    }
  },
  sideEffect: 'write',
  // 파일을 지우는 역연산이 있으므로 되돌릴 수 있다.
  irreversible: false,
  inverse(ctx, _args, result) {
    return {
      tool: 'download',
      describe: `${result.fileName} 삭제`,
      invert: async () => {
        try {
          if (fs.existsSync(result.savePath)) fs.rmSync(result.savePath);
        } catch (error) {
          console.error(`[download.inverse] 파일 삭제 실패 - ${result.savePath}`, error);
        }
        const item = ctx.downloads.list().find((entry) => entry.savePath === result.savePath);
        if (item) ctx.downloads.removeFromList(item.id);
      }
    };
  },
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    const before = new Set(ctx.downloads.list().map((item) => item.id));
    wc.downloadURL(args.url);

    const deadline = Date.now() + (args.timeoutMs ?? 30000);
    let item: DownloadItem | undefined;

    // 새 항목이 나타나고 끝날 때까지 기다린다. 취소·중단도 결과로 돌려준다.
    while (Date.now() < deadline) {
      item = ctx.downloads.list().find((entry) => !before.has(entry.id));
      if (item && item.state !== 'progressing' && item.state !== 'paused') break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    if (!item) {
      throw new ToolError('no_download', `[download] 다운로드가 시작되지 않았습니다: ${args.url}`);
    }

    const bytes = fs.existsSync(item.savePath) ? fs.statSync(item.savePath).size : 0;

    return {
      tabId,
      url: args.url,
      fileName: item.fileName,
      savePath: item.savePath,
      state: item.state,
      bytes
    };
  }
};

interface UploadArgs {
  ref: string;
  /** 다운로드 폴더 기준 상대 경로 또는 절대 경로 */
  filePath: string;
  tabId?: number;
}

/**
 * upload — 파일 선택 입력에 파일을 넣는다.
 *
 * 임의 경로를 열지 않는다. 다운로드 폴더 아래로 제한한다 —
 * AI 가 페이지 지시에 따라 사용자의 아무 파일이나 올리는 경로를 만들지 않기 위함이다.
 */
const uploadTool: Tool<UploadArgs, { tabId: number; ref: string; fileName: string }> = {
  name: 'upload',
  description:
    '파일 선택 입력(input[type=file])에 파일을 설정한다. 경로는 다운로드 폴더 아래로 제한된다 — ' +
    '그 밖의 파일을 올리려면 사람이 직접 선택해야 한다.',
  input: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      filePath: { type: 'string', minLength: 1 },
      ...TAB_ID_PROPERTY
    },
    required: ['ref', 'filePath'],
    additionalProperties: false
  },
  output: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' },
      ref: { type: 'string' },
      fileName: { type: 'string' }
    }
  },
  sideEffect: 'input',
  irreversible: false,
  async run(ctx, args) {
    const tabId = requireTabId(ctx, args.tabId);
    const wc = requireWebContents(ctx, tabId);

    const root = path.resolve(ctx.downloadDir);
    const resolved = path.resolve(root, args.filePath);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

    // 경로 탈출 차단: 정규화 후에도 다운로드 폴더 아래여야 한다.
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new ToolError(
        'path_outside_root',
        `[upload] 다운로드 폴더 밖의 파일은 올릴 수 없습니다: ${args.filePath}`
      );
    }
    if (!fs.existsSync(resolved)) {
      throw new ToolError('no_file', `[upload] 파일이 없습니다: ${resolved}`);
    }

    const { resolveRef } = await import('../cdp/PageReader');
    const { send } = await import('../cdp/Debugger');
    const entry = resolveRef(wc, args.ref);
    if (!entry) throw new ToolError('unknown_ref', `[upload] 알 수 없는 ref: ${args.ref}`);

    await ctx.handoff.duringAction(() =>
      send(wc, 'DOM.setFileInputFiles', {
        files: [resolved],
        backendNodeId: entry.backendNodeId
      })
    );

    return { tabId, ref: args.ref, fileName: path.basename(resolved) };
  }
};

export function registerDownloadTools(): void {
  registerTool(downloadTool);
  registerTool(uploadTool);
}
