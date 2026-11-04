// Per-browser save (single-player phase). Server + SQLite replaces this in Phase 5.
import type { SaveData, InvSlot } from '../sim/world';
const KEY = 'nostaru.save.v1';
export function readSave(): SaveData | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) as SaveData : null; } catch { return null; }
}
export function writeSave(d: SaveData) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage blocked: play without saving */ } }
const STASH_KEY = 'nostaru.stash.v1';
export function readStash(): InvSlot[] { try { return JSON.parse(localStorage.getItem(STASH_KEY) ?? '[]'); } catch { return []; } }
export function writeStash(s: InvSlot[]) { try { localStorage.setItem(STASH_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
const UNLOCK_KEY = 'nostaru.unlocks.v1';
export function readUnlocks(): string[] { try { return JSON.parse(localStorage.getItem(UNLOCK_KEY) ?? '[]'); } catch { return []; } }
export function writeUnlocks(u: string[]) { try { localStorage.setItem(UNLOCK_KEY, JSON.stringify(u)); } catch { /* ignore */ } }
export function clearSave() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
