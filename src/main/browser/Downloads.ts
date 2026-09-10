import fs from 'node:fs';
import path from 'node:path';
import { shell, type DownloadItem as ElectronDownloadItem, type Session } from 'electron';
import type { DownloadItem, DownloadState } from '../../shared/types';

/**
 * 다운로드 관리자.
 *
 * 크롬 기본 동작에 맞춘다: 저장 위치를 매번 묻지 않고 다운로드 폴더에 바로 저장하고,
 * 같은 이름이 있으면 " (1)" 을 붙인다. 목록은 메모리에만 둔다 —
 * 다운로드 기록의 영구 보존은 M1 요구사항이 아니고, 기록 성격이 달라 별도 테이블이 필요하다.
 */

interface Entry {
  meta: DownloadItem;
  /** 진행 중인 항목만 살아 있다. 완료·취소되면 null. */
  item: ElectronDownloadItem | null;
}

export interface DownloadsOptions {
  /** 기본 저장 디렉터리(app.getPath('downloads')) */
  downloadDir: string;
  onChange: (items: DownloadItem[]) => void;
}

export class Downloads {
  private readonly entries: Entry[] = [];
  private nextId = 1;
  private readonly opts: DownloadsOptions;

  constructor(opts: DownloadsOptions) {
    this.opts = opts;
  }

  /** 세션의 will-download 를 가로챈다. 탭이 쓰는 세션마다 한 번 호출한다. */
  attach(session: Session): void {
    session.on('will-download', (_event, item) => this.track(item));
  }

  private track(item: ElectronDownloadItem): void {
    const id = this.nextId++;
    const fileName = uniqueFileName(this.opts.downloadDir, item.getFilename());
    const savePath = path.join(this.opts.downloadDir, fileName);

    // 저장 경로를 미리 정해 두면 저장 위치 대화상자가 뜨지 않는다(크롬 기본값과 같음).
    item.setSavePath(savePath);

    const entry: Entry = {
      item,
      meta: {
        id,
        fileName,
        savePath,
        url: item.getURL(),
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
        endedAt: null
      }
    };
    this.entries.unshift(entry);

    item.on('updated', (_e, state) => {
      entry.meta.receivedBytes = item.getReceivedBytes();
      entry.meta.totalBytes = item.getTotalBytes();
      entry.meta.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      this.emit();
    });

    item.on('done', (_e, state) => {
      entry.meta.receivedBytes = item.getReceivedBytes();
      entry.meta.totalBytes = item.getTotalBytes() || item.getReceivedBytes();
      entry.meta.state = toDoneState(state);
      entry.meta.endedAt = Date.now();
      entry.item = null;
      this.emit();
    });

    this.emit();
  }

  list(): DownloadItem[] {
    return this.entries.map((entry) => ({ ...entry.meta }));
  }

  cancel(id: number): boolean {
    const entry = this.entries.find((e) => e.meta.id === id);
    if (!entry?.item) return false;
    entry.item.cancel();
    return true;
  }

  pause(id: number): boolean {
    const entry = this.entries.find((e) => e.meta.id === id);
    if (!entry?.item || entry.item.isPaused()) return false;
    entry.item.pause();
    return true;
  }

  resume(id: number): boolean {
    const entry = this.entries.find((e) => e.meta.id === id);
    if (!entry?.item || !entry.item.canResume()) return false;
    entry.item.resume();
    return true;
  }

  /** 탐색기에서 파일 위치 열기. 파일이 없으면 아무것도 하지 않는다. */
  showInFolder(id: number): boolean {
    const entry = this.entries.find((e) => e.meta.id === id);
    if (!entry || !fs.existsSync(entry.meta.savePath)) return false;
    shell.showItemInFolder(entry.meta.savePath);
    return true;
  }

  /** 파일 열기. 성공 여부를 돌려준다. */
  async open(id: number): Promise<boolean> {
    const entry = this.entries.find((e) => e.meta.id === id);
    if (!entry || entry.meta.state !== 'completed' || !fs.existsSync(entry.meta.savePath)) {
      return false;
    }

    const error = await shell.openPath(entry.meta.savePath);
    if (error !== '') {
      console.error(`[Downloads.open] 파일 열기 실패 - 경로: ${entry.meta.savePath} / ${error}`);
      return false;
    }
    return true;
  }

  /** 목록에서만 제거한다. 파일은 지우지 않는다(크롬 동작). */
  removeFromList(id: number): boolean {
    const index = this.entries.findIndex((e) => e.meta.id === id);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    this.emit();
    return true;
  }

  clearCompleted(): void {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i]?.item === null) this.entries.splice(i, 1);
    }
    this.emit();
  }

  private emit(): void {
    this.opts.onChange(this.list());
  }
}

function toDoneState(state: 'completed' | 'cancelled' | 'interrupted'): DownloadState {
  return state;
}

/** 같은 이름이 있으면 "파일 (1).pdf" 처럼 번호를 붙인다. */
export function uniqueFileName(dir: string, fileName: string): string {
  const safe = fileName.trim() === '' ? 'download' : path.basename(fileName);
  if (!fs.existsSync(path.join(dir, safe))) return safe;

  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);

  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }

  return `${stem} (${Date.now()})${ext}`;
}
