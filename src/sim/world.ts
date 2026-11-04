// Authoritative world simulation. Client sends intents, reads entities + events.
// Runs unchanged on a Node server later.
import { findPath, Tile } from './path';
import { rollAttack, xpToNext, Balance, CombatStats, Skill, BASIC, Element } from '../core/combat';
import { playerStats, monsterStats, ClassDef, MonsterDef, ItemDef, Slot } from '../core/stats';

export const TICK_MS = 100;

export interface MapData {
  id: string; width: number; height: number; spawn: Tile;
  rocks: Tile[]; water: Tile[]; monsters: { type: string; count: number }[];
}
export interface SkillDef {
  id: string; name: string; icon: string; mp: number; cooldownMs: number;
  mult?: number; flat?: number; element?: Element; aoe?: number; self?: boolean; hits?: number; heal?: number;
}
export interface Defs {
  balance: Balance & { respawnMs: { monster: number; player: number } };
  classes: Record<string, ClassDef>; monsters: Record<string, MonsterDef>;
  items: Record<string, ItemDef>; skills: Record<string, SkillDef[]>;
}
export interface InvSlot { item: string; qty: number }
export const INV_SIZE = 30;
export const SLOTS: Slot[] = ['weapon', 'armor', 'hat', 'charm'];
export interface SaveData { cls: string; level: number; xp: number; gold: number; inv: InvSlot[]; equip: Partial<Record<Slot, string>>; autoSell: boolean }

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
  gold: number; inv: InvSlot[]; equip: Partial<Record<Slot, string>>; autoSell: boolean;
  cooldowns: Record<string, number>; pendingSkill: string | null;
}

export type Intent =
  | { kind: 'move'; id: number; to: Tile }
  | { kind: 'attack'; id: number; target: number }
  | { kind: 'auto'; id: number; on: boolean }
  | { kind: 'skill'; id: number; skill: string; target?: number }
  | { kind: 'equip'; id: number; index: number }
  | { kind: 'unequip'; id: number; slot: Slot }
  | { kind: 'use'; id: number; index: number }
  | { kind: 'sell'; id: number; index: number }
  | { kind: 'autoSell'; id: number; on: boolean };

export type GameEvent =
  | { t: 'attack'; from: number; to: number; ranged: boolean }
  | { t: 'dmg'; to: number; amount: number; crit: boolean; miss: boolean }
  | { t: 'die'; id: number }
  | { t: 'respawn'; id: number }
  | { t: 'xp'; id: number; amount: number }
  | { t: 'level'; id: number; level: number }
  | { t: 'skill'; from: number; skill: string; x: number; y: number; aoe: number }
  | { t: 'heal'; to: number; amount: number; mp?: boolean }
  | { t: 'loot'; id: number; item: string; qty: number; sold?: boolean }
  | { t: 'gold'; id: number; amount: number }
  | { t: 'msg'; id: number; text: string };

export class World {
  entities = new Map<number, Entity>();
  events: GameEvent[] = [];
  now = 0;
  private nextId = 1;
  private blocked = new Set<number>();
  private rng: () => number;

  constructor(public map: MapData, public defs: Defs, seed = 1) {
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
      gold: 0, inv: [], equip: {}, autoSell: false, cooldowns: {}, pendingSkill: null,
    };
  }

  spawnPlayer(cls: string, save?: SaveData): Entity {
    const c = this.defs.classes[cls];
    const e = this.base('player', cls, this.map.spawn);
    Object.assign(e, { name: c.name, speed: c.speed, range: c.range, attackMs: c.attackMs });
    if (save) Object.assign(e, { xp: save.xp, gold: save.gold, inv: save.inv.filter(s => this.defs.items[s.item]), equip: save.equip, autoSell: save.autoSell });
    else { e.equip = { weapon: c.starterWeapon }; e.inv = [{ item: 'hp_potion', qty: 3 }]; }
    this.applyLevel(e, save?.level ?? 1);
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
    e.level = level;
    this.recalc(e);
    e.hp = e.maxHp; e.mp = e.maxMp;
  }

  /** Recompute stats from level + gear, keeping current HP/MP (clamped). */
  private recalc(e: Entity) {
    const gear = SLOTS.map(s => e.equip[s]).filter((id): id is string => !!id).map(id => this.defs.items[id]);
    const p = playerStats(this.defs.classes[e.type], e.level, gear);
    Object.assign(e, { stats: p.stats, maxHp: p.maxHp, maxMp: p.maxMp });
    e.hp = Math.min(e.hp, e.maxHp); e.mp = Math.min(e.mp, e.maxMp);
  }

  save(e: Entity): SaveData {
    return { cls: e.type, level: e.level, xp: e.xp, gold: e.gold, inv: e.inv, equip: e.equip, autoSell: e.autoSell };
  }

  skillsOf(e: Entity) { return this.defs.skills[e.type] ?? []; }

  /** Single entry point for items (catch-up / shared loot can hook in later). Returns false if bag full. */
  grantItem(p: Entity, item: string, qty = 1): boolean {
    const def = this.defs.items[item];
    if (p.autoSell && def.rarity === 'common' && SLOTS.includes(def.slot as Slot)) {
      p.gold += def.price * qty;
      this.events.push({ t: 'loot', id: p.id, item, qty, sold: true });
      return true;
    }
    const stackable = def.slot === 'use' || def.slot === 'mat';
    const st = stackable ? p.inv.find(s => s.item === item) : undefined;
    if (st) st.qty += qty;
    else if (p.inv.length < INV_SIZE) p.inv.push({ item, qty });
    else { this.events.push({ t: 'msg', id: p.id, text: 'กระเป๋าเต็ม' }); return false; }
    this.events.push({ t: 'loot', id: p.id, item, qty });
    return true;
  }

  private equip(p: Entity, index: number) {
    const st = p.inv[index]; if (!st) return;
    const def = this.defs.items[st.item];
    if (!SLOTS.includes(def.slot as Slot)) return;
    if (def.class && def.class !== p.type) { this.events.push({ t: 'msg', id: p.id, text: `ใช้ได้เฉพาะ ${this.defs.classes[def.class].name}` }); return; }
    if ((def.level ?? 1) > p.level) { this.events.push({ t: 'msg', id: p.id, text: `ต้องการ Lv ${def.level}` }); return; }
    const slot = def.slot as Slot, old = p.equip[slot];
    p.inv.splice(index, 1);
    if (old) p.inv.splice(index, 0, { item: old, qty: 1 });
    p.equip[slot] = st.item;
    this.recalc(p);
  }

  private unequip(p: Entity, slot: Slot) {
    const id = p.equip[slot]; if (!id) return;
    if (p.inv.length >= INV_SIZE) { this.events.push({ t: 'msg', id: p.id, text: 'กระเป๋าเต็ม' }); return; }
    delete p.equip[slot]; p.inv.push({ item: id, qty: 1 });
    this.recalc(p);
  }

  private use(p: Entity, index: number) {
    const st = p.inv[index]; if (!st) return;
    const h = this.defs.items[st.item].heal; if (!h) return;
    if ((p.cooldowns['potion'] ?? 0) > this.now) return;
    p.cooldowns['potion'] = this.now + 1500;
    if (h.hp) { const a = Math.round(p.maxHp * h.hp); p.hp = Math.min(p.maxHp, p.hp + a); this.events.push({ t: 'heal', to: p.id, amount: a }); }
    if (h.mp) { const a = Math.round(p.maxMp * h.mp); p.mp = Math.min(p.maxMp, p.mp + a); this.events.push({ t: 'heal', to: p.id, amount: a, mp: true }); }
    if (--st.qty <= 0) p.inv.splice(index, 1);
  }

  private sell(p: Entity, index: number) {
    const st = p.inv[index]; if (!st) return;
    const g = this.defs.items[st.item].price * st.qty;
    p.gold += g; p.inv.splice(index, 1);
    this.events.push({ t: 'gold', id: p.id, amount: g });
  }


  xpNeeded(e: Entity) { return xpToNext(this.defs.balance, e.level); }

  apply(intent: Intent) {
    const e = this.entities.get(intent.id);
    if (!e || e.dead) return;
    if (intent.kind === 'move') { e.target = null; this.pathTo(e, intent.to); }
    else if (intent.kind === 'attack') { const t = this.entities.get(intent.target); if (t && !t.dead) { e.target = t.id; e.repathAt = 0; } }
    else if (intent.kind === 'auto') e.auto = intent.on;
    else if (intent.kind === 'skill') {
      if (intent.target != null) { const t = this.entities.get(intent.target); if (t && !t.dead && t.kind === 'monster') e.target = t.id; }
      e.pendingSkill = intent.skill; e.repathAt = 0;
    }
    else if (intent.kind === 'equip') this.equip(e, intent.index);
    else if (intent.kind === 'unequip') this.unequip(e, intent.slot);
    else if (intent.kind === 'use') this.use(e, intent.index);
    else if (intent.kind === 'sell') this.sell(e, intent.index);
    else if (intent.kind === 'autoSell') e.autoSell = intent.on;
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
      if (e.kind === 'player') {
        if (this.now - e.lastHurt > 4000) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.03 * dt);
        e.mp = Math.min(e.maxMp, e.mp + e.maxMp * (this.now - e.lastHurt > 4000 ? 0.04 : 0.015) * dt);
      }
      this.step(e, dt);
    }
  }

  private dist(a: Entity, b: Entity) { return Math.hypot(a.x - b.x, a.y - b.y); }

  private combat(e: Entity) {
    // self-cast skills (heal, whirlwind) don't need a target in range
    if (e.pendingSkill) {
      const sk = this.skillsOf(e).find(k => k.id === e.pendingSkill);
      if (!sk || !this.skillReady(e, sk)) e.pendingSkill = null;
      else if (sk.heal || sk.self) { this.castSkill(e, sk, e.target != null ? this.entities.get(e.target) ?? null : null); e.pendingSkill = null; }
      else if (e.target == null) {
        const near = this.nearestMonster(e, e.range + 3, 99);
        if (near) e.target = near.id; else { e.pendingSkill = null; this.events.push({ t: 'msg', id: e.id, text: 'ไม่มีเป้าหมาย' }); }
      }
    }
    if (e.target == null) return;
    const t = this.entities.get(e.target);
    if (!t || t.dead) { e.target = null; return; }
    const d = this.dist(e, t);
    if (d <= e.range) {
      e.path = [];
      if (Math.abs((t.x - t.y) - (e.x - e.y)) > 0.05) e.facing = (t.x - t.y) > (e.x - e.y) ? 1 : -1;
      if (this.now < e.nextAttack) return;
      const sk = e.pendingSkill ? this.skillsOf(e).find(k => k.id === e.pendingSkill) : undefined;
      if (sk) { e.pendingSkill = null; this.castSkill(e, sk, t); return; }
      e.nextAttack = this.now + e.attackMs;
      this.events.push({ t: 'attack', from: e.id, to: t.id, ranged: e.range > 2 });
      this.strike(e, t, BASIC);
    } else if (this.now >= e.repathAt) {
      e.repathAt = this.now + 400;
      this.pathTo(e, [Math.round(t.x), Math.round(t.y)]);
      if (e.path.length > 1) e.path.pop();
    }
  }

  private strike(e: Entity, t: Entity, sk: Skill) {
    const r = rollAttack(this.defs.balance, e.stats, t.stats, this.rng, sk);
    this.events.push({ t: 'dmg', to: t.id, amount: r.dmg, crit: r.crit, miss: !r.hit });
    this.hurt(t, r.dmg, e);
  }

  skillReady(e: Entity, sk: SkillDef) { return (e.cooldowns[sk.id] ?? 0) <= this.now && e.mp >= sk.mp; }

  private castSkill(e: Entity, sk: SkillDef, t: Entity | null) {
    e.mp -= sk.mp;
    e.cooldowns[sk.id] = this.now + sk.cooldownMs;
    e.nextAttack = this.now + e.attackMs;
    if (sk.heal) {
      const a = Math.round(e.maxHp * sk.heal); e.hp = Math.min(e.maxHp, e.hp + a);
      this.events.push({ t: 'skill', from: e.id, skill: sk.id, x: e.x, y: e.y, aoe: 0 });
      this.events.push({ t: 'heal', to: e.id, amount: a });
      return;
    }
    const at = sk.self || !t ? e : t;
    this.events.push({ t: 'skill', from: e.id, skill: sk.id, x: at.x, y: at.y, aoe: sk.aoe ?? 0 });
    if (t) this.events.push({ t: 'attack', from: e.id, to: t.id, ranged: e.range > 2 && !sk.self });
    const cs: Skill = { mult: sk.mult ?? 1, flat: sk.flat ?? 0, element: sk.element };
    const victims = sk.aoe
      ? [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && Math.hypot(o.x - at.x, o.y - at.y) <= sk.aoe!)
      : t ? [t] : [];
    for (const v of victims) for (let i = 0; i < (sk.hits ?? 1) && !v.dead; i++) this.strike(e, v, cs);
  }

  private nearestMonster(e: Entity, maxD: number, maxLevel: number) {
    let best: Entity | null = null, bd = maxD;
    for (const o of this.entities.values()) {
      if (o.kind !== 'monster' || o.dead || o.level > maxLevel) continue;
      const d = this.dist(e, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
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
    if (t.kind === 'monster' && from.kind === 'player') {
      this.grantXp(from, t.xpReward);
      const m = this.defs.monsters[t.type];
      const g = m.gold[0] + Math.floor(this.rng() * (m.gold[1] - m.gold[0] + 1));
      from.gold += g; this.events.push({ t: 'gold', id: from.id, amount: g });
      for (const [item, chance, qty] of m.drops) if (this.rng() < chance) this.grantItem(from, item, qty ?? 1);
    }
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
    if (!e.auto || e.dead) return;
    if (e.hp < e.maxHp * 0.35) { const i = e.inv.findIndex(s => this.defs.items[s.item].heal?.hp); if (i >= 0) this.use(e, i); }
    if (e.mp < e.maxMp * 0.15) { const i = e.inv.findIndex(s => this.defs.items[s.item].heal?.mp); if (i >= 0) this.use(e, i); }
    if (e.target == null && !e.path.length) {
      const m = this.nearestMonster(e, 9, e.level + 1);
      if (m && !m.boss) { e.target = m.id; e.repathAt = 0; }
    }
    // skills in bar order; heal only when hurt; whirlwind only when the target is close
    if (e.target != null && !e.pendingSkill) {
      const t = this.entities.get(e.target);
      for (const sk of this.skillsOf(e)) {
        if (!this.skillReady(e, sk)) continue;
        if (sk.heal && e.hp > e.maxHp * 0.5) continue;
        if (sk.self && sk.aoe && (!t || this.dist(e, t) > sk.aoe)) continue;
        e.pendingSkill = sk.id; break;
      }
    }
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
