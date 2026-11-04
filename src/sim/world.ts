// Authoritative world simulation. Client sends intents, reads entities + events.
// Runs unchanged on a Node server later.
import { findPath, Tile } from './path';
import { rollAttack, xpToNext, Balance, CombatStats } from '../core/combat';
import { playerStats, monsterStats, ClassDef, MonsterDef } from '../core/stats';

export const TICK_MS = 100;

export interface MapData {
  id: string; width: number; height: number; spawn: Tile;
  rocks: Tile[]; water: Tile[]; monsters: { type: string; count: number }[];
}
export interface Defs { balance: Balance & { respawnMs: { monster: number; player: number } }; classes: Record<string, ClassDef>; monsters: Record<string, MonsterDef> }

export interface Entity {
  id: number; kind: 'player' | 'monster'; type: string; name: string;
  x: number; y: number; px: number; py: number;
  path: Tile[]; facing: 1 | -1; moving: boolean;
  hp: number; maxHp: number; mp: number; maxMp: number; stats: CombatStats;
  speed: number; range: number; attackMs: number;
  target: number | null; nextAttack: number; repathAt: number; lastHurt: number;
  dead: boolean; respawnAt: number;
  // monster
  home?: Tile; idleTicks: number; xpReward: number; boss?: boolean;
  // player
  level: number; xp: number; auto: boolean;
}

export type Intent =
  | { kind: 'move'; id: number; to: Tile }
  | { kind: 'attack'; id: number; target: number }
  | { kind: 'auto'; id: number; on: boolean };

export type GameEvent =
  | { t: 'attack'; from: number; to: number; ranged: boolean }
  | { t: 'dmg'; to: number; amount: number; crit: boolean; miss: boolean }
  | { t: 'die'; id: number }
  | { t: 'respawn'; id: number }
  | { t: 'xp'; id: number; amount: number }
  | { t: 'level'; id: number; level: number };

export class World {
  entities = new Map<number, Entity>();
  events: GameEvent[] = [];
  now = 0;
  private nextId = 1;
  private blocked = new Set<number>();
  private rng: () => number;

  constructor(public map: MapData, private defs: Defs, seed = 1) {
    let s = seed >>> 0;
    this.rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const [x, y] of [...map.rocks, ...map.water]) this.blocked.add(y * 10000 + x);
    for (const m of map.monsters) for (let i = 0; i < m.count; i++) this.spawnMonster(m.type, this.randomFreeTile());
  }

  walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < this.map.width && y < this.map.height && !this.blocked.has(y * 10000 + x);
  isWater(x: number, y: number) { return this.map.water.some(([a, b]) => a === x && b === y); }
  isRock(x: number, y: number) { return this.map.rocks.some(([a, b]) => a === x && b === y); }

  private base(kind: Entity['kind'], type: string, [x, y]: Tile): Entity {
    return {
      id: this.nextId++, kind, type, name: type, x, y, px: x, py: y, path: [], facing: 1, moving: false,
      hp: 1, maxHp: 1, mp: 0, maxMp: 0, stats: undefined as unknown as CombatStats, speed: 1, range: 1, attackMs: 1000,
      target: null, nextAttack: 0, repathAt: 0, lastHurt: -1e9, dead: false, respawnAt: 0,
      idleTicks: 0, xpReward: 0, level: 1, xp: 0, auto: false,
    };
  }

  spawnPlayer(cls: string): Entity {
    const c = this.defs.classes[cls];
    const e = this.base('player', cls, this.map.spawn);
    Object.assign(e, { name: c.name, speed: c.speed, range: c.range, attackMs: c.attackMs });
    this.applyLevel(e, 1);
    this.entities.set(e.id, e);
    return e;
  }

  private spawnMonster(type: string, t: Tile) {
    const m = this.defs.monsters[type];
    const e = this.base('monster', type, t);
    Object.assign(e, {
      name: m.name, speed: m.speed, range: m.range, attackMs: m.attackMs, home: t,
      hp: m.hp, maxHp: m.hp, stats: monsterStats(m), xpReward: m.xp, level: m.level, boss: m.boss,
    });
    this.entities.set(e.id, e);
  }

  private applyLevel(e: Entity, level: number) {
    const p = playerStats(this.defs.classes[e.type], level);
    Object.assign(e, { level, stats: p.stats, maxHp: p.maxHp, hp: p.maxHp, maxMp: p.maxMp, mp: p.maxMp });
  }

  xpNeeded(e: Entity) { return xpToNext(this.defs.balance, e.level); }

  apply(intent: Intent) {
    const e = this.entities.get(intent.id);
    if (!e || e.dead) return;
    if (intent.kind === 'move') { e.target = null; this.pathTo(e, intent.to); }
    else if (intent.kind === 'attack') { const t = this.entities.get(intent.target); if (t && !t.dead) { e.target = t.id; e.repathAt = 0; } }
    else if (intent.kind === 'auto') e.auto = intent.on;
  }

  private pathTo(e: Entity, to: Tile) {
    if (!this.walkable(...to)) return false;
    const p = findPath(this.walkable, [Math.round(e.x), Math.round(e.y)], to);
    if (p) e.path = p;
    return !!p;
  }

  tick() {
    this.now += TICK_MS;
    const dt = TICK_MS / 1000;
    for (const e of this.entities.values()) {
      e.px = e.x; e.py = e.y;
      if (e.dead) { if (this.now >= e.respawnAt) this.respawn(e); continue; }
      if (e.kind === 'monster') this.monsterAi(e);
      else this.playerAi(e);
      this.combat(e);
      // out-of-combat regen for players
      if (e.kind === 'player' && this.now - e.lastHurt > 4000) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.03 * dt);
      this.step(e, dt);
    }
  }

  private dist(a: Entity, b: Entity) { return Math.hypot(a.x - b.x, a.y - b.y); }

  private combat(e: Entity) {
    if (e.target == null) return;
    const t = this.entities.get(e.target);
    if (!t || t.dead) { e.target = null; return; }
    const d = this.dist(e, t);
    if (d <= e.range) {
      e.path = [];
      if (Math.abs((t.x - t.y) - (e.x - e.y)) > 0.05) e.facing = (t.x - t.y) > (e.x - e.y) ? 1 : -1;
      if (this.now >= e.nextAttack) {
        e.nextAttack = this.now + e.attackMs;
        this.events.push({ t: 'attack', from: e.id, to: t.id, ranged: e.range > 2 });
        const r = rollAttack(this.defs.balance, e.stats, t.stats, this.rng);
        this.events.push({ t: 'dmg', to: t.id, amount: r.dmg, crit: r.crit, miss: !r.hit });
        this.hurt(t, r.dmg, e);
      }
    } else if (this.now >= e.repathAt) {
      e.repathAt = this.now + 400;
      this.pathTo(e, [Math.round(t.x), Math.round(t.y)]);
      // stop path one step early so we don't walk onto the target's tile
      if (e.path.length > 1) e.path.pop();
    }
  }

  private hurt(t: Entity, dmg: number, from: Entity) {
    t.lastHurt = this.now;
    if (t.kind === 'monster' && t.target == null) { t.target = from.id; t.nextAttack = this.now + 600; }
    t.hp -= dmg;
    if (t.hp > 0) return;
    t.hp = 0; t.dead = true; t.target = null; t.path = [];
    this.events.push({ t: 'die', id: t.id });
    const rs = this.defs.balance.respawnMs;
    t.respawnAt = this.now + (t.kind === 'monster' ? rs.monster : rs.player);
    for (const o of this.entities.values()) if (o.target === t.id) o.target = null;
    if (t.kind === 'monster' && from.kind === 'player') this.grantXp(from, t.xpReward);
  }

  // Single entry point for XP so catch-up / rested bonuses can hook in later.
  grantXp(p: Entity, amount: number) {
    this.events.push({ t: 'xp', id: p.id, amount });
    p.xp += amount;
    while (p.xp >= this.xpNeeded(p)) {
      p.xp -= this.xpNeeded(p);
      this.applyLevel(p, p.level + 1);
      this.events.push({ t: 'level', id: p.id, level: p.level });
    }
  }

  private respawn(e: Entity) {
    e.dead = false; e.hp = e.maxHp; e.mp = e.maxMp; e.target = null; e.path = [];
    const [x, y] = e.kind === 'player' ? this.map.spawn : this.randomFreeTile();
    if (e.kind === 'monster') e.home = [x, y];
    e.x = e.px = x; e.y = e.py = y;
    this.events.push({ t: 'respawn', id: e.id });
  }

  private playerAi(e: Entity) {
    if (!e.auto || e.target != null || e.path.length) return;
    let best: Entity | null = null, bd = 9;
    for (const o of this.entities.values()) {
      if (o.kind !== 'monster' || o.dead || o.boss || o.level > e.level + 1) continue;
      const d = this.dist(e, o);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { e.target = best.id; e.repathAt = 0; }
  }

  private monsterAi(e: Entity) {
    if (e.target != null) {
      const t = this.entities.get(e.target);
      // give up if the player ran far from home
      if (!t || t.dead || Math.hypot(t.x - e.home![0], t.y - e.home![1]) > 10) { e.target = null; this.pathTo(e, e.home!); }
      return;
    }
    if (!e.path.length && --e.idleTicks <= 0) {
      e.idleTicks = 15 + Math.floor(this.rng() * 40);
      const r = this.defs.monsters[e.type].wanderRadius, [hx, hy] = e.home!;
      this.pathTo(e, [hx + Math.round((this.rng() * 2 - 1) * r), hy + Math.round((this.rng() * 2 - 1) * r)]);
    }
  }

  private step(e: Entity, dt: number) {
    let budget = e.speed * dt;
    e.moving = e.path.length > 0;
    while (budget > 0 && e.path.length) {
      const [tx, ty] = e.path[0];
      const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
      if (Math.abs(dx - dy) > 0.01) e.facing = dx - dy > 0 ? 1 : -1;
      if (d <= budget) { e.x = tx; e.y = ty; e.path.shift(); budget -= d; }
      else { e.x += (dx / d) * budget; e.y += (dy / d) * budget; budget = 0; }
    }
  }

  private randomFreeTile(): Tile {
    for (;;) {
      const t: Tile = [2 + Math.floor(this.rng() * (this.map.width - 4)), 2 + Math.floor(this.rng() * (this.map.height - 4))];
      if (this.walkable(...t) && Math.hypot(t[0] - this.map.spawn[0], t[1] - this.map.spawn[1]) > 5) return t;
    }
  }
}
