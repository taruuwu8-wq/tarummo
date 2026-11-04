// Authoritative world simulation. Client sends intents, reads entities + events.
// Runs unchanged on a Node server later.
import { findPath, Tile } from './path';
import { rollAttack, xpToNext, Balance, CombatStats, Skill, BASIC, Element, AttackType } from '../core/combat';
import { playerStats, monsterStats, ClassDef, MonsterDef, ItemDef, Slot, Worn, Bonus } from '../core/stats';

export const TICK_MS = 100;

export interface Portal { x: number; y: number; to: string; spawn: Tile; label: string; when?: 'cleared' }
export interface DungeonDef {
  doors: { room: number; tiles: Tile[] }[];
  rooms: { area: [number, number, number, number]; monsters: [string, number][] }[];
  aggro: number; hpScale: number[]; rankSec: { S: number; A: number };
  rewards: Record<'S' | 'A' | 'B', { gold: [number, number]; items: [string, number][]; cardChance: number }>;
}
export interface DungeonState { active: boolean; startedAt: number; room: number; openDoors: number[]; cleared: boolean; rank: 'S' | 'A' | 'B' | null; timeMs: number }
export interface MapData {
  id: string; name: string; ground: 'grass' | 'stone' | 'ruin'; safe: boolean; width: number; height: number; spawn: Tile;
  rocks: Tile[]; water: Tile[]; trees: Tile[]; walls?: Tile[]; monsters: { type: string; count: number }[];
  portals: Portal[]; npcs: { id: string; x: number; y: number }[]; dungeon?: DungeonDef;
}
export interface NpcDef {
  name: string; title: string; sprite: string; height: number; role: 'shop' | 'smith' | 'healer' | 'stash' | 'debug'; greet: string;
  sells?: { item: string; price: number }[];
}
export interface SkillDef {
  id: string; name: string; icon: string; mp: number; cooldownMs: number;
  mult?: number; flat?: number; element?: Element; aoe?: number; self?: boolean; hits?: number; heal?: number;
  /** class skills: character level; card skills: card (job) level */
  unlock: number; offhand?: boolean; range?: number;
}
export interface PassiveDef { id: string; name: string; icon: string; unlock: number; desc: string; type: 'stat' | 'lifesteal' | 'lowhp'; bonus?: Bonus; pct?: number; threshold?: number; reduce?: number }
/** hotbar entry: 's:<skillId>' or 'i:<itemId>' */
export type BarRef = string | null;
export const BAR_SIZE = 10;
/** Renamed ids: old saves are migrated on load. */
const RENAMED: Record<string, string> = { glass_orb: 'spell_gun', star_orb: 'arcane_pistol', orb_bolt: 'arcane_shot', orb_frost: 'frost_bullet' };
const FORM_CD_MS = 10000, COMBAT_MS = 5000;

export type LootAct = 'keep' | 'sell' | 'drop';
export interface AutoCfg {
  range: number;            // tiles around the anchor (where Auto was switched on)
  skip: string[];           // monster types Auto ignores
  bosses: boolean; levelAbove: number;
  hp: number; mp: number;   // potion thresholds in %, 0 = off
  loot: { gear: Record<'common' | 'uncommon' | 'rare' | 'epic', LootAct>; use: LootAct; mat: LootAct };
  skipSkills: string[];
  returnTown: boolean; buyHp: number; buyMp: number;
}
export const defaultAutoCfg = (): AutoCfg => ({
  range: 8, skip: [], bosses: false, levelAbove: 1, hp: 35, mp: 15,
  loot: { gear: { common: 'sell', uncommon: 'keep', rare: 'keep', epic: 'keep' }, use: 'keep', mat: 'keep' },
  skipSkills: [], returnTown: true, buyHp: 20, buyMp: 10,
});
export interface AutoTrip { phase: 'toTown' | 'shop' | 'back'; home: string; spot: Tile }
export interface AutoStats { since: number; xp: number; gold: number; kills: number; items: Record<string, number> }
const GEAR_SLOTS = ['weapon', 'offhand', 'armor', 'hat', 'charm'];
export interface Defs {
  balance: Balance & { respawnMs: { monster: number; player: number } };
  classes: Record<string, ClassDef>; monsters: Record<string, MonsterDef>;
  items: Record<string, ItemDef>; skills: Record<string, SkillDef[]>;
  cards: Record<string, CardDef>; upgrade: UpgradeCfg; npcs: Record<string, NpcDef>;
}
export interface CardDef {
  name: string; class: string; role: string; sprite: string; height: number; icon: string; rarity: ItemDef['rarity'];
  aura: string; element?: Element; bonus: Bonus; skills: SkillDef[]; passives: PassiveDef[];
  usesOffhand?: boolean; attackType?: AttackType; range?: number;
}
export interface UpgradeCfg {
  slots: Slot[]; successRate: number[]; gold: number[]; material: string[]; materialQty: number[]; maxUp: number;
  cardXpPerLevel: number; cardMaxLevel: number; giftCardAtLevel: number;
  card: { successRate: number[]; gold: number[]; material: string[]; materialQty: number[]; perUp: Bonus; maxUp: number };
  glowTiers: { min: number; color: string; rate: number }[];
  wingTiers: { min: number; size: number; color: string; sprite: string | null; glow?: boolean }[];
}
/** up = upgrade level (gear), lv/xp = card level */
export interface InvSlot { item: string; qty: number; up?: number; lv?: number; xp?: number }
export const INV_SIZE = 30;
export const STASH_SIZE = 60;
/** Players within this many tiles of a kill share its XP, gold and (own) drop rolls. */
export const SHARE_RANGE = 12;
export const SLOTS: Slot[] = ['weapon', 'offhand', 'armor', 'hat', 'charm', 'card', 'mount'];
export interface SaveData { autoStats?: AutoStats & { elapsed?: number }; autoOn?: boolean; autoCfg?: AutoCfg; autoAnchor?: Tile | null; autoTrip?: AutoTrip | null; bars?: Record<string, BarRef[]>; barKnown?: Record<string, string[]>; transformed?: boolean; mounted?: boolean; map?: string; cls: string; level: number; xp: number; gold: number; inv: InvSlot[]; equip: Partial<Record<Slot, InvSlot | string>>; autoSell: boolean }

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
  gold: number; inv: InvSlot[]; equip: Partial<Record<Slot, InvSlot>>; autoSell: boolean; transformed: boolean;
  cooldowns: Record<string, number>; pendingSkill: string | null; talkTo: string | null;
  lastHit: number;
  autoCfg: AutoCfg; autoAnchor: Tile | null; autoTrip: AutoTrip | null; autoStats: AutoStats;
  mounted: boolean; aggro: number; noRespawn: boolean; nextBlast: number; room?: number;
  bars: Record<string, BarRef[]>; barKnown: Record<string, string[]>;
  passive: { lifesteal: number; lowhp?: { threshold: number; reduce: number } };
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
  | { kind: 'autoSell'; id: number; on: boolean }
  | { kind: 'transform'; id: number }
  | { kind: 'upgrade'; id: number; ref: number | Slot }
  | { kind: 'talk'; id: number; npc: string }
  | { kind: 'buy'; id: number; index: number; qty: number }
  | { kind: 'heal'; id: number }
  | { kind: 'chat'; id: number; text: string }
  | { kind: 'stashPut'; id: number; index: number }
  | { kind: 'stashTake'; id: number; index: number }
  | { kind: 'debug'; id: number; what: 'level' | 'level5' | 'gold' | 'mats' | 'card' | 'job' }
  | { kind: 'mount'; id: number }
  | { kind: 'setBar'; id: number; slot: number; ref: BarRef }
  | { kind: 'switchCard'; id: number; index: number }
  | { kind: 'autoCfg'; id: number; cfg: AutoCfg };

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
  | { t: 'msg'; id: number; text: string }
  | { t: 'transform'; id: number; on: boolean }
  | { t: 'upgrade'; id: number; item: string; ok: boolean; up: number }
  | { t: 'cardLevel'; id: number; card: string; lv: number }
  | { t: 'portal'; id: number; to: string; spawn: Tile }
  | { t: 'talk'; id: number; npc: string }
  | { t: 'chat'; id: number; name: string; text: string }
  | { t: 'telegraph'; x: number; y: number; r: number; ms: number }
  | { t: 'dungeon'; state: 'start' | 'door' | 'clear' | 'reset'; rank?: 'S' | 'A' | 'B'; timeMs?: number };

export class World {
  entities = new Map<number, Entity>();
  events: GameEvent[] = [];
  now = 0;
  private nextId = 1;
  private blocked = new Set<number>();
  private rng: () => number;

  /** Shared across rooms (and players). Server persists it; offline it lives in localStorage. */
  stash: InvSlot[];
  stashDirty = false;
  dungeon: DungeonState = { active: false, startedAt: 0, room: 0, openDoors: [], cleared: false, rank: null, timeMs: 0 };
  private blasts: { x: number; y: number; r: number; at: number; from: number; mult: number }[] = [];

  /** mirror: client-side copy fed by server snapshots; no monsters are spawned and tick() is not called. */
  constructor(public map: MapData, public defs: Defs, seed = 1, opts: { mirror?: boolean; stash?: InvSlot[] } = {}) {
    this.stash = opts.stash ?? [];
    let s = seed >>> 0;
    this.rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const [x, y] of [...map.rocks, ...map.water, ...map.trees, ...(map.walls ?? []), ...map.npcs.map(n => [n.x, n.y] as Tile)]) this.blocked.add(y * 10000 + x);
    for (const d of map.dungeon?.doors ?? []) for (const [x, y] of d.tiles) this.blocked.add(y * 10000 + x);
    // cards live in the item table too, so the bag/equip code handles them uniformly
    for (const [id, c] of Object.entries(defs.cards)) if (!id.startsWith('_'))
      defs.items[id] = { name: c.name, slot: 'card', rarity: c.rarity, icon: c.icon, class: c.class, price: 100, element: c.element, bonus: c.bonus };
    delete (defs.cards as Record<string, unknown>)['_note'];
    if (!opts.mirror) for (const m of map.monsters) for (let i = 0; i < m.count; i++) this.spawnMonster(m.type, this.randomFreeTile());
  }

  walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < this.map.width && y < this.map.height && !this.blocked.has(y * 10000 + x);
  isWater(x: number, y: number) { return this.map.water.some(([a, b]) => a === x && b === y); }
  isRock(x: number, y: number) { return this.map.rocks.some(([a, b]) => a === x && b === y); }
  isTree(x: number, y: number) { return this.map.trees.some(([a, b]) => a === x && b === y); }
  isWall(x: number, y: number) { return (this.map.walls ?? []).some(([a, b]) => a === x && b === y); }

  private nearNpc(e: Entity, role: NpcDef['role']) {
    return this.map.npcs.some(n => this.defs.npcs[n.id].role === role && Math.hypot(n.x - e.x, n.y - e.y) <= 3);
  }

  private buy(p: Entity, index: number, qty: number) {
    const n = this.map.npcs.find(n => this.defs.npcs[n.id].role === 'shop');
    const offer = n && this.defs.npcs[n.id].sells?.[index];
    if (!n || !offer || !this.nearNpc(p, 'shop')) return;
    qty = Math.max(1, Math.min(99, Math.floor(qty)));
    if (p.gold < offer.price * qty) { this.events.push({ t: 'msg', id: p.id, text: 'ทองไม่พอ' }); return; }
    const d = this.defs.items[offer.item], stack = d.slot === 'use' || d.slot === 'mat';
    if (!stack && qty > 1) qty = 1;
    const saved = p.autoSell; p.autoSell = false;   // never auto-sell what you just bought
    if (this.grantItem(p, offer.item, qty, { filter: false })) p.gold -= offer.price * qty;
    p.autoSell = saved;
  }

  removeEntity(id: number) {
    this.entities.delete(id);
    for (const o of this.entities.values()) if (o.target === id) o.target = null;
  }

  /** Network snapshot: everything the client needs to render + run the HUD. */
  snapshot() {
    const out: Partial<Entity>[] = [];
    for (const e of this.entities.values()) {
      const { path: _p, px: _a, py: _b, ...rest } = e;
      out.push(e.kind === 'monster' ? { ...rest, stats: undefined } : rest);
    }
    return out;
  }

  /** Apply a snapshot to a mirror world. Keeps object identity so HUD references stay valid. */
  applySnapshot(now: number, ents: Partial<Entity>[]) {
    this.now = now;
    const seen = new Set<number>();
    for (const d of ents) {
      seen.add(d.id!);
      const e = this.entities.get(d.id!);
      if (e) { e.px = e.x; e.py = e.y; Object.assign(e, d); }
      else this.entities.set(d.id!, { ...(d as Entity), px: d.x!, py: d.y!, path: [] });
    }
    for (const id of [...this.entities.keys()]) if (!seen.has(id)) this.entities.delete(id);
  }

  private base(kind: Entity['kind'], type: string, [x, y]: Tile): Entity {
    return {
      id: this.nextId++, kind, type, name: type, x, y, px: x, py: y, path: [], facing: 1, moving: false,
      hp: 1, maxHp: 1, mp: 0, maxMp: 0, stats: undefined as unknown as CombatStats, speed: 1, range: 1, attackMs: 1000,
      target: null, nextAttack: 0, repathAt: 0, lastHurt: -1e9, dead: false, respawnAt: 0,
      idleTicks: 0, xpReward: 0, level: 1, xp: 0, auto: false,
      gold: 0, inv: [], equip: {}, autoSell: false, transformed: false, cooldowns: {}, pendingSkill: null, talkTo: null, lastHit: -1e9, autoCfg: defaultAutoCfg(), autoAnchor: null, autoTrip: null, autoStats: { since: 0, xp: 0, gold: 0, kills: 0, items: {} }, mounted: false, aggro: 0, noRespawn: false, nextBlast: 0, bars: {}, barKnown: {}, passive: { lifesteal: 0 },
    };
  }

  spawnPlayer(cls: string, save?: SaveData, at?: Tile, vitals?: { hp: number; mp: number }): Entity {
    const c = this.defs.classes[cls];
    const e = this.base('player', cls, at ?? this.map.spawn);
    Object.assign(e, { name: c.name, speed: c.speed, range: c.range, attackMs: c.attackMs });
    if (save) {
      save = JSON.parse(JSON.stringify(save).replace(/"(i:|s:)?(glass_orb|star_orb|orb_bolt|orb_frost)"/g, (_, pre, id) => `"${pre ?? ''}${RENAMED[id]}"`)) as SaveData;
      const equip: Partial<Record<Slot, InvSlot>> = {};
      for (const [k, v] of Object.entries(save.equip)) if (v) equip[k as Slot] = typeof v === 'string' ? { item: v, qty: 1, up: 0 } : v;  // v1 saves stored ids
      Object.assign(e, { xp: save.xp, gold: save.gold, inv: save.inv.filter(s => this.defs.items[s.item]), equip, autoSell: save.autoSell, bars: save.bars ?? {}, barKnown: save.barKnown ?? {} });
      const cfg = { ...defaultAutoCfg(), ...(save.autoCfg ?? {}) };
      if (!save.autoCfg && save.autoSell) cfg.loot.gear.common = 'sell';
      Object.assign(e, { autoCfg: cfg, auto: !!save.autoOn, autoAnchor: save.autoAnchor ?? null, autoTrip: save.autoTrip ?? null });
      if (e.auto) e.autoStats = save.autoStats ? { ...save.autoStats, since: this.now - (save.autoStats.elapsed ?? 0) } : { since: this.now, xp: 0, gold: 0, kills: 0, items: {} };
      if (!e.equip.offhand && !e.inv.some(s => s.item === c.starterOffhand)) e.equip.offhand = { item: c.starterOffhand, qty: 1, up: 0 };  // older saves
    } else { e.equip = { weapon: { item: c.starterWeapon, qty: 1, up: 0 }, offhand: { item: c.starterOffhand, qty: 1, up: 0 } }; e.inv = [{ item: 'hp_potion', qty: 3 }]; }
    this.applyLevel(e, save?.level ?? 1);
    if (save?.transformed && e.equip.card) { e.transformed = true; this.recalc(e); e.hp = e.maxHp; e.mp = e.maxMp; }
    if (save?.mounted && e.equip.mount) e.mounted = true;
    if (vitals) { e.hp = Math.max(1, Math.min(e.maxHp, vitals.hp)); e.mp = Math.min(e.maxMp, vitals.mp); }
    this.ensureBar(e);
    this.entities.set(e.id, e);
    return e;
  }

  private spawnMonster(type: string, t: Tile): Entity {
    const m = this.defs.monsters[type];
    const e = this.base('monster', type, t);
    Object.assign(e, {
      name: m.name, speed: m.speed, range: m.range, attackMs: m.attackMs, home: t,
      hp: m.hp, maxHp: m.hp, stats: monsterStats(m), xpReward: m.xp, level: m.level, boss: m.boss,
    });
    this.entities.set(e.id, e);
    return e;
  }

  private applyLevel(e: Entity, level: number) {
    e.level = level;
    this.recalc(e);
    e.hp = e.maxHp; e.mp = e.maxMp;
  }

  /** Recompute stats from level + gear, keeping current HP/MP (clamped). */
  private recalc(e: Entity) {
    const gear: Worn[] = [];
    for (const s of SLOTS) {
      const st = e.equip[s]; if (!st) continue;
      if (s === 'card') {
        if (!e.transformed) continue;
        const k = 1 + 0.1 * ((st.lv ?? 1) - 1), b: Bonus = {};
        for (const [key, v] of Object.entries(this.defs.items[st.item].bonus ?? {})) b[key as keyof Bonus] = v * k;
        for (const [key, v] of Object.entries(this.defs.upgrade.card.perUp)) b[key as keyof Bonus] = (b[key as keyof Bonus] ?? 0) + v * (st.up ?? 0);
        gear.push({ def: { ...this.defs.items[st.item], bonus: b }, up: 0 });
      } else gear.push({ def: this.defs.items[st.item], up: st.up ?? 0 });
    }
    // card passives: stat ones join the gear sum, the others become flags
    const card = e.transformed && e.equip.card ? this.defs.cards[e.equip.card.item] : undefined;
    e.passive = { lifesteal: 0 };
    for (const ps of card ? this.unlockedPassives(e) : []) {
      if (ps.type === 'stat') gear.push({ def: { name: ps.name, slot: 'charm', rarity: 'common', icon: '', price: 0, bonus: ps.bonus }, up: 0 });
      else if (ps.type === 'lifesteal') e.passive.lifesteal += ps.pct ?? 0;
      else if (ps.type === 'lowhp') e.passive.lowhp = { threshold: ps.threshold ?? 0.3, reduce: ps.reduce ?? 0.2 };
    }
    const cls = this.defs.classes[e.type];
    const p = playerStats(cls, e.level, gear);
    if (card?.usesOffhand && p.stats.offhand) [p.stats.weapon, p.stats.offhand] = [p.stats.offhand, p.stats.weapon];
    p.stats.attackType = card?.attackType ?? cls.attackType;
    e.range = card?.range ?? cls.range;
    Object.assign(e, { stats: p.stats, maxHp: p.maxHp, maxMp: p.maxMp });
    e.hp = Math.min(e.hp, e.maxHp); e.mp = Math.min(e.mp, e.maxMp);
  }

  save(e: Entity): SaveData {
    return { autoStats: { ...e.autoStats, elapsed: this.now - e.autoStats.since }, autoOn: e.auto, autoCfg: e.autoCfg, autoAnchor: e.autoAnchor, autoTrip: e.autoTrip, bars: e.bars, barKnown: e.barKnown, transformed: e.transformed, mounted: e.mounted, map: this.map.id, cls: e.type, level: e.level, xp: e.xp, gold: e.gold, inv: e.inv, equip: e.equip, autoSell: e.autoSell };
  }

  /** 'base' or the active card id; each form keeps its own hotbar */
  formOf(e: Entity) { return e.transformed && e.equip.card ? e.equip.card.item : 'base'; }

  /** All active skills of the current form, unlocked or not (for the skills window). */
  allSkillsOf(e: Entity): SkillDef[] {
    const card = e.transformed ? e.equip.card : undefined;
    return card ? this.defs.cards[card.item].skills : this.defs.skills[e.type] ?? [];
  }
  unlockLevel(e: Entity) { const c = e.transformed ? e.equip.card : undefined; return c ? c.lv ?? 1 : e.level; }
  /** Unlocked active skills of the current form. */
  skillsOf(e: Entity): SkillDef[] { const lv = this.unlockLevel(e); return this.allSkillsOf(e).filter(k => k.unlock <= lv); }
  unlockedPassives(e: Entity): PassiveDef[] {
    const c = e.transformed ? e.equip.card : undefined;
    return c ? (this.defs.cards[c.item].passives ?? []).filter(p => p.unlock <= (c.lv ?? 1)) : [];
  }
  barOf(e: Entity): BarRef[] { return e.bars[this.formOf(e)] ?? []; }
  /** Skills on the current hotbar (in bar order) that are unlocked: what Auto may use. */
  barSkills(e: Entity): SkillDef[] {
    const un = this.skillsOf(e);
    return this.barOf(e).filter((r): r is string => !!r && r.startsWith('s:')).map(r => un.find(k => k.id === r.slice(2))).filter((k): k is SkillDef => !!k);
  }

  /** Create the form's bar if missing and drop newly unlocked skills into empty slots. */
  ensureBar(e: Entity) {
    if (e.kind !== 'player') return;
    const f = this.formOf(e);
    if (!e.bars[f]) { e.bars[f] = Array(BAR_SIZE).fill(null); e.bars[f][8] = 'i:hp_potion'; e.bars[f][9] = 'i:mp_potion'; }
    const known = (e.barKnown[f] ??= []);
    for (const k of this.skillsOf(e)) {
      if (known.includes(k.id)) continue;
      known.push(k.id);
      const i = e.bars[f].indexOf(null);
      if (i >= 0 && !e.bars[f].includes('s:' + k.id)) e.bars[f][i] = 's:' + k.id;
    }
  }

  cardOf(e: Entity) { const c = e.transformed ? e.equip.card : undefined; return c ? this.defs.cards[c.item] : undefined; }

  upgradeCost(st: InvSlot) {
    const isCard = this.defs.items[st.item].slot === 'card';
    const u = isCard ? this.defs.upgrade.card : this.defs.upgrade, up = st.up ?? 0;
    if (up >= (isCard ? this.defs.upgrade.card.maxUp : this.defs.upgrade.maxUp)) return null;
    return { gold: u.gold[up], mat: u.material[up], qty: u.materialQty[up], rate: u.successRate[up] };
  }

  private upgrade(p: Entity, ref: number | Slot) {
    const st = typeof ref === 'number' ? p.inv[ref] : p.equip[ref];
    if (!st) return;
    const def = this.defs.items[st.item];
    if (!this.defs.upgrade.slots.includes(def.slot as Slot)) return;
    const c = this.upgradeCost(st);
    if (!c) { this.events.push({ t: 'msg', id: p.id, text: 'ตีบวกสูงสุดแล้ว' }); return; }
    const mat = p.inv.find(s => s.item === c.mat);
    if (p.gold < c.gold || !mat || mat.qty < c.qty) { this.events.push({ t: 'msg', id: p.id, text: 'ทองหรือวัตถุดิบไม่พอ' }); return; }
    p.gold -= c.gold; mat.qty -= c.qty;
    if (mat.qty <= 0) p.inv.splice(p.inv.indexOf(mat), 1);
    const ok = this.rng() < c.rate;
    if (ok) st.up = (st.up ?? 0) + 1;
    this.events.push({ t: 'upgrade', id: p.id, item: st.item, ok, up: st.up ?? 0 });
    this.recalc(p);
  }

  /** Quick card swap. While transformed you stay transformed in the new card (shares the transform cooldown). */
  inCombat(e: Entity) { return this.now - Math.max(e.lastHurt, e.lastHit) < COMBAT_MS; }

  /** Cooldown after any form change: 10 s, or longer if a skill that was just used still has more left. */
  private formCooldown(e: Entity) {
    let left = FORM_CD_MS;
    for (const k of this.skillsOf(e)) left = Math.max(left, (e.cooldowns[k.id] ?? 0) - this.now);
    return left;
  }

  /** Returns an error text, or null if the form may change now. */
  private formChangeBlocked(p: Entity) {
    if (this.inCombat(p)) return 'อยู่ในการต่อสู้ เปลี่ยนร่างไม่ได้';
    const cd = (p.cooldowns['transform'] ?? 0) - this.now;
    return cd > 0 ? `รออีก ${Math.ceil(cd / 1000)} วิ` : null;
  }

  private switchCard(p: Entity, index: number) {
    const st = p.inv[index]; if (!st || this.defs.items[st.item]?.slot !== 'card') return;
    if (this.defs.items[st.item].class !== p.type) { this.events.push({ t: 'msg', id: p.id, text: 'การ์ดนี้ไม่ใช่ของอาชีพเรา' }); return; }
    const block = p.transformed ? this.formChangeBlocked(p) : null;
    if (block) { this.events.push({ t: 'msg', id: p.id, text: block }); return; }
    const old = p.equip.card;
    p.inv.splice(index, 1); if (old) p.inv.splice(index, 0, old);
    p.equip.card = st; p.pendingSkill = null;
    if (p.transformed) {
      p.cooldowns['transform'] = this.now + this.formCooldown(p);
      const hpPct = p.hp / p.maxHp, mpPct = p.mp / p.maxMp;
      this.recalc(p); p.hp = Math.round(p.maxHp * hpPct); p.mp = Math.round(p.maxMp * mpPct);
      this.ensureBar(p);
      this.events.push({ t: 'transform', id: p.id, on: true });
    }
  }

  private transform(p: Entity) {
    if (!p.equip.card) { this.events.push({ t: 'msg', id: p.id, text: 'ยังไม่ได้ใส่ Spirit Card' }); return; }
    const block = this.formChangeBlocked(p);
    if (block) { this.events.push({ t: 'msg', id: p.id, text: block }); return; }
    const cd = this.formCooldown(p);   // measured on the form we are leaving
    p.transformed = !p.transformed;
    p.cooldowns['transform'] = this.now + cd;
    p.pendingSkill = null;
    const hpPct = p.hp / p.maxHp, mpPct = p.mp / p.maxMp;
    this.recalc(p);
    p.hp = Math.round(p.maxHp * hpPct); p.mp = Math.round(p.maxMp * mpPct);
    this.ensureBar(p);
    this.events.push({ t: 'transform', id: p.id, on: p.transformed });
  }

  /** Test helpers, only usable next to the GM Test NPC (remove that NPC from town.json before real play). */
  private debug(p: Entity, what: string) {
    if (what === 'level' || what === 'level5') {
      for (let i = 0; i < (what === 'level' ? 1 : 5); i++) { this.applyLevel(p, p.level + 1); this.events.push({ t: 'level', id: p.id, level: p.level }); }
      this.ensureBar(p);
      p.xp = 0;
    } else if (what === 'gold') { p.gold += 10000; this.events.push({ t: 'gold', id: p.id, amount: 10000 }); }
    else if (what === 'mats') for (const m of ['slime_jelly', 'pumpkin_seed', 'golem_shard']) this.grantItem(p, m, 30);
    else if (what === 'card') this.grantItem(p, this.randomCardFor(p.type));
    else if (what === 'job' && p.equip.card) {
      const c = p.equip.card; c.lv = Math.min(this.defs.upgrade.cardMaxLevel, (c.lv ?? 1) + 3); c.xp = 0;
      this.events.push({ t: 'cardLevel', id: p.id, card: c.item, lv: c.lv });
      this.recalc(p); this.ensureBar(p);
    }
  }

  private randomCardFor(cls: string) {
    const ids = Object.entries(this.defs.cards).filter(([, c]) => c.class === cls).map(([id]) => id);
    return ids[Math.floor(this.rng() * ids.length)];
  }

  /** Single entry point for items (catch-up / shared loot can hook in later). Returns false if bag full. */
  grantItem(p: Entity, item: string, qty = 1, opts: { filter?: boolean } = {}): boolean {
    const def = this.defs.items[item];
    if (opts.filter !== false) {
      const act = this.lootAct(p, def);
      if (act === 'sell') { p.gold += def.price * qty; this.events.push({ t: 'loot', id: p.id, item, qty, sold: true }); return true; }
      if (act === 'drop') return true;
    }
    if (p.auto) p.autoStats.items[item] = (p.autoStats.items[item] ?? 0) + qty;
    const stackable = def.slot === 'use' || def.slot === 'mat';
    const st = stackable ? p.inv.find(s => s.item === item) : undefined;
    if (st) st.qty += qty;
    else if (p.inv.length < INV_SIZE) p.inv.push(def.slot === 'card' ? { item, qty, lv: 1, xp: 0 } : stackable ? { item, qty } : { item, qty, up: 0 });
    else { this.events.push({ t: 'msg', id: p.id, text: 'กระเป๋าเต็ม' }); return false; }
    this.events.push({ t: 'loot', id: p.id, item, qty });
    return true;
  }

  /** What the loot filter does with an item (cards and mounts are always kept). */
  lootAct(p: Entity, d: ItemDef): LootAct {
    const l = p.autoCfg.loot;
    if (GEAR_SLOTS.includes(d.slot)) return l.gear[d.rarity] ?? 'keep';
    if (d.slot === 'use') return l.use;
    if (d.slot === 'mat') return l.mat;
    return 'keep';
  }

  private cleanCfg(c: AutoCfg): AutoCfg {
    const d = defaultAutoCfg(), n = (v: unknown, lo: number, hi: number, def: number) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : def;
    const act = (v: unknown): LootAct => (v === 'sell' || v === 'drop' ? v : 'keep');
    const strs = (v: unknown) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 50) as string[] : [];
    return {
      range: n(c?.range, 3, 15, d.range), skip: strs(c?.skip), bosses: !!c?.bosses, levelAbove: n(c?.levelAbove, 0, 10, d.levelAbove),
      hp: n(c?.hp, 0, 90, d.hp), mp: n(c?.mp, 0, 90, d.mp),
      loot: { gear: { common: act(c?.loot?.gear?.common), uncommon: act(c?.loot?.gear?.uncommon), rare: act(c?.loot?.gear?.rare), epic: act(c?.loot?.gear?.epic) },
        use: act(c?.loot?.use), mat: act(c?.loot?.mat) },
      skipSkills: strs(c?.skipSkills), returnTown: c?.returnTown !== false, buyHp: n(c?.buyHp, 0, 99, d.buyHp), buyMp: n(c?.buyMp, 0, 99, d.buyMp),
    };
  }

  private equip(p: Entity, index: number) {
    const st = p.inv[index]; if (!st) return;
    const def = this.defs.items[st.item];
    if (!SLOTS.includes(def.slot as Slot)) return;
    if (def.class && def.class !== p.type) { this.events.push({ t: 'msg', id: p.id, text: `ใช้ได้เฉพาะ ${this.defs.classes[def.class].name}` }); return; }
    if ((def.level ?? 1) > p.level) { this.events.push({ t: 'msg', id: p.id, text: `ต้องการ Lv ${def.level}` }); return; }
    const slot = def.slot as Slot, old = p.equip[slot];
    if (slot === 'card' && p.transformed) { this.events.push({ t: 'msg', id: p.id, text: 'คืนร่างก่อนเปลี่ยนการ์ด' }); return; }
    p.inv.splice(index, 1);
    if (old) p.inv.splice(index, 0, old);
    p.equip[slot] = st;
    this.recalc(p);
  }

  private unequip(p: Entity, slot: Slot) {
    const st = p.equip[slot]; if (!st) return;
    if (slot === 'card' && p.transformed) { this.events.push({ t: 'msg', id: p.id, text: 'คืนร่างก่อนถอดการ์ด' }); return; }
    if (p.inv.length >= INV_SIZE) { this.events.push({ t: 'msg', id: p.id, text: 'กระเป๋าเต็ม' }); return; }
    delete p.equip[slot]; p.inv.push(st);
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
    if (intent.kind === 'move') { e.target = null; e.talkTo = null; this.pathTo(e, intent.to); }
    else if (intent.kind === 'setBar') {
      const f = this.formOf(e); this.ensureBar(e);
      const ok = intent.ref === null || /^([si]):[\w-]+$/.test(intent.ref);
      if (ok && intent.slot >= 0 && intent.slot < BAR_SIZE) {
        const bar = e.bars[f], prev = bar.indexOf(intent.ref);
        if (intent.ref && prev >= 0) bar[prev] = bar[intent.slot];   // dragging within the bar swaps
        bar[intent.slot] = intent.ref;
      }
    }
    else if (intent.kind === 'switchCard') this.switchCard(e, intent.index);
    else if (intent.kind === 'mount') {
      if (!e.equip.mount) { this.events.push({ t: 'msg', id: e.id, text: 'ยังไม่ได้ใส่พาหนะ (ซื้อที่ร้าน Mira)' }); return; }
      e.mounted = !e.mounted; e.target = null; e.pendingSkill = null;
    }
    else if (intent.kind === 'attack') {
      e.mounted = false; const t = this.entities.get(intent.target); if (t && !t.dead) { e.target = t.id; e.repathAt = 0; } }
    else if (intent.kind === 'auto') {
      e.auto = intent.on; e.autoTrip = null;
      e.autoAnchor = intent.on ? [Math.round(e.x), Math.round(e.y)] : null;
      if (intent.on) e.autoStats = { since: this.now, xp: 0, gold: 0, kills: 0, items: {} };
    }
    else if (intent.kind === 'autoCfg') e.autoCfg = this.cleanCfg(intent.cfg);
    else if (intent.kind === 'skill') {
      e.mounted = false;
      if (intent.target != null) { const t = this.entities.get(intent.target); if (t && !t.dead && t.kind === 'monster') e.target = t.id; }
      e.pendingSkill = intent.skill; e.repathAt = 0;
    }
    else if (intent.kind === 'equip') this.equip(e, intent.index);
    else if (intent.kind === 'unequip') this.unequip(e, intent.slot);
    else if (intent.kind === 'use') this.use(e, intent.index);
    else if (intent.kind === 'sell') this.sell(e, intent.index);
    else if (intent.kind === 'autoSell') e.autoSell = intent.on;
    else if (intent.kind === 'transform') this.transform(e);
    else if (intent.kind === 'upgrade') { if (this.nearNpc(e, 'smith')) this.upgrade(e, intent.ref); else this.events.push({ t: 'msg', id: e.id, text: 'ตีบวกได้ที่ช่าง Brann ในเมือง' }); }
    else if (intent.kind === 'talk') { e.target = null; e.talkTo = intent.npc; e.repathAt = 0; }
    else if (intent.kind === 'buy') this.buy(e, intent.index, intent.qty);
    else if (intent.kind === 'chat') {
      const text = String(intent.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text) this.events.push({ t: 'chat', id: e.id, name: e.name, text });
    }
    else if (intent.kind === 'stashPut' && this.nearNpc(e, 'stash')) {
      const st = e.inv[intent.index]; if (!st) return;
      const d = this.defs.items[st.item], stack = d.slot === 'use' || d.slot === 'mat';
      const same = stack ? this.stash.find(x => x.item === st.item) : undefined;
      if (same) same.qty += st.qty;
      else if (this.stash.length < STASH_SIZE) this.stash.push(st);
      else { this.events.push({ t: 'msg', id: e.id, text: 'คลังกลางเต็ม' }); return; }
      e.inv.splice(intent.index, 1); this.stashDirty = true;
    }
    else if (intent.kind === 'stashTake' && this.nearNpc(e, 'stash')) {
      const st = this.stash[intent.index]; if (!st) return;
      const d = this.defs.items[st.item], stack = d.slot === 'use' || d.slot === 'mat';
      const same = stack ? e.inv.find(x => x.item === st.item) : undefined;
      if (same) same.qty += st.qty;
      else if (e.inv.length < INV_SIZE) e.inv.push(st);
      else { this.events.push({ t: 'msg', id: e.id, text: 'กระเป๋าเต็ม' }); return; }
      this.stash.splice(intent.index, 1); this.stashDirty = true;
    }
    else if (intent.kind === 'debug' && this.nearNpc(e, 'debug')) this.debug(e, intent.what);
    else if (intent.kind === 'heal' && this.nearNpc(e, 'healer')) {
      e.hp = e.maxHp; e.mp = e.maxMp; this.events.push({ t: 'heal', to: e.id, amount: e.maxHp });
    }
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
    if (this.map.dungeon) this.dungeonTick(this.map.dungeon);
    for (const b of this.blasts.filter(b => this.now >= b.at)) {
      const boss = this.entities.get(b.from);
      if (boss && !boss.dead) for (const p of this.entities.values())
        if (p.kind === 'player' && !p.dead && Math.hypot(p.x - b.x, p.y - b.y) <= b.r) this.strike(boss, p, { mult: b.mult, flat: 0 });
    }
    this.blasts = this.blasts.filter(b => this.now < b.at);
    for (const e of this.entities.values()) {
      e.px = e.x; e.py = e.y;
      if (e.dead) { if (this.now >= e.respawnAt) this.respawn(e); continue; }
      if (e.kind === 'monster') this.monsterAi(e);
      else { this.playerAi(e); this.walkToNpc(e); }
      this.combat(e);
      // out-of-combat regen for players
      if (e.kind === 'player') {
        if (this.now - e.lastHurt > 4000) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.03 * dt);
        e.mp = Math.min(e.maxMp, e.mp + e.maxMp * (this.now - e.lastHurt > 4000 ? 0.04 : 0.015) * dt);
      }
      this.step(e, dt);
      if (e.kind === 'player') {
        const pt = this.map.portals.find(p => p.x === Math.round(e.x) && p.y === Math.round(e.y) && (p.when !== 'cleared' || this.dungeon.cleared));
        if (pt && !e.dead) { e.path = []; this.events.push({ t: 'portal', id: e.id, to: pt.to, spawn: pt.spawn }); }
      }
    }
  }

  // ---- dungeon: rooms gated by doors, boss at the end, rank by clear time ----
  private dungeonTick(d: DungeonDef) {
    const st = this.dungeon;
    const players = [...this.entities.values()].filter(e => e.kind === 'player');
    if (!players.length) { if (st.active || st.cleared) this.dungeonReset(d); return; }
    if (!st.active && !st.cleared) {
      st.active = true; st.startedAt = this.now; st.room = 0;
      const k = d.hpScale[Math.min(players.length, d.hpScale.length) - 1];
      d.rooms.forEach((room, ri) => {
        for (const [type, n] of room.monsters) for (let i = 0; i < n; i++) {
          const [x0, y0, x1, y1] = room.area;
          let t: Tile = [x0, y0];
          for (let tries = 0; tries < 50; tries++) { t = [x0 + Math.floor(this.rng() * (x1 - x0 + 1)), y0 + Math.floor(this.rng() * (y1 - y0 + 1))]; if (this.walkable(...t)) break; }
          const m = this.spawnMonster(type, t);
          m.noRespawn = true; m.aggro = d.aggro; m.maxHp = m.hp = Math.round(m.maxHp * k); m.idleTicks = 1e9; m.home = t;
          m.room = ri;
        }
      });
      this.events.push({ t: 'dungeon', state: 'start' });
      return;
    }
    if (!st.active) return;
    st.timeMs = this.now - st.startedAt;
    const alive = (ri: number) => [...this.entities.values()].some(m => m.kind === 'monster' && m.room === ri && !m.dead);
    while (st.room < d.rooms.length && !alive(st.room)) {
      const door = d.doors.find(x => x.room === st.room);
      if (door) { for (const [x, y] of door.tiles) this.blocked.delete(y * 10000 + x); st.openDoors.push(st.room); this.events.push({ t: 'dungeon', state: 'door' }); }
      st.room++;
    }
    if (st.room >= d.rooms.length) {
      st.active = false; st.cleared = true;
      const sec = st.timeMs / 1000;
      st.rank = sec <= d.rankSec.S ? 'S' : sec <= d.rankSec.A ? 'A' : 'B';
      const rw = d.rewards[st.rank];
      for (const p of players) {
        const g = rw.gold[0] + Math.floor(this.rng() * (rw.gold[1] - rw.gold[0] + 1));
        p.gold += g; this.events.push({ t: 'gold', id: p.id, amount: g });
        for (const [item, q] of rw.items) this.grantItem(p, item, q);
        if (this.rng() < rw.cardChance) this.grantItem(p, this.randomCardFor(p.type));
      }
      this.events.push({ t: 'dungeon', state: 'clear', rank: st.rank, timeMs: st.timeMs });
    }
  }

  private dungeonReset(d: DungeonDef) {
    for (const [id, m] of [...this.entities]) if (m.kind === 'monster') this.entities.delete(id);
    for (const door of d.doors) for (const [x, y] of door.tiles) this.blocked.add(y * 10000 + x);
    this.blasts = [];
    this.dungeon = { active: false, startedAt: 0, room: 0, openDoors: [], cleared: false, rank: null, timeMs: 0 };
    this.events.push({ t: 'dungeon', state: 'reset' });
  }

  private walkToNpc(e: Entity) {
    if (!e.talkTo) return;
    const n = this.map.npcs.find(n => n.id === e.talkTo);
    if (!n) { e.talkTo = null; return; }
    if (Math.hypot(n.x - e.x, n.y - e.y) <= 1.6) {
      e.path = []; e.talkTo = null;
      e.facing = (n.x - n.y) > (e.x - e.y) ? 1 : -1;
      if (e.autoTrip?.phase === 'shop') { this.autoShop(e); e.autoTrip.phase = 'back'; return; }
      this.events.push({ t: 'talk', id: e.id, npc: n.id });
    } else if (this.now >= e.repathAt && !e.path.length) {
      e.repathAt = this.now + 500;
      const opts: Tile[] = [[n.x, n.y + 1], [n.x + 1, n.y], [n.x - 1, n.y], [n.x, n.y - 1], [n.x + 1, n.y + 1], [n.x - 1, n.y + 1]];
      for (const t of opts) if (this.walkable(...t) && this.pathTo(e, t)) break;
    }
  }

  private dist(a: Entity, b: Entity) { return Math.hypot(a.x - b.x, a.y - b.y); }

  private combat(e: Entity) {
    if (e.mounted) return;
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
    const pend = e.pendingSkill ? this.skillsOf(e).find(k => k.id === e.pendingSkill) : undefined;
    if (d <= (pend?.range ?? e.range)) {
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
    e.lastHit = this.now;
    const r = rollAttack(this.defs.balance, e.stats, t.stats, this.rng, sk);
    const lh = t.passive?.lowhp;
    if (lh && r.hit && t.hp / t.maxHp < lh.threshold) r.dmg = Math.max(1, Math.round(r.dmg * (1 - lh.reduce)));
    this.events.push({ t: 'dmg', to: t.id, amount: r.dmg, crit: r.crit, miss: !r.hit });
    if (e.passive?.lifesteal && r.hit) e.hp = Math.min(e.maxHp, e.hp + r.dmg * e.passive.lifesteal);
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
    if (t) this.events.push({ t: 'attack', from: e.id, to: t.id, ranged: (sk.range ?? e.range) > 2 && !sk.self });
    const cs: Skill = { mult: sk.mult ?? 1, flat: sk.flat ?? 0, element: sk.element, offhand: sk.offhand };
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
    t.hp = 0; t.dead = true; t.target = null; t.path = []; t.mounted = false;
    this.events.push({ t: 'die', id: t.id });
    const rs = this.defs.balance.respawnMs;
    t.respawnAt = t.noRespawn ? Infinity : this.now + (t.kind === 'monster' ? rs.monster : rs.player);
    for (const o of this.entities.values()) if (o.target === t.id) o.target = null;
    if (t.kind === 'monster' && from.kind === 'player') {
      // everyone nearby gets full XP + gold + their own drop rolls: playing together never means sharing less
      const m = this.defs.monsters[t.type];
      for (const p of this.entities.values()) {
        if (p.kind !== 'player' || p.dead || (p !== from && Math.hypot(p.x - t.x, p.y - t.y) > SHARE_RANGE)) continue;
        this.grantXp(p, t.xpReward);
        const g = m.gold[0] + Math.floor(this.rng() * (m.gold[1] - m.gold[0] + 1));
        p.gold += g; this.events.push({ t: 'gold', id: p.id, amount: g });
        if (p.auto) { p.autoStats.gold += g; p.autoStats.kills++; }
        for (const [item, chance, qty] of m.drops) if (this.rng() < chance) this.grantItem(p, item, qty ?? 1);
        if (m.cardChance && this.rng() < m.cardChance) this.grantItem(p, this.randomCardFor(p.type));
      }
    }
  }

  // Single entry point for XP so catch-up / rested bonuses can hook in later.
  grantXp(p: Entity, amount: number) {
    this.events.push({ t: 'xp', id: p.id, amount });
    if (p.auto) p.autoStats.xp += amount;
    p.xp += amount;
    while (p.xp >= this.xpNeeded(p)) {
      p.xp -= this.xpNeeded(p);
      this.applyLevel(p, p.level + 1);
      this.events.push({ t: 'level', id: p.id, level: p.level });
      this.ensureBar(p);
      if (p.level === this.defs.upgrade.giftCardAtLevel) {
        this.events.push({ t: 'msg', id: p.id, text: `ครบ Lv ${p.level}! ได้รับ Spirit Card` });
        this.grantItem(p, this.randomCardFor(p.type));
      }
    }
    // card levels while transformed
    const card = p.transformed ? p.equip.card : undefined, u = this.defs.upgrade;
    if (card && (card.lv ?? 1) < u.cardMaxLevel) {
      card.xp = (card.xp ?? 0) + amount;
      while ((card.lv ?? 1) < u.cardMaxLevel && card.xp >= u.cardXpPerLevel * (card.lv ?? 1)) {
        card.xp -= u.cardXpPerLevel * (card.lv ?? 1); card.lv = (card.lv ?? 1) + 1;
        this.events.push({ t: 'cardLevel', id: p.id, card: card.item, lv: card.lv });
        this.recalc(p); this.ensureBar(p);
      }
    }
  }

  private respawn(e: Entity) {
    e.dead = false; e.hp = e.maxHp; e.mp = e.maxMp; e.target = null; e.path = [];
    const [x, y] = e.kind === 'player' ? this.map.spawn : this.randomFreeTile();
    if (e.kind === 'monster') e.home = [x, y];
    e.x = e.px = x; e.y = e.py = y;
    this.events.push({ t: 'respawn', id: e.id });
  }

  private potionIdx(e: Entity, kind: 'hp' | 'mp') { return e.inv.findIndex(s => this.defs.items[s.item].heal?.[kind]); }

  private playerAi(e: Entity) {
    if (!e.auto || e.dead) return;
    if (e.mounted && !e.autoTrip) e.mounted = false;   // Auto fights, so it gets off the mount
    const c = e.autoCfg;
    if (c.hp && e.hp < e.maxHp * c.hp / 100) { const i = this.potionIdx(e, 'hp'); if (i >= 0) this.use(e, i); }
    if (c.mp && e.mp < e.maxMp * c.mp / 100) { const i = this.potionIdx(e, 'mp'); if (i >= 0) this.use(e, i); }

    // return-to-town trip (not inside dungeons)
    if (!e.autoTrip && c.returnTown && !this.map.dungeon && this.map.id !== 'town'
      && ((c.hp && this.potionIdx(e, 'hp') < 0) || e.inv.length >= INV_SIZE)) {
      e.autoTrip = { phase: 'toTown', home: this.map.id, spot: e.autoAnchor ?? [Math.round(e.x), Math.round(e.y)] };
      e.target = null; e.pendingSkill = null;
      this.events.push({ t: 'msg', id: e.id, text: 'Auto: ยาหมด/กระเป๋าเต็ม กลับเมืองไปซื้อของ' });
    }
    if (e.autoTrip) { this.autoTripStep(e, e.autoTrip); return; }

    if (e.target == null && !e.path.length) {
      let m: Entity | undefined;
      if (this.map.dungeon) {
        // dungeon: only the current room (doors block the rest), bosses included
        m = [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && o.room === this.dungeon.room && !c.skip.includes(o.type))
          .sort((p, q) => this.dist(e, p) - this.dist(e, q))[0];
      } else {
        const [ax, ay] = e.autoAnchor ?? [e.x, e.y];
        m = [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && !c.skip.includes(o.type)
          && (!o.boss || c.bosses) && o.level <= e.level + c.levelAbove && Math.hypot(o.x - ax, o.y - ay) <= c.range)
          .sort((p, q) => this.dist(e, p) - this.dist(e, q))[0];
        if (!m && Math.hypot(e.x - ax, e.y - ay) > 1.5) this.pathTo(e, [Math.round(ax), Math.round(ay)]);
      }
      if (m) { e.target = m.id; e.repathAt = 0; }
    }
    // skills in bar order (minus the ones switched off); heal only when hurt; self-AoE only when the target is close
    if (e.target != null && !e.pendingSkill) {
      const t = this.entities.get(e.target);
      for (const sk of this.barSkills(e)) {
        if (c.skipSkills.includes(sk.id) || !this.skillReady(e, sk)) continue;
        if (sk.heal && e.hp > e.maxHp * 0.5) continue;
        if (sk.self && sk.aoe && (!t || this.dist(e, t) > sk.aoe)) continue;
        e.pendingSkill = sk.id; break;
      }
    }
  }

  private autoTripStep(e: Entity, trip: AutoTrip) {
    const walkTo = (t: Tile) => { if (!e.path.length && this.now >= e.repathAt) { e.repathAt = this.now + 800; this.pathTo(e, t); } };
    const portalTo = (to: string) => this.map.portals.find(p => p.to === to && !p.when) ?? this.map.portals.find(p => !p.when);
    if (trip.phase === 'toTown') {
      if (this.map.id === 'town') { trip.phase = 'shop'; e.talkTo = 'shop'; e.repathAt = 0; return; }
      const pt = portalTo('town'); if (pt) walkTo([pt.x, pt.y]);
    } else if (trip.phase === 'shop') {
      if (!e.talkTo) e.talkTo = 'shop';          // walkToNpc does the walking; autoShop runs on arrival
    } else {
      if (this.map.id !== trip.home) { const pt = portalTo(trip.home); if (pt) walkTo([pt.x, pt.y]); return; }
      if (Math.hypot(e.x - trip.spot[0], e.y - trip.spot[1]) <= 1.5) { e.autoTrip = null; e.autoAnchor = trip.spot; e.mounted = false; return; }
      walkTo(trip.spot);
    }
    if (e.equip.mount && !e.mounted) e.mounted = true;   // ride while travelling
  }

  /** At the shop during an Auto trip: sell what the filter says to sell, then restock potions. */
  private autoShop(e: Entity) {
    for (let i = e.inv.length - 1; i >= 0; i--) {
      const st = e.inv[i], d = this.defs.items[st.item];
      if (this.lootAct(e, d) === 'sell') { e.gold += d.price * st.qty; e.inv.splice(i, 1); }
    }
    const n = this.map.npcs.find(x => this.defs.npcs[x.id].role === 'shop'); if (!n) return;
    const sells = this.defs.npcs[n.id].sells ?? [];
    for (const [kind, want] of [['hp', e.autoCfg.buyHp], ['mp', e.autoCfg.buyMp]] as const) {
      const oi = sells.findIndex(o => this.defs.items[o.item].heal?.[kind]); if (oi < 0 || !want) continue;
      const have = e.inv.filter(s => this.defs.items[s.item].heal?.[kind]).reduce((a, s) => a + s.qty, 0);
      const qty = Math.min(want - have, Math.floor(e.gold / sells[oi].price));
      if (qty > 0) { e.gold -= sells[oi].price * qty; this.grantItem(e, sells[oi].item, qty, { filter: false }); }
    }
    this.events.push({ t: 'msg', id: e.id, text: 'Auto: ขายของและซื้อยาแล้ว กำลังกลับจุดล่า' });
  }

  private monsterAi(e: Entity) {
    if (e.target == null && e.aggro) {
      let best: Entity | null = null, bd = e.aggro;
      for (const o of this.entities.values()) if (o.kind === 'player' && !o.dead) { const d = this.dist(e, o); if (d < bd) { bd = d; best = o; } }
      if (best) { e.target = best.id; e.repathAt = 0; }
    }
    const blast = this.defs.monsters[e.type].blast;
    if (blast && e.target != null && this.now >= e.nextBlast) {
      const t = this.entities.get(e.target);
      if (t && !t.dead) {
        if (!e.nextBlast) e.nextBlast = this.now + 3000;
        else {
          e.nextBlast = this.now + blast.everyMs;
          this.blasts.push({ x: t.x, y: t.y, r: blast.radius, at: this.now + blast.castMs, from: e.id, mult: blast.mult });
          this.events.push({ t: 'telegraph', x: t.x, y: t.y, r: blast.radius, ms: blast.castMs });
        }
      }
    }
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
    const mount = e.mounted && e.equip.mount ? this.defs.items[e.equip.mount.item].mount : undefined;
    let budget = e.speed * (mount?.speed ?? 1) * dt;
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
