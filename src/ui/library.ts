import { sanitizePatch } from '../engine/patch';
import type { Patch } from '../engine/types';

const KEY = 'mouthpiece.library.v1';

export interface LibraryItem {
  id: string;
  savedAt: number;
  patch: Patch;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadLibrary(): LibraryItem[] {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is LibraryItem => !!x && typeof x === 'object' && 'patch' in x && 'id' in x)
      .map((x) => ({ id: String(x.id), savedAt: Number(x.savedAt) || Date.now(), patch: sanitizePatch(x.patch) }));
  } catch {
    return [];
  }
}

/** Returns false if storage is unavailable (private mode, quota, blocked). */
export function saveLibrary(items: LibraryItem[]): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
