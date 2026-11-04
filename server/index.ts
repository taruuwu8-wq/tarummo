// Nostaru server: one authoritative World per map, 10 ticks/s, WebSocket on /ws, serves dist/.
// Run: npm run build && npm run server   (then open http://localhost:8080)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { World, TICK_MS, Entity, SaveData, Intent, InvSlot } from '../src/sim/world';
import { loadDefs, MAPS, START_MAP } from '../src/data';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SAVES = path.join(ROOT, 'saves');
fs.mkdirSync(SAVES, { recursive: true });

// ---- persistence: one JSON file per player name (enough for 3-5 friends) ----
const safeName = (n: string) => n.trim().replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 16);
const saveFile = (name: string) => path.join(SAVES, `${name}.json`);
function readSave(name: string): SaveData | null {
  try { return JSON.parse(fs.readFileSync(saveFile(name), 'utf8')); } catch { return null; }
}
function writeSave(name: string, d: SaveData) {
  fs.writeFileSync(saveFile(name) + '.tmp', JSON.stringify(d));
  fs.renameSync(saveFile(name) + '.tmp', saveFile(name));
}
function listSaves() {
  const out: Record<string, { cls: string; level: number }> = {};
  for (const f of fs.readdirSync(SAVES)) if (f.endsWith('.json')) {
    const s = readSave(f.slice(0, -5)); if (s) out[f.slice(0, -5)] = { cls: s.cls, level: s.level };
  }
  return out;
}

// ---- shared stash (one for the whole group) ----
const SHARED = path.join(SAVES, '_shared');
fs.mkdirSync(SHARED, { recursive: true });
const STASH_FILE = path.join(SHARED, 'stash.json');
let stash: InvSlot[] = [];
try { stash = JSON.parse(fs.readFileSync(STASH_FILE, 'utf8')); } catch { /* first run */ }
const UNLOCK_FILE = path.join(SHARED, 'unlocks.json');
let unlocks: string[] = [];
try { unlocks = JSON.parse(fs.readFileSync(UNLOCK_FILE, 'utf8')); } catch { /* first run */ }

// ---- rooms ----
const defs = loadDefs();
const rooms = new Map<string, World>();
for (const id of Object.keys(MAPS)) rooms.set(id, new World(structuredClone(MAPS[id]), defs, (Math.random() * 1e9) | 0, { stash, unlocks }));

interface Client { ws: WebSocket; name: string; room: string; id: number }
const clients = new Set<Client>();

const send = (ws: WebSocket, m: ServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

/** save undefined = brand-new character of class `cls` (starter gear). */
function enter(c: Client, room: string, cls: string, save?: SaveData, at?: [number, number], vitals?: { hp: number; mp: number }) {
  const w = rooms.get(room) ?? rooms.get(START_MAP)!;
  c.room = w.map.id;
  const e = w.spawnPlayer(cls, save, at, vitals);
  e.name = c.name;
  c.id = e.id;
  send(c.ws, { t: 'welcome', id: e.id, map: c.room, cls });
}

function playerOf(c: Client): Entity | undefined { return rooms.get(c.room)?.entities.get(c.id); }
function persist(c: Client) { const e = playerOf(c); if (e) writeSave(c.name, rooms.get(c.room)!.save(e)); }

function onMessage(c: Client, m: ClientMsg) {
  if (m.t === 'join') {
    if (c.name) return;
    const name = safeName(m.name);
    if (!name) return send(c.ws, { t: 'error', text: 'ชื่อใช้ไม่ได้' });
    if ([...clients].some(o => o.name === name)) return send(c.ws, { t: 'error', text: 'ชื่อนี้ออนไลน์อยู่แล้ว' });
    if (!defs.classes[m.cls] && !readSave(name)) return send(c.ws, { t: 'error', text: 'อาชีพไม่ถูกต้อง' });
    c.name = name;
    const save = readSave(name) ?? undefined;
    const cls = save?.cls ?? m.cls;
    enter(c, save?.map ?? START_MAP, cls, save);
    persist(c);
    console.log(`+ ${name} (${cls}) joined ${c.room}`);
  } else if (m.t === 'intent' && c.name) {
    const intent = { ...m.intent, id: c.id } as Intent;   // never trust the client's id
    rooms.get(c.room)!.apply(intent);
  }
}

// ---- game loop ----
setInterval(() => {
  for (const [roomId, w] of rooms) {
    w.tick();
    const ev = w.events.splice(0);
    // portals: move the player into the target room
    for (const e of ev) if (e.t === 'portal') {
      const c = [...clients].find(x => x.room === roomId && x.id === e.id);
      const p = w.entities.get(e.id);
      if (!c || !p) continue;
      const save = w.save(p), vitals = { hp: p.hp, mp: p.mp };
      w.removeEntity(p.id);
      save.map = e.to;
      enter(c, e.to, save.cls, save, e.spawn, vitals);
      persist(c);
    }
    const msg = JSON.stringify({ t: 'tick', now: w.now, ents: w.snapshot(), ev: ev.filter(e => e.t !== 'portal'), stash, dungeon: w.dungeon, unlocks } satisfies ServerMsg);
    for (const c of clients) if (c.room === roomId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }
}, TICK_MS);
setInterval(() => {
  for (const c of clients) persist(c);
  if ([...rooms.values()].some(w => w.unlocksDirty)) {
    fs.writeFileSync(UNLOCK_FILE, JSON.stringify(unlocks));
    for (const w of rooms.values()) w.unlocksDirty = false;
  }
  if ([...rooms.values()].some(w => w.stashDirty)) {
    fs.writeFileSync(STASH_FILE, JSON.stringify(stash));
    for (const w of rooms.values()) w.stashDirty = false;
  }
}, 5000);

// ---- http + ws ----
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(500); res.end('dist/ missing: run `npm run build` first'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const c: Client = { ws, name: '', room: START_MAP, id: -1 };
  clients.add(c);
  send(ws, { t: 'hello', saves: listSaves() });
  ws.on('message', raw => { try { onMessage(c, JSON.parse(String(raw))); } catch (err) { console.error(err); } });
  ws.on('close', () => {
    if (c.name) { persist(c); rooms.get(c.room)?.removeEntity(c.id); console.log(`- ${c.name} left`); }
    clients.delete(c);
  });
});
server.listen(PORT, () => {
  console.log(`Nostaru server on http://localhost:${PORT}`);
  for (const ip of Object.values(os.networkInterfaces()).flat()) if (ip && ip.family === 'IPv4' && !ip.internal) console.log(`  same Wi-Fi: http://${ip.address}:${PORT}`);
});
