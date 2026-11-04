// Per-browser save (single-player phase). Server + SQLite replaces this in Phase 5.
import type { SaveData } from '../sim/world';
const KEY = 'nostaru.save.v1';
export function readSave(): SaveData | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) as SaveData : null; } catch { return null; }
}
export function writeSave(d: SaveData) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage blocked: play without saving */ } }
export function clearSave() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
