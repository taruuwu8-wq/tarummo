// Authoritative world simulation. Client sends intents, reads entities + events.
// Runs unchanged on a Node server later.
import { findPath, Tile } from './path';
import { rollAttack, damageRange, xpToNext, Balance, CombatStats, Skill, BASIC, Element, AttackType } from '../core/combat';
import { playerStats, monsterStats, ClassDef, MonsterDef, ItemDef, Slot, Worn, Bonus } from '../core/stats';

export const TICK_MS = 100;

export interface Portal { x: number; y: number; to: string; spawn: Tile; label: string; when?: 'cleared'; minLevel?: number }
export interface DungeonDef {
  doors: { room: number; tiles: Tile[] }[];
  rooms: { area: [number, number, number, number]; monsters: [string, number][] }[];
  aggro: number; hpScale: number[]; rankSec: { S: number; A: number };
  rewards: Record<'S' | 'A' | 'B', { gold: [number, number]; items: [string, number][]; cardChance: number }>;
  /** the one card this dungeon can drop, per class */
  cards?: Record<string, string>;
}
export interface DungeonState { active: boolean; startedAt: number; room: number; openDoors: number[]; cleared: boolean; rank: 'S' | 'A' | 'B' | null; timeMs: number }
export interface MapData {
  id: string; name: string; ground: 'grass' | 'stone' | 'ruin' | 'snow' | 'ash' | 'marsh' | 'temple' | 'sky' | 'lava' | 'crystal'; safe: boolean; width: number; height: number; spawn: Tile;
  rocks: Tile[]; water: Tile[]; trees: Tile[]; walls?: Tile[]; monsters: { type: string; count: number }[];
  treeTint?: string; art?: string; portals: Portal[]; npcs: { id: string; x: number; y: number }[]; dungeon?: DungeonDef;
}
export interface NpcDef {
  name: string; title: string; sprite: string; height: number; role: 'shop' | 'smith' | 'healer' | 'stash' | 'debug' | 'rarer' | 'craft'; greet: string;
  sells?: { item: string; price: number }[];
}
export interface SkillDef {
  id: string; name: string; icon: string; mp: number; cooldownMs: number;
  mult?: number; flat?: number; element?: Element; aoe?: number; self?: boolean; hits?: number; heal?: number;
  /** class skills: character level; card skills: card (job) level */
  unlock: number; offhand?: boolean; range?: number; status?: StatusSpec;
}
export interface PassiveDef { id: string; name: string; icon: string; unlock: number; desc: string; type: 'stat' | 'lifesteal' | 'lowhp' | 'onHit'; bonus?: Bonus; pct?: number; threshold?: number; reduce?: number; status?: StatusSpec }
/** hotbar entry: 's:<skillId>' or 'i:<itemId>' */
export type BarRef = string | null;
export const BAR_SIZE = 10;
/** Renamed ids: old saves are migrated on load. */
const RENAMED: Record<string, string> = { glass_orb: 'spell_gun', star_orb: 'arcane_pistol', orb_bolt: 'arcane_shot', orb_frost: 'frost_bullet' };
const FORM_CD_MS = 10000, COMBAT_MS = 5000, RECALL_MS = 2000;
const TOWN_SPAWN: Tile = [9, 12];

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
  range: 12, skip: [], bosses: false, levelAbove: 1, hp: 35, mp: 15,
  loot: { gear: { common: 'sell', uncommon: 'keep', rare: 'keep', epic: 'keep' }, use: 'keep', mat: 'keep' },
  skipSkills: [], returnTown: true, buyHp: 20, buyMp: 10,
});
export interface AutoTrip { phase: 'toTown' | 'shop' | 'back'; home: string; spot: Tile }
export interface AutoStats { since: number; xp: number; gold: number; kills: number; items: Record<string, number> }
const GEAR_SLOTS = ['weapon', 'offhand', 'armor', 'hat', 'charm'];
export interface Defs {
  balance: Balance & { respawnMs: { monster: number; player: number }; rested: { perHourPct: number; capPct: number; mult: number; minAwayMin: number } };
  classes: Record<string, ClassDef>; monsters: Record<string, MonsterDef>;
  items: Record<string, ItemDef>; skills: Record<string, SkillDef[]>;
  cards: Record<string, CardDef>; upgrade: UpgradeCfg; npcs: Record<string, NpcDef>;
  options: { options: OptDef[] }; rarity: RarityCfg; statuses: Record<StatusType, StatusDef>;
  quests: { main: QuestDef[]; bosses?: QuestDef[]; daily: QuestDef & { reward: { goldPerLevel: number; xpPctOfLevel: number; items: [string, number][] } } };
  recipes: { recipes: RecipeDef[] };
  mapGraph: Record<string, { to: string; x: number; y: number; minLevel?: number; when?: string }[]>;
}
export interface RecipeDef { id: string; out: string; qty: number; inputs: [string, number][]; gold: number; cat: string; level: number }
export interface QuestDef {
  id: string; name: string; map?: string; group?: boolean;
  goal: { type: 'kill' | 'level' | 'clear' | 'visit'; monster?: string; count?: number; level?: number };
  reward: { gold?: number; xp?: number; items?: [string, number][]; shellSrc?: 'boss' | 'normal' };
}
/** main: index into the chain + progress; daily: per-day kill counter */
export interface QuestState { main: number; prog: number; daily: { day: string; prog: number; done: boolean }; bossDone?: string[] }
export type StatusType = 'burn' | 'bleed' | 'slow' | 'stun' | 'freeze';
export interface StatusDef { name: string; icon: string; tint: string; tick?: boolean; maxHpCap?: number; moveMul?: number; attackMul?: number; noAct?: boolean; breakOnHit?: boolean }
/** chance 0..1, ms duration, power = DoT per second as a fraction of the triggering hit */
export interface StatusSpec { type: StatusType; chance: number; ms: number; power: number }
export interface StatusInst { type: StatusType; until: number; tickAt: number; perTick: number; src: number }
export type Grade = 'C' | 'B' | 'A' | 'S';
export interface OptDef { id: string; slot: 'weapon' | 'armor' | 'offhand'; grade: Grade; stat: string; min: number; max: number; label: string }
export interface OptLine { id: string; v: number }
export interface RarityCfg {
  mul: number[]; lines: number[]; gradeWeights: number[][]; drop: { normal: number[]; boss: number[] };
  rarify: { weights: number[]; breakChance: number; goldBase: number; goldPerLevel: number; protectItem: string };
  rerollItem: string; shell: { lineWeights: number[]; gradeWeights: { normal: number[]; boss: number[] } };
  gearSlots: string[]; classGear: Record<string, string[]>;
  /** higher-tier class gear for boss loot once the player reaches `min` */
  classGearByLevel?: ({ min: number } & Record<string, string[] | number>)[];
  bossLoot: LootCfg; miniBossLoot: LootCfg;
  fx: { min: number; color: string; sparks: number; glow: number; pillar: boolean }[];
  gm: { shellLines: number; shellGrades: number[] };
}
export interface LootCfg { classGear: number; shell: number; reroll: number; protect: number; upgradeProtect?: number }
const GRADES: Grade[] = ['C', 'B', 'A', 'S'];
/** Per-player numbers from equipment options that aren't part of CombatStats. */
export interface Extra { bleed: number; mpCost: number; gold: number; xp: number; restHp: number; restMp: number; natHp: number; natMp: number; potion: number }
const NO_EXTRA = (): Extra => ({ bleed: 0, mpCost: 0, gold: 0, xp: 0, restHp: 0, restMp: 0, natHp: 0, natMp: 0, potion: 0 });
export interface CardDef {
  name: string; class: string; role: string; sprite: string; height: number; icon: string; rarity: ItemDef['rarity'];
  aura: string; element?: Element; bonus: Bonus; skills: SkillDef[]; passives: PassiveDef[];
  /** which weapon every skill of this card uses; the other one only adds stats */
  weapon: 'main' | 'offhand'; attackType?: AttackType; range?: number;
}
export interface UpgradeCfg {
  slots: Slot[]; successRate: number[]; gold: number[]; material: string[]; materialQty: number[]; maxUp: number; breakOnFail: number[]; protectItem: string;
  cardXpPerLevel: number; cardMaxLevel: number; giftCardAtLevel: number;
  card: { successRate: number[]; gold: number[]; material: string[]; materialQty: number[]; perUp: Bonus; maxUp: number; breakOnFail: number[] };
  glowTiers: { min: number; color: string; rate: number }[];
  wingTiers: { min: number; size: number; color: string; sprite: string | null; glow?: boolean }[];
}
/** up = upgrade level (gear), lv/xp = card level */
export interface InvSlot { item: string; qty: number; up?: number; lv?: number; xp?: number; rare?: number; opts?: OptLine[] }
export const INV_SIZE = 30;
export const STASH_SIZE = 60;
/** Players within this many tiles of a kill share its XP, gold and (own) drop rolls. */
export const SHARE_RANGE = 12;
export type GearSet = Partial<Record<Slot, InvSlot>>;
const SET_SLOTS: Slot[] = ['weapon', 'offhand', 'armor', 'hat', 'charm'];
const setKey = (st: InvSlot) => `${st.item}|${st.up ?? 0}|${st.rare ?? 0}|${JSON.stringify(st.opts ?? [])}`;
export const SLOTS: Slot[] = ['weapon', 'offhand', 'armor', 'hat', 'charm', 'card', 'mount'];
export interface SaveData { quest?: QuestState; autoQuest?: boolean; rested?: number; lastSeen?: number; autoStats?: AutoStats & { elapsed?: number }; autoOn?: boolean; autoCfg?: AutoCfg; autoAnchor?: Tile | null; autoTrip?: AutoTrip | null; bars?: Record<string, BarRef[]>; barKnown?: Record<string, string[]>; transformed?: boolean; mounted?: boolean; map?: string; cls: string; level: number; xp: number; gold: number; inv: InvSlot[]; equip: Partial<Record<Slot, InvSlot | string>>; autoSell: boolean; gearSet?: GearSet | null }

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
  /** gear worn before the last auto-equip / set swap, so the player can compare and switch back */
  gearSet: GearSet | null;
  cooldowns: Record<string, number>; pendingSkill: string | null; talkTo: string | null;
  lastHit: number;
  rested: number;
  /** set when a town trip could not free the bag; Auto stops re-triggering trips until space frees up */
  bagFullAck?: boolean;
  /** world time when Auto last had something to do; used to roam to a new spot */
  autoBusyAt?: number;
  /** Auto anti-stuck: last tile/time it made progress, and targets it gave up on (id → until) */
  stuckPos?: string; stuckAt?: number; autoIgnore?: Record<number, number>;
  /** manual 'go to town' button: channels then warps */
  recallTown?: boolean;
  quest: QuestState; autoQuest: boolean;
  autoCfg: AutoCfg; autoAnchor: Tile | null; autoTrip: AutoTrip | null; autoStats: AutoStats;
  mounted: boolean; aggro: number; noRespawn: boolean; nextBlast: number; room?: number;
  bars: Record<string, BarRef[]>; barKnown: Record<string, string[]>;
  passive: { lifesteal: number; lowhp?: { threshold: number; reduce: number } };
  extra: Extra;
  statuses: StatusInst[]; prot: Partial<Record<StatusType, number>>; onHit: StatusSpec[];
  summoner?: number; nextSummon: number;
}

export type Intent =
  | { kind: 'move'; id: number; to: Tile }
  | { kind: 'attack'; id: number; target: number }
  | { kind: 'auto'; id: number; on: boolean }
  | { kind: 'skill'; id: number; skill: string; target?: number }
  | { kind: 'equip'; id: number; index: number }
  | { kind: 'unequip'; id: number; slot: Slot }
  | { kind: 'autoGear'; id: number }
  | { kind: 'swapSet'; id: number }
  | { kind: 'use'; id: number; index: number }
  | { kind: 'sell'; id: number; index: number }
  | { kind: 'autoSell'; id: number; on: boolean }
  | { kind: 'transform'; id: number }
  | { kind: 'upgrade'; id: number; ref: number | Slot; protect?: boolean }
  | { kind: 'talk'; id: number; npc: string }
  | { kind: 'buy'; id: number; index: number; qty: number }
  | { kind: 'heal'; id: number }
  | { kind: 'chat'; id: number; text: string }
  | { kind: 'stashPut'; id: number; index: number }
  | { kind: 'stashTake'; id: number; index: number }
  | { kind: 'debug'; id: number; what: 'level' | 'level5' | 'gold' | 'mats' | 'card' | 'job' | 'gear' | 'shells' | 'scrolls' }
  | { kind: 'mount'; id: number }
  | { kind: 'setBar'; id: number; slot: number; ref: BarRef }
  | { kind: 'switchCard'; id: number; index: number }
  | { kind: 'autoCfg'; id: number; cfg: AutoCfg }
  | { kind: 'rarify'; id: number; ref: number | Slot; protect: boolean }
  | { kind: 'sellMany'; id: number; indices: number[] }
  | { kind: 'autoQuest'; id: number; on: boolean }
  | { kind: 'craft'; id: number; recipe: string; times: number }
  | { kind: 'recall'; id: number }
  | { kind: 'applyShell'; id: number; shell: number; ref: number | Slot }
  | { kind: 'reroll'; id: number; ref: number | Slot };

export type GameEvent =
  | { t: 'attack'; from: number; to: number; ranged: boolean }
  | { t: 'dmg'; to: number; amount: number; crit: boolean; miss: boolean; dot?: StatusType }
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
  | { t: 'status'; id: number; type: StatusType }
  | { t: 'unlock'; map: string; by: string }
  | { t: 'quest'; id: number; name: string; done: boolean; daily?: boolean }
  | { t: 'locked'; id: number; map: string; level: number }
  | { t: 'rested'; id: number; amount: number; hours: number }
  | { t: 'rarify'; id: number; item: string; result: 'ok' | 'broke' | 'saved'; rare: number }
  | { t: 'upgrade'; id: number; item: string; ok: boolean; up: number; broke?: boolean; saved?: boolean }
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
  /** maps the group has opened (shared like the stash) */
  unlocks: string[];
  unlocksDirty = false;
  dungeon: DungeonState = { active: false, startedAt: 0, room: 0, openDoors: [], cleared: false, rank: null, timeMs: 0 };
  /** events raised before the entity existed in the world (flushed on the next tick) */
  private pendingEvents: GameEvent[] = [];
  private blasts: { x: number; y: number; r: number; at: number; from: number; mult: number; status?: StatusSpec }[] = [];

  /** mirror: client-side copy fed by server snapshots; no monsters are spawned and tick() is not called. */
  constructor(public map: MapData, public defs: Defs, seed = 1, opts: { mirror?: boolean; stash?: InvSlot[]; unlocks?: string[] } = {}) {
    this.stash = opts.stash ?? [];
    this.unlocks = opts.unlocks ?? [];
    this.cleanItems(this.stash);
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

  /** Migrate renamed ids and drop items that no longer exist (in place). */
  cleanItems(list: InvSlot[]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      if (RENAMED[st.item]) st.item = RENAMED[st.item];
      if (!this.defs.items[st.item]) list.splice(i, 1);
    }
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
      gold: 0, inv: [], equip: {}, autoSell: false, transformed: false, gearSet: null, cooldowns: {}, pendingSkill: null, talkTo: null, lastHit: -1e9, rested: 0, quest: { main: 0, prog: 0, daily: { day: '', prog: 0, done: false } }, autoQuest: false, autoCfg: defaultAutoCfg(), autoAnchor: null, autoTrip: null, autoStats: { since: 0, xp: 0, gold: 0, kills: 0, items: {} }, mounted: false, aggro: 0, noRespawn: false, nextBlast: 0, bars: {}, barKnown: {}, passive: { lifesteal: 0 }, extra: NO_EXTRA(), statuses: [], prot: {}, onHit: [], nextSummon: 0,
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
      Object.assign(e, { xp: save.xp, gold: save.gold, inv: save.inv.filter(s => this.defs.items[s.item]), equip, autoSell: save.autoSell, bars: save.bars ?? {}, barKnown: save.barKnown ?? {}, gearSet: save.gearSet ?? null });
      const cfg = { ...defaultAutoCfg(), ...(save.autoCfg ?? {}) };
      if (!save.autoCfg && save.autoSell) cfg.loot.gear.common = 'sell';
      if (cfg.range === 8) cfg.range = 12;   // old default
      // rested XP: offline time since the last save fills the pool
      const rc = this.defs.balance.rested, need = xpToNext(this.defs.balance, save.level ?? 1);
      e.rested = Math.min(need * rc.capPct, save.rested ?? 0);
      const awayH = save.lastSeen ? (Date.now() - save.lastSeen) / 3600000 : 0;
      if (awayH * 60 >= rc.minAwayMin) {
        const gain = Math.min(need * rc.capPct - e.rested, Math.round(need * rc.perHourPct * awayH));
        if (gain > 0) { e.rested += gain; this.pendingEvents.push({ t: 'rested', id: e.id, amount: gain, hours: Math.round(awayH * 10) / 10 }); }
      }
      if (save.quest) e.quest = save.quest;
      e.autoQuest = !!save.autoQuest;
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
    this.questEvent(e, 'visit');
    this.questEvent(e, 'level');
    return e;
  }

  private spawnMonster(type: string, t: Tile): Entity {
    const m = this.defs.monsters[type];
    const e = this.base('monster', type, t);
    Object.assign(e, {
      name: m.name, speed: m.speed, range: m.range, attackMs: m.attackMs, home: t,
      hp: m.hp, maxHp: m.hp, stats: monsterStats(m), xpReward: m.xp, level: m.level, boss: m.boss,
      aggro: m.aggro ?? 0, onHit: m.onHit ? [m.onHit] : [],
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
      } else gear.push({ def: this.defs.items[st.item], up: st.up ?? 0, mul: this.defs.rarity.mul[st.rare ?? 0] ?? 0 });
    }
    // card passives: stat ones join the gear sum, the others become flags
    const card = e.transformed && e.equip.card ? this.defs.cards[e.equip.card.item] : undefined;
    e.passive = { lifesteal: 0 };
    e.onHit = [];
    for (const ps of card ? this.unlockedPassives(e) : []) {
      if (ps.type === 'stat') gear.push({ def: { name: ps.name, slot: 'charm', rarity: 'common', icon: '', price: 0, bonus: ps.bonus }, up: 0 });
      else if (ps.type === 'lifesteal') e.passive.lifesteal += ps.pct ?? 0;
      else if (ps.type === 'onHit' && ps.status) e.onHit.push(ps.status);
      else if (ps.type === 'lowhp') e.passive.lowhp = { threshold: ps.threshold ?? 0.3, reduce: ps.reduce ?? 0.2 };
    }
    const cls = this.defs.classes[e.type];
    const p = playerStats(cls, e.level, gear);
    if (card?.weapon === 'offhand' && p.stats.offhand) [p.stats.weapon, p.stats.offhand] = [p.stats.offhand, p.stats.weapon];
    p.stats.attackType = card?.attackType ?? cls.attackType;
    e.range = card?.range ?? cls.range;
    this.applyOptions(e, p.stats);
    Object.assign(e, { stats: p.stats, maxHp: p.maxHp, maxMp: p.maxMp });
    e.hp = Math.min(e.hp, e.maxHp); e.mp = Math.min(e.mp, e.maxMp);
  }

  // ---- rare + option lines ----
  optDef(id: string) { return this.defs.options.options.find(o => o.id === id); }

  private pickWeighted(w: number[]) {
    const tot = w.reduce((a, b) => a + b, 0); let r = this.rng() * tot;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
    return w.length - 1;
  }

  /** n random lines for a slot; grade chances from `gw` (C/B/A/S); one line per stat. */
  private rollLines(slot: string, n: number, gw: number[], high = false): OptLine[] {
    const out: OptLine[] = [], used = new Set<string>(), all = this.defs.options.options.filter(o => o.slot === slot);
    for (let i = 0; i < n; i++) {
      const g = GRADES[this.pickWeighted(gw)];
      const pool = all.filter(o => o.grade === g && !used.has(o.stat));
      // no free line of that grade: fall back to the best grade still available
      const rest = all.filter(o => !used.has(o.stat)), best = Math.max(...rest.map(o => GRADES.indexOf(o.grade)));
      const pick = pool.length ? pool : rest.filter(o => GRADES.indexOf(o.grade) === best);
      if (!pick.length) break;
      const o = pick[Math.floor(this.rng() * pick.length)];
      used.add(o.stat);
      const lo = high ? Math.ceil((o.min + o.max) / 2) : o.min;
      out.push({ id: o.id, v: lo + Math.floor(this.rng() * (o.max - lo + 1)) });
    }
    return out;
  }
  private rollRareLines(slot: string, rare: number) { const r = this.defs.rarity; return this.rollLines(slot, r.lines[rare] ?? 0, r.gradeWeights[rare]); }

  /** Option lines from weapon/offhand/armor: the same stat on several items counts only once (highest). */
  private applyOptions(e: Entity, st: CombatStats) {
    const best: Record<string, number> = {};
    for (const sl of ['weapon', 'offhand', 'armor'] as Slot[]) for (const l of e.equip[sl]?.opts ?? []) {
      const o = this.optDef(l.id); if (o) best[o.stat] = Math.max(best[o.stat] ?? 0, l.v);
    }
    const pct = (k: string) => (best[k] ?? 0) / 100;
    st.baseAtk += best.atk ?? 0;
    st.dmgPct += pct('dmgPct') + pct('pve');
    st.softcrit = pct('softcrit'); st.dungeonDmg = pct('dungeonDmg');
    st.critRate += pct('critRate');
    st.weapon.critDmg += pct('critDmg'); if (st.offhand) st.offhand.critDmg += pct('critDmg');
    st.elemRate += pct('elemRate');
    st.raceDmg = {}; st.elemPow = {};
    for (const [k, v] of Object.entries(best)) {
      if (k.startsWith('race_')) st.raceDmg[k.slice(5)] = v / 100;
      if (k.startsWith('elem_') && k !== 'elem_all') st.elemPow[k.slice(5) as Element] = v / 100;
      if (k.startsWith('def_')) st.armor[k.slice(4) as AttackType] += v;
      if (k.startsWith('res_') && k !== 'res_all') st.res[k.slice(4) as 'fire'] = (st.res[k.slice(4) as 'fire'] ?? 0) + v / 100;
    }
    for (const el of ['fire', 'water', 'light', 'shadow'] as const) {
      if (best.elem_all) st.elemPow[el] = (st.elemPow[el] ?? 0) + best.elem_all / 100;
      if (best.res_all) st.res[el] = (st.res[el] ?? 0) + best.res_all / 100;
    }
    st.dmgTakenRed = pct('dmgTaken'); st.critDmgRed = pct('critDmgRed'); st.critRateRed = pct('critRateRed');
    const all = pct('prot_all'), cap = (v: number) => Math.min(0.9, v + all);
    e.prot = { bleed: cap(Math.max(pct('prot_bleed'), pct('prot_wounds'))), burn: cap(pct('prot_wounds')), stun: cap(pct('prot_stun')), freeze: cap(pct('prot_freeze')), slow: cap(pct('prot_slow')) };
    e.extra = { bleed: pct('bleedChance'), mpCost: pct('mpCost'), gold: pct('gold'), xp: pct('xp'), restHp: pct('restHp'), restMp: pct('restMp'), natHp: pct('natHp'), natMp: pct('natMp'), potion: pct('potion') };
  }

  private refSlot(p: Entity, ref: number | Slot) { return typeof ref === 'number' ? p.inv[ref] : p.equip[ref]; }
  priceOf(st: InvSlot) { return Math.round(this.defs.items[st.item].price * (1 + (st.rare ?? 0) * 0.5)); }
  rarifyCost(st: InvSlot) { const r = this.defs.rarity.rarify; return r.goldBase + r.goldPerLevel * (this.defs.items[st.item].level ?? 1); }

  private rarify(p: Entity, ref: number | Slot, protect: boolean) {
    const st = this.refSlot(p, ref); if (!st) return;
    const d = this.defs.items[st.item], r = this.defs.rarity;
    if (!r.gearSlots.includes(d.slot)) return;
    const cost = this.rarifyCost(st);
    if (p.gold < cost) { this.events.push({ t: 'msg', id: p.id, text: 'ทองไม่พอ' }); return; }
    const scroll = protect ? p.inv.find(x => x.item === r.rarify.protectItem) : undefined;
    if (protect && !scroll) { this.events.push({ t: 'msg', id: p.id, text: 'ไม่มีใบกันแตก' }); return; }
    p.gold -= cost;
    if (scroll && --scroll.qty <= 0) p.inv.splice(p.inv.indexOf(scroll), 1);
    if (this.rng() < r.rarify.breakChance) {
      if (scroll) { this.events.push({ t: 'rarify', id: p.id, item: st.item, result: 'saved', rare: st.rare ?? 0 }); return; }
      if (typeof ref === 'number') p.inv.splice(p.inv.indexOf(st), 1); else delete p.equip[ref];
      this.events.push({ t: 'rarify', id: p.id, item: st.item, result: 'broke', rare: st.rare ?? 0 });
      this.recalc(p); return;
    }
    st.rare = this.pickWeighted(r.rarify.weights);
    st.opts = this.rollRareLines(d.slot, st.rare);
    this.events.push({ t: 'rarify', id: p.id, item: st.item, result: 'ok', rare: st.rare });
    this.recalc(p);
  }

  private reroll(p: Entity, ref: number | Slot) {
    const st = this.refSlot(p, ref); if (!st) return;
    const d = this.defs.items[st.item], r = this.defs.rarity;
    if (!r.gearSlots.includes(d.slot) || !(st.rare ?? 0)) { this.events.push({ t: 'msg', id: p.id, text: 'ของ R0 ไม่มีออฟให้สุ่ม' }); return; }
    const sc = p.inv.find(x => x.item === r.rerollItem);
    if (!sc) { this.events.push({ t: 'msg', id: p.id, text: 'ไม่มี Reroll Scroll' }); return; }
    if (--sc.qty <= 0) p.inv.splice(p.inv.indexOf(sc), 1);
    st.opts = this.rollRareLines(d.slot, st.rare ?? 0);      // every line is re-rolled
    this.events.push({ t: 'msg', id: p.id, text: `รีออฟ ${d.name} แล้ว` });
    this.recalc(p);
  }

  private applyShell(p: Entity, shellIdx: number, ref: number | Slot) {
    const sh = p.inv[shellIdx], st = this.refSlot(p, ref);
    if (!sh || !st || sh === st) return;
    const sd = this.defs.items[sh.item], d = this.defs.items[st.item];
    if (sd.slot !== 'shell' || sd.shellFor !== d.slot) { this.events.push({ t: 'msg', id: p.id, text: 'Shell นี้ใส่กับของชิ้นนี้ไม่ได้' }); return; }
    st.opts = (sh.opts ?? []).map(l => ({ ...l }));           // replaces the old lines
    p.inv.splice(p.inv.indexOf(sh), 1);
    this.events.push({ t: 'msg', id: p.id, text: `ใส่ Shell ใน ${d.name} แล้ว (แทนออฟเดิม)` });
    this.recalc(p);
  }

  /** Extra boss / mini-boss loot: class gear with high rare, shells, scrolls. */
  private bossLoot(p: Entity, lc: LootCfg, src: 'normal' | 'boss') {
    const r = this.defs.rarity;
    const tier = (r.classGearByLevel ?? []).filter(t => p.level >= t.min).pop();
    if (this.rng() < lc.classGear) { const list = (tier?.[p.type] as string[] | undefined) ?? r.classGear[p.type] ?? []; if (list.length) this.grantItem(p, list[Math.floor(this.rng() * list.length)], 1, { src }); }
    if (this.rng() < lc.shell) this.grantItem(p, ['shell_weapon', 'shell_armor', 'shell_offhand'][Math.floor(this.rng() * 3)], 1, { src });
    if (this.rng() < lc.reroll) this.grantItem(p, r.rerollItem, 1);
    if (this.rng() < lc.protect) this.grantItem(p, r.rarify.protectItem, 1);
    if (lc.upgradeProtect && this.rng() < lc.upgradeProtect) this.grantItem(p, this.defs.upgrade.protectItem, 1);
  }

  save(e: Entity): SaveData {
    return { quest: e.quest, autoQuest: e.autoQuest, rested: Math.round(e.rested), lastSeen: Date.now(), autoStats: { ...e.autoStats, elapsed: this.now - e.autoStats.since }, autoOn: e.auto, autoCfg: e.autoCfg, autoAnchor: e.autoAnchor, autoTrip: e.autoTrip, bars: e.bars, barKnown: e.barKnown, transformed: e.transformed, mounted: e.mounted, map: this.map.id, cls: e.type, level: e.level, xp: e.xp, gold: e.gold, inv: e.inv, equip: e.equip, autoSell: e.autoSell, gearSet: e.gearSet };
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
    return { gold: u.gold[up], mat: u.material[up], qty: u.materialQty[up], rate: u.successRate[up], breakChance: u.breakOnFail?.[up] ?? 0 };
  }

  private upgrade(p: Entity, ref: number | Slot, protect = false) {
    const st = typeof ref === 'number' ? p.inv[ref] : p.equip[ref];
    if (!st) return;
    const def = this.defs.items[st.item];
    if (!this.defs.upgrade.slots.includes(def.slot as Slot)) return;
    const c = this.upgradeCost(st);
    if (!c) { this.events.push({ t: 'msg', id: p.id, text: 'ตีบวกสูงสุดแล้ว' }); return; }
    const mat = p.inv.find(s => s.item === c.mat);
    if (p.gold < c.gold || !mat || mat.qty < c.qty) { this.events.push({ t: 'msg', id: p.id, text: 'ทองหรือวัตถุดิบไม่พอ' }); return; }
    const scroll = protect ? p.inv.find(x => x.item === this.defs.upgrade.protectItem) : undefined;
    if (protect && !scroll) { this.events.push({ t: 'msg', id: p.id, text: 'ใบกันแตก (ตีบวก) หมดแล้ว' }); return; }
    p.gold -= c.gold; mat.qty -= c.qty;
    if (mat.qty <= 0) p.inv.splice(p.inv.indexOf(mat), 1);
    if (scroll && --scroll.qty <= 0) p.inv.splice(p.inv.indexOf(scroll), 1);
    const ok = this.rng() < c.rate;
    let broke = false, saved = false;
    if (ok) st.up = (st.up ?? 0) + 1;
    else if (c.breakChance && this.rng() < c.breakChance) {
      if (scroll) saved = true;
      else { broke = true; if (typeof ref === 'number') p.inv.splice(p.inv.indexOf(st), 1); else { if (ref === 'card' && p.transformed) { p.transformed = false; } delete p.equip[ref]; } }
    }
    this.events.push({ t: 'upgrade', id: p.id, item: st.item, ok, up: st.up ?? 0, broke, saved });
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
    else if (what === 'mats') for (const m of ['slime_jelly', 'pumpkin_seed', 'golem_shard', 'spirit_crystal', 'treant_bark', 'frost_shard']) this.grantItem(p, m, 30, { filter: false });
    else if (what === 'card') this.grantItem(p, this.randomCardFor(p.type, p));
    else if (what === 'gear') for (let i = 0; i < 3; i++) { const l = this.defs.rarity.classGear[p.type]; this.grantItem(p, l[i % l.length], 1, { src: 'boss', filter: false }); }
    else if (what === 'shells') for (const sh of ['shell_weapon', 'shell_armor', 'shell_offhand']) this.grantItem(p, sh, 1, { src: 'gm' });
    else if (what === 'scrolls') { this.grantItem(p, this.defs.rarity.rerollItem, 5); this.grantItem(p, this.defs.rarity.rarify.protectItem, 5); this.grantItem(p, this.defs.upgrade.protectItem, 5); }
    else if (what === 'job' && p.equip.card) {
      const c = p.equip.card; c.lv = Math.min(this.defs.upgrade.cardMaxLevel, (c.lv ?? 1) + 3); c.xp = 0;
      this.events.push({ t: 'cardLevel', id: p.id, card: c.item, lv: c.lv });
      this.recalc(p); this.ensureBar(p);
    }
  }

  /** A card for this class, preferring ones the player doesn't own yet (bag, equipped, shared stash). */
  private randomCardFor(cls: string, p?: Entity) {
    const ids = Object.entries(this.defs.cards).filter(([, c]) => c.class === cls).map(([id]) => id);
    const owned = new Set([...(p?.inv ?? []), ...(p?.equip.card ? [p.equip.card] : []), ...this.stash].map(s => s.item));
    const fresh = ids.filter(id => !owned.has(id));
    const pool = fresh.length ? fresh : ids;
    return pool[Math.floor(this.rng() * pool.length)];
  }
  /** The first card: always the class's first card in cards.json */
  private firstCardFor(cls: string) { return Object.entries(this.defs.cards).find(([, c]) => c.class === cls)![0]; }

  /** Single entry point for items (catch-up / shared loot can hook in later). Returns false if bag full. */
  grantItem(p: Entity, item: string, qty = 1, opts: { filter?: boolean; src?: 'normal' | 'boss' | 'gm' } = {}): boolean {
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
    else if (p.inv.length < INV_SIZE) {
      const r = this.defs.rarity;
      if (def.slot === 'card') p.inv.push({ item, qty, lv: 1, xp: 0 });
      else if (stackable) p.inv.push({ item, qty });
      else if (def.slot === 'shell') {
        const gm = opts.src === 'gm';
        const n = gm ? r.gm.shellLines : 1 + this.pickWeighted(r.shell.lineWeights);
        p.inv.push({ item, qty: 1, opts: this.rollLines(def.shellFor!, n, gm ? r.gm.shellGrades : r.shell.gradeWeights[opts.src === 'boss' ? 'boss' : 'normal'], gm) });
      } else if (r.gearSlots.includes(def.slot) && opts.src) {
        const rare = opts.src === 'gm' ? 7 : this.pickWeighted(r.drop[opts.src]);
        p.inv.push({ item, qty, up: 0, rare, opts: this.rollRareLines(def.slot, rare) });
      } else p.inv.push({ item, qty, up: 0 });
    }
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

  // ---- gear sets ----
  private wornSet(p: Entity): GearSet { const s: GearSet = {}; for (const sl of SET_SLOTS) if (p.equip[sl]) s[sl] = p.equip[sl]; return s; }
  private canWear(p: Entity, st: InvSlot) { const d = this.defs.items[st.item]; return SET_SLOTS.includes(d.slot as Slot) && (!d.class || d.class === p.type) && (d.level ?? 1) <= p.level; }
  /** Rough combat power with `set` worn instead of the current gear (entity is restored). Avg hit vs an unarmored dummy, avg DEF, HP. */
  gearPreview(e: Entity, set?: GearSet) {
    const keep = { equip: e.equip, stats: e.stats, maxHp: e.maxHp, maxMp: e.maxMp, hp: e.hp, mp: e.mp, passive: e.passive, onHit: e.onHit, range: e.range, prot: e.prot, extra: e.extra };
    if (set) { e.equip = { ...e.equip }; for (const sl of SET_SLOTS) { if (set[sl]) e.equip[sl] = set[sl]; else delete e.equip[sl]; } this.recalc(e); }
    const s = e.stats;
    const dummy: CombatStats = { ...s, armor: { melee: 0, ranged: 0, magic: 0 }, armorUpgrade: 0, res: {}, race: undefined, element: 'none', critRateRed: 0, critDmgRed: 0, dmgTakenRed: 0 };
    const r = damageRange(this.defs.balance, s, dummy), cr = Math.min(1, s.critRate);
    const dmg = (r.min + r.max) / 2 * (1 - cr) + (r.critMin + r.critMax) / 2 * cr;
    const def = (s.armor.melee + s.armor.ranged + s.armor.magic) / 3, hp = e.maxHp;
    Object.assign(e, keep);
    return { dmg: Math.round(dmg), def: Math.round(def), hp, power: Math.round(dmg * 2 + def + hp / 10) };
  }
  /** Wear the strongest wearable item per slot (two passes: option lines interact); the old set is remembered. */
  private autoGear(p: Entity) {
    const before = this.wornSet(p); let changed = false;
    for (let pass = 0; pass < 2; pass++) for (const sl of SET_SLOTS) {
      let best = this.gearPreview(p).power, bi = -1;
      p.inv.forEach((st, i) => {
        if (this.defs.items[st.item].slot !== sl || !this.canWear(p, st)) return;
        const pw = this.gearPreview(p, { ...this.wornSet(p), [sl]: st }).power;
        if (pw > best) { best = pw; bi = i; }
      });
      if (bi >= 0) { this.equip(p, bi); changed = true; }
    }
    if (changed) p.gearSet = before;
    this.events.push({ t: 'msg', id: p.id, text: changed ? 'ใส่ของที่ดีที่สุดแล้ว · บันทึกเซตเดิมไว้ให้เทียบ' : 'ใส่ของที่ดีที่สุดอยู่แล้ว' });
  }
  /** Swap to the remembered set; what was worn becomes the remembered set. */
  private swapSet(p: Entity) {
    const want = p.gearSet; if (!want) return;
    const before = this.wornSet(p); let miss = 0;
    for (const sl of SET_SLOTS) {
      const w = want[sl], cur = p.equip[sl];
      if (!w) { if (cur) this.unequip(p, sl); continue; }   // that set had this slot empty
      if (cur && setKey(cur) === setKey(w)) continue;
      const i = p.inv.findIndex(x => setKey(x) === setKey(w));
      if (i < 0 || !this.canWear(p, p.inv[i])) { miss++; continue; }
      this.equip(p, i);
    }
    p.gearSet = before;
    this.events.push({ t: 'msg', id: p.id, text: miss ? `สลับเซตแล้ว · หาไม่เจอ ${miss} ชิ้น (ขาย/ตีบวก/ฝากคลังไปแล้ว?)` : 'สลับเซตแล้ว' });
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
    if (h.hp) { const a = Math.round(p.maxHp * h.hp * (1 + p.extra.potion)); p.hp = Math.min(p.maxHp, p.hp + a); this.events.push({ t: 'heal', to: p.id, amount: a }); }
    if (h.mp) { const a = Math.round(p.maxMp * h.mp * (1 + p.extra.potion)); p.mp = Math.min(p.maxMp, p.mp + a); this.events.push({ t: 'heal', to: p.id, amount: a, mp: true }); }
    if (--st.qty <= 0) p.inv.splice(index, 1);
  }

  // ---- quests ----
  questOf(e: Entity): QuestDef | undefined { return this.defs.quests.main[e.quest.main]; }
  private today() { return new Date().toISOString().slice(0, 10); }

  /** Progress hooks: kill (monster type), clear (dungeon), level, visit (map entered). */
  private questEvent(p: Entity, kind: 'kill' | 'clear' | 'level' | 'visit', monster?: string) {
    if (p.kind !== 'player') return;
    const q = this.questOf(p);
    if (q && q.goal.type === kind) {
      const onMap = !q.map || q.map === this.map.id;
      if (kind === 'kill' && onMap && q.goal.monster === monster) p.quest.prog++;
      else if (kind === 'clear' && onMap) p.quest.prog = 1;
      else if (kind === 'visit' && onMap) p.quest.prog = 1;
      else if (kind === 'level') p.quest.prog = p.level >= (q.goal.level ?? 1) ? 1 : 0;
      const need = q.goal.type === 'kill' ? q.goal.count ?? 1 : 1;
      if (p.quest.prog >= need) this.finishQuest(p, q);
    }
    if (kind === 'kill') for (const bq of this.defs.quests.bosses ?? []) {
      const done = (p.quest.bossDone ??= []);
      if (!done.includes(bq.id) && bq.goal.monster === monster && (!bq.map || bq.map === this.map.id)) {
        done.push(bq.id);
        const r = bq.reward;
        if (r.gold) { p.gold += r.gold; this.events.push({ t: 'gold', id: p.id, amount: r.gold }); }
        for (const [it, n] of r.items ?? []) this.grantItem(p, it, n, { filter: false, src: this.defs.items[it]?.slot === 'shell' ? r.shellSrc : undefined });
        if (r.xp) this.grantXp(p, r.xp, false);
        this.events.push({ t: 'quest', id: p.id, name: bq.name, done: true });
      }
    }
    if (kind === 'kill') {
      const d = this.defs.quests.daily, dq = p.quest.daily, day = this.today();
      if (dq.day !== day) { dq.day = day; dq.prog = 0; dq.done = false; }
      if (!dq.done && ++dq.prog >= (d.goal.count ?? 1)) {
        dq.done = true;
        const g = d.reward.goldPerLevel * p.level;
        p.gold += g; this.events.push({ t: 'gold', id: p.id, amount: g });
        this.grantXp(p, Math.round(this.xpNeeded(p) * d.reward.xpPctOfLevel), false);
        for (const [it, q2] of d.reward.items) this.grantItem(p, it, q2, { filter: false });
        this.events.push({ t: 'quest', id: p.id, name: d.name, done: true, daily: true });
      }
    }
  }

  private finishQuest(p: Entity, q: QuestDef) {
    const r = q.reward;
    if (r.gold) { p.gold += r.gold; this.events.push({ t: 'gold', id: p.id, amount: r.gold }); }
    for (const [it, n] of r.items ?? []) this.grantItem(p, it, n, { filter: false, src: this.defs.items[it]?.slot === 'shell' ? r.shellSrc : undefined });
    p.quest.main++; p.quest.prog = 0;
    this.events.push({ t: 'quest', id: p.id, name: q.name, done: true });
    if (r.xp) this.grantXp(p, r.xp, false);          // may level up -> next quest's level check runs
    const next = this.questOf(p);
    if (!next) p.autoQuest = false;
    else { this.events.push({ t: 'quest', id: p.id, name: next.name, done: false }); this.questEvent(p, 'level'); this.questEvent(p, 'visit'); }
  }

  /** Next portal on the shortest route to `to` (BFS over the map graph), skipping portals this player can't use. */
  private nextHop(p: Entity, to: string) {
    const g = this.defs.mapGraph, prev = new Map<string, { from: string; x: number; y: number }>([[this.map.id, { from: '', x: 0, y: 0 }]]);
    const q = [this.map.id];
    while (q.length) {
      const cur = q.shift()!;
      if (cur === to) break;
      for (const l of g[cur] ?? []) {
        if (prev.has(l.to) || l.when) continue;
        if (l.minLevel && p.level < l.minLevel && !this.unlocks.includes(l.to)) continue;
        prev.set(l.to, { from: cur, x: l.x, y: l.y }); q.push(l.to);
      }
    }
    if (!prev.has(to)) return null;
    let n = to;
    while (prev.get(n)!.from !== this.map.id) n = prev.get(n)!.from;
    const s = prev.get(n)!; return [s.x, s.y] as Tile;
  }

  /** How many times this recipe can be made right now (materials and gold). */
  craftable(p: Entity, r: RecipeDef) {
    let n = r.gold ? Math.floor(p.gold / r.gold) : 99;
    for (const [it, q] of r.inputs) n = Math.min(n, Math.floor(p.inv.filter(s => s.item === it).reduce((a, s) => a + s.qty, 0) / q));
    return p.level < r.level ? 0 : Math.max(0, n);
  }

  private take(p: Entity, item: string, qty: number) {
    for (let i = p.inv.length - 1; i >= 0 && qty > 0; i--) {
      const st = p.inv[i]; if (st.item !== item) continue;
      const k = Math.min(qty, st.qty); st.qty -= k; qty -= k;
      if (st.qty <= 0) p.inv.splice(i, 1);
    }
  }

  private craft(p: Entity, id: string, times: number) {
    const r = this.defs.recipes.recipes.find(x => x.id === id); if (!r) return;
    const n = Math.min(Math.max(1, Math.floor(times) || 1), 20, this.craftable(p, r));
    if (!n) { this.events.push({ t: 'msg', id: p.id, text: p.level < r.level ? `ต้อง Lv ${r.level}` : 'วัตถุดิบหรือทองไม่พอ' }); return; }
    const d = this.defs.items[r.out], gear = this.defs.rarity.gearSlots.includes(d.slot) || d.slot === 'shell';
    let made = 0;
    for (let i = 0; i < n; i++) {
      if (gear && p.inv.length >= INV_SIZE) break;
      p.gold -= r.gold; for (const [it, q] of r.inputs) this.take(p, it, q);
      for (let k = 0; k < (gear ? r.qty : 1); k++) this.grantItem(p, r.out, gear ? 1 : r.qty, { filter: false, src: gear ? 'normal' : undefined });
      made++;
    }
    if (made) this.events.push({ t: 'msg', id: p.id, text: `คราฟต์ ${d.name} ×${made * r.qty} สำเร็จ` });
  }

  /** Sell several bag slots at once (indices into the bag; duplicates and bad indices ignored). */
  private sellMany(p: Entity, indices: number[]) {
    if (!Array.isArray(indices)) return;
    const idx = [...new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && i < p.inv.length))].sort((a, b) => b - a);
    let g = 0;
    for (const i of idx) { const st = p.inv[i]; g += this.priceOf(st) * st.qty; p.inv.splice(i, 1); }
    if (g) { p.gold += g; this.events.push({ t: 'gold', id: p.id, amount: g }); this.events.push({ t: 'msg', id: p.id, text: `ขาย ${idx.length} ชิ้น ได้ ${g.toLocaleString()} G` }); }
  }

  private sell(p: Entity, index: number) {
    const st = p.inv[index]; if (!st) return;
    const g = this.priceOf(st) * st.qty;
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
    else if (intent.kind === 'rarify') { if (this.nearNpc(e, 'rarer')) this.rarify(e, intent.ref, intent.protect); else this.events.push({ t: 'msg', id: e.id, text: 'สุ่ม Rare ได้ที่ Rina ในเมือง' }); }
    else if (intent.kind === 'applyShell') this.applyShell(e, intent.shell, intent.ref);
    else if (intent.kind === 'sellMany') this.sellMany(e, intent.indices);
    else if (intent.kind === 'recall') {
      // dungeons: always allowed (emergency exit, even mid-fight; the run is abandoned)
      if (this.map.id === 'town') this.events.push({ t: 'msg', id: e.id, text: 'อยู่ในเมืองแล้ว' });
      else if (this.map.dungeon || !this.inCombat(e)) e.recallTown = true;
      else this.events.push({ t: 'msg', id: e.id, text: 'อยู่ในการต่อสู้ วาร์ปไม่ได้' });
    }
    else if (intent.kind === 'craft') { if (this.nearNpc(e, 'craft')) this.craft(e, intent.recipe, intent.times); }
    else if (intent.kind === 'autoQuest') {
      e.autoQuest = intent.on && !!this.questOf(e);
      if (e.autoQuest && !e.auto) this.apply({ kind: 'auto', id: e.id, on: true });
      if (!intent.on) e.autoQuest = false;
    }
    else if (intent.kind === 'reroll') this.reroll(e, intent.ref);
    else if (intent.kind === 'mount') {
      if (!e.equip.mount) { this.events.push({ t: 'msg', id: e.id, text: 'ยังไม่ได้ใส่พาหนะ (ซื้อที่ร้าน Mira)' }); return; }
      e.mounted = !e.mounted; e.target = null; e.pendingSkill = null;
    }
    else if (intent.kind === 'attack') {
      e.mounted = false; const t = this.entities.get(intent.target); if (t && !t.dead) { e.target = t.id; e.repathAt = 0; } }
    else if (intent.kind === 'auto') {
      e.auto = intent.on; e.autoTrip = null;
      if (!intent.on) e.autoQuest = false;
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
    else if (intent.kind === 'autoGear') this.autoGear(e);
    else if (intent.kind === 'swapSet') this.swapSet(e);
    else if (intent.kind === 'use') this.use(e, intent.index);
    else if (intent.kind === 'sell') this.sell(e, intent.index);
    else if (intent.kind === 'autoSell') e.autoSell = intent.on;
    else if (intent.kind === 'transform') this.transform(e);
    else if (intent.kind === 'upgrade') { if (this.nearNpc(e, 'smith')) this.upgrade(e, intent.ref, !!intent.protect); else this.events.push({ t: 'msg', id: e.id, text: 'ตีบวกได้ที่ช่าง Brann ในเมือง' }); }
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
    if (this.pendingEvents.length) this.events.push(...this.pendingEvents.splice(0));
    const dt = TICK_MS / 1000;
    if (this.map.dungeon) this.dungeonTick(this.map.dungeon);
    for (const b of this.blasts.filter(b => this.now >= b.at)) {
      const boss = this.entities.get(b.from);
      if (boss && !boss.dead) for (const p of this.entities.values())
        if (p.kind === 'player' && !p.dead && Math.hypot(p.x - b.x, p.y - b.y) <= b.r) this.strike(boss, p, { mult: b.mult, flat: 0 }, b.status);
    }
    this.blasts = this.blasts.filter(b => this.now < b.at);
    for (const e of this.entities.values()) {
      e.px = e.x; e.py = e.y;
      if (e.dead) { if (this.now >= e.respawnAt) this.respawn(e); continue; }
      this.statusTick(e);
      if (e.dead) continue;
      if (!this.canAct(e)) continue;
      if (e.kind === 'monster') this.monsterAi(e);
      else { if (e.recallTown) { if (e.lastHurt > this.now - 300 && !this.map.dungeon) { e.recallTown = false; delete e.cooldowns['recall']; this.events.push({ t: 'msg', id: e.id, text: 'โดนโจมตี วาร์ปถูกยกเลิก' }); } else this.recall(e, 'town', TOWN_SPAWN); if (!e.cooldowns['recall'] && this.map.id === 'town') e.recallTown = false; } this.playerAi(e); this.walkToNpc(e); }
      this.combat(e);
      // out-of-combat regen for players
      if (e.kind === 'player') {
        const x = e.extra, rest = this.now - e.lastHurt > 4000;
        e.hp = Math.min(e.maxHp, e.hp + e.maxHp * (rest ? 0.03 * (1 + x.restHp) : 0.01 * x.natHp) * dt);
        e.mp = Math.min(e.maxMp, e.mp + e.maxMp * (rest ? 0.04 * (1 + x.restMp) : 0.015 * (1 + x.natMp)) * dt);
      }
      this.step(e, dt);
      if (e.kind === 'player') {
        const pt = this.map.portals.find(p => p.x === Math.round(e.x) && p.y === Math.round(e.y) && (p.when !== 'cleared' || this.dungeon.cleared));
        if (pt && !e.dead) {
          e.path = [];
          if (pt.minLevel && e.level < pt.minLevel && !this.unlocks.includes(pt.to)) {
            if ((e.cooldowns['lockMsg'] ?? 0) <= this.now) { e.cooldowns['lockMsg'] = this.now + 3000; this.events.push({ t: 'locked', id: e.id, map: pt.to, level: pt.minLevel }); }
            if (e.autoTrip) e.autoTrip = null;
          } else {
            if (pt.minLevel && !this.unlocks.includes(pt.to)) { this.unlocks.push(pt.to); this.unlocksDirty = true; this.events.push({ t: 'unlock', map: pt.to, by: e.name }); }
            this.events.push({ t: 'portal', id: e.id, to: pt.to, spawn: pt.spawn });
          }
        }
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
        const card = d.cards?.[p.type];
        if (card && this.rng() < rw.cardChance) this.grantItem(p, card, 1, { filter: false });
        this.questEvent(p, 'clear');
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
      e.nextAttack = this.now + e.attackMs * (this.hasStatus(e, 'slow') ? this.defs.statuses.slow.attackMul ?? 1 : 1);
      this.events.push({ t: 'attack', from: e.id, to: t.id, ranged: e.range > 2 });
      this.strike(e, t, BASIC);
    } else if (this.now >= e.repathAt) {
      e.repathAt = this.now + 400;
      this.pathTo(e, [Math.round(t.x), Math.round(t.y)]);
      if (e.path.length > 1) e.path.pop();
    }
  }

  // ---- status effects ----
  hasStatus(e: Entity, type: StatusType) { return e.statuses?.some(x => x.type === type && x.until > this.now) ?? false; }
  private canAct(e: Entity) { return !e.statuses?.some(x => this.defs.statuses[x.type].noAct && x.until > this.now); }

  private applyStatus(t: Entity, spec: StatusSpec, from: Entity, hit: number) {
    if (t.dead) return;
    const def = this.defs.statuses[spec.type];
    let chance = spec.chance * (1 - (t.prot?.[spec.type] ?? 0)), ms = spec.ms;
    if (t.boss && def.noAct) { chance *= 0.4; ms *= 0.5; }      // bosses shrug off most hard CC
    if (this.rng() >= chance) return;
    let perTick = 0;
    if (def.tick) { perTick = Math.max(1, Math.round(hit * spec.power)); if (def.maxHpCap) perTick = Math.min(perTick, Math.max(1, Math.round(t.maxHp * def.maxHpCap))); }
    const old = t.statuses.find(x => x.type === spec.type);
    if (old) { old.until = Math.max(old.until, this.now + ms); old.perTick = Math.max(old.perTick, perTick); old.src = from.id; }
    else t.statuses.push({ type: spec.type, until: this.now + ms, tickAt: this.now + 1000, perTick, src: from.id });
    if (def.noAct) { t.path = []; t.pendingSkill = null; }
    this.events.push({ t: 'status', id: t.id, type: spec.type });
  }

  private statusTick(e: Entity) {
    if (!e.statuses.length) return;
    for (const st of e.statuses) {
      if (!this.defs.statuses[st.type].tick || this.now < st.tickAt || st.until <= this.now) continue;
      st.tickAt += 1000;
      const src = this.entities.get(st.src) ?? e;
      this.events.push({ t: 'dmg', to: e.id, amount: st.perTick, crit: false, miss: false, dot: st.type });
      this.hurt(e, st.perTick, src);
      if (e.dead) break;
    }
    e.statuses = e.statuses.filter(x => x.until > this.now && !e.dead);
  }

  private strike(e: Entity, t: Entity, sk: Skill, status?: StatusSpec) {
    e.lastHit = this.now;
    const r = rollAttack(this.defs.balance, e.stats, t.stats, this.rng, sk, { dungeon: !!this.map.dungeon });
    const lh = t.passive?.lowhp;
    if (lh && r.hit && t.hp / t.maxHp < lh.threshold) r.dmg = Math.max(1, Math.round(r.dmg * (1 - lh.reduce)));
    this.events.push({ t: 'dmg', to: t.id, amount: r.dmg, crit: r.crit, miss: !r.hit });
    if (e.passive?.lifesteal && r.hit) e.hp = Math.min(e.maxHp, e.hp + r.dmg * e.passive.lifesteal);
    if (r.hit && t.statuses?.length) t.statuses = t.statuses.filter(x => !this.defs.statuses[x.type].breakOnHit);   // a hit shatters freeze
    this.hurt(t, r.dmg, e);
    if (r.hit && !t.dead) {
      if (status) this.applyStatus(t, status, e, r.dmg);
      for (const oh of e.onHit ?? []) this.applyStatus(t, oh, e, r.dmg);
      if (e.extra?.bleed) this.applyStatus(t, { type: 'bleed', chance: e.extra.bleed, ms: 4000, power: 0.15 }, e, r.dmg);
    }
  }

  mpCost(e: Entity, sk: SkillDef) { return Math.round(sk.mp * (1 - (e.extra?.mpCost ?? 0))); }
  skillReady(e: Entity, sk: SkillDef) { return (e.cooldowns[sk.id] ?? 0) <= this.now && e.mp >= this.mpCost(e, sk); }

  private castSkill(e: Entity, sk: SkillDef, t: Entity | null) {
    e.mp -= this.mpCost(e, sk);
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
    const cs: Skill = { mult: sk.mult ?? 1, flat: sk.flat ?? 0, element: sk.element, offhand: !e.transformed && sk.offhand };
    const victims = sk.aoe
      ? [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && Math.hypot(o.x - at.x, o.y - at.y) <= sk.aoe!)
      : t ? [t] : [];
    for (const v of victims) for (let i = 0; i < (sk.hits ?? 1) && !v.dead; i++) this.strike(e, v, cs, sk.status);
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
    t.statuses = [];
    // a summoner's minions vanish with it
    for (const [id, o] of [...this.entities]) if (o.summoner === t.id) this.entities.delete(id);
    if (t.summoner != null) { this.entities.delete(t.id); }
    if (t.kind === 'monster' && from.kind === 'player') {
      // everyone nearby gets full XP + gold + their own drop rolls: playing together never means sharing less
      const m = this.defs.monsters[t.type];
      for (const p of this.entities.values()) {
        if (p.kind !== 'player' || p.dead || (p !== from && Math.hypot(p.x - t.x, p.y - t.y) > SHARE_RANGE)) continue;
        this.grantXp(p, t.xpReward);
        const g = Math.round((m.gold[0] + Math.floor(this.rng() * (m.gold[1] - m.gold[0] + 1))) * (1 + p.extra.gold));
        p.gold += g; this.events.push({ t: 'gold', id: p.id, amount: g });
        if (p.auto) { p.autoStats.gold += g; p.autoStats.kills++; }
        this.questEvent(p, 'kill', t.type);
        for (const [item, chance, qty] of m.drops) if (this.rng() < chance) this.grantItem(p, item, qty ?? 1, { src: 'normal' });
        if (m.loot) this.bossLoot(p, this.defs.rarity[m.loot as 'bossLoot'], m.loot === 'bossLoot' && this.map.dungeon ? 'boss' : 'normal');
        if (m.cardChance && this.rng() < m.cardChance) this.grantItem(p, this.randomCardFor(p.type, p));
      }
    }
  }

  // Single entry point for XP so catch-up / rested bonuses can hook in later.
  grantXp(p: Entity, amount: number, fromKill = true) {
    if (fromKill && p.rested > 0) {
      const bonus = Math.min(p.rested, amount * (this.defs.balance.rested.mult - 1));
      p.rested -= bonus; amount += bonus;
    }
    amount = Math.round(amount * (1 + (p.extra?.xp ?? 0)));
    this.events.push({ t: 'xp', id: p.id, amount });
    if (p.auto) p.autoStats.xp += amount;
    p.xp += amount;
    const cap = this.defs.balance.xpCurve.maxLevel ?? 99;
    if (p.level >= cap) p.xp = 0;
    while (p.level < cap && p.xp >= this.xpNeeded(p)) {
      p.xp -= this.xpNeeded(p);
      this.applyLevel(p, p.level + 1);
      this.events.push({ t: 'level', id: p.id, level: p.level });
      this.ensureBar(p);
      this.questEvent(p, 'level');
      if (p.level === this.defs.upgrade.giftCardAtLevel) {
        this.events.push({ t: 'msg', id: p.id, text: `ครบ Lv ${p.level}! ได้รับ Spirit Card` });
        this.grantItem(p, this.firstCardFor(p.type), 1, { filter: false });
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
    if (e.bagFullAck && e.inv.length < INV_SIZE - 2) e.bagFullAck = false;
    if (e.mounted && !e.autoTrip) e.mounted = false;   // Auto fights, so it gets off the mount
    const c = e.autoCfg;
    if (c.hp && e.hp < e.maxHp * c.hp / 100) { const i = this.potionIdx(e, 'hp'); if (i >= 0) this.use(e, i); }
    if (c.mp && e.mp < e.maxMp * c.mp / 100) { const i = this.potionIdx(e, 'mp'); if (i >= 0) this.use(e, i); }

    // return-to-town trip (not inside dungeons)
    if (!e.autoTrip && c.returnTown && !this.map.dungeon && this.map.id !== 'town'
      && ((c.hp && this.potionIdx(e, 'hp') < 0) || (e.inv.length >= INV_SIZE && !e.bagFullAck))) {
      e.autoTrip = { phase: 'toTown', home: this.map.id, spot: e.autoAnchor ?? [Math.round(e.x), Math.round(e.y)] };
      e.target = null; e.pendingSkill = null;
      this.events.push({ t: 'msg', id: e.id, text: 'Auto: ยาหมด/กระเป๋าเต็ม กลับเมืองไปซื้อของ' });
    }
    if (e.autoTrip) { this.autoTripStep(e, e.autoTrip); return; }

    // Auto quest: go to the quest's map first (route over portals), then hunt only the quest monster
    // group quests (bosses) are not done by Auto alone: hunt normally instead
    const q0 = e.autoQuest ? this.questOf(e) : undefined;
    let q = q0?.group ? undefined : q0;
    const hop = q?.map && q.map !== this.map.id ? this.nextHop(e, q.map) : undefined;
    if (q?.map && q.map !== this.map.id && !hop) {
      // target map still locked by level: keep Auto quest on and hunt here until it opens
      if ((e.cooldowns['questLock'] ?? 0) <= this.now) { e.cooldowns['questLock'] = this.now + 60000; this.events.push({ t: 'msg', id: e.id, text: 'Auto เควสต์: เลเวลยังไม่ถึงแมพเป้าหมาย ล่าที่นี่ไปก่อน' }); }
      q = undefined;
    }
    if (q?.map && q.map !== this.map.id && hop) {
      e.target = null;
      if (e.equip.mount && !e.mounted) e.mounted = true;
      if (!e.path.length && this.now >= e.repathAt) { e.repathAt = this.now + 800; this.pathTo(e, hop); }
      return;
    }
    if (q && e.mounted) e.mounted = false;
    if (q && !e.autoAnchor) e.autoAnchor = [Math.round(e.x), Math.round(e.y)];

    // anti-stuck: a target it can't reach/hit (no strike, no movement for 8 s) is dropped for 20 s
    if (e.target != null) {
      const pos = `${Math.round(e.x * 2)},${Math.round(e.y * 2)}`;
      if (pos !== e.stuckPos || this.now - e.lastHit < 3000) { e.stuckPos = pos; e.stuckAt = this.now; }
      else if (this.now - (e.stuckAt ?? this.now) > 8000) {
        const t = this.entities.get(e.target), room = t?.room != null ? this.map.dungeon?.rooms[t.room] : undefined;
        if (t && room) {
          // a dungeon room can't be skipped: pull the stuck monster onto a walkable tile of its room, nearest the player
          const [x0, y0, x1, y1] = room.area, me: Tile = [Math.round(e.x), Math.round(e.y)], cand: Tile[] = [];
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.walkable(x, y) && Math.hypot(x - e.x, y - e.y) > 1) cand.push([x, y]);
          cand.sort((a, b) => Math.hypot(a[0] - e.x, a[1] - e.y) - Math.hypot(b[0] - e.x, b[1] - e.y));
          const best = cand.slice(0, 12).find(c => findPath(this.walkable, me, c)?.length);
          if (best) { t.x = t.px = best[0]; t.y = t.py = best[1]; t.path = []; t.home = best; }
        } else (e.autoIgnore ??= {})[e.target] = this.now + 20000;
        e.target = null; e.path = []; e.pendingSkill = null; e.stuckAt = this.now;
      }
    }
    const ign = e.autoIgnore, ok = (o: Entity) => !ign || !(ign[o.id] > this.now);
    if (e.target == null && !e.path.length) {
      let m: Entity | undefined;
      if (this.map.dungeon) {
        // dungeon: only the current room (doors block the rest), bosses included
        m = [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && o.room === this.dungeon.room && ok(o))
          .sort((p, q) => this.dist(e, p) - this.dist(e, q))[0];
      } else {
        const [ax, ay] = e.autoAnchor ?? [e.x, e.y];
        const qm = q?.goal.type === 'kill' ? q.goal.monster : undefined;   // quest target overrides the filters
        m = [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && ok(o) && (qm ? o.type === qm
          : !c.skip.includes(o.type) && (!o.boss || c.bosses) && o.level <= e.level + c.levelAbove && Math.hypot(o.x - ax, o.y - ay) <= c.range))
          .sort((p, q) => this.dist(e, p) - this.dist(e, q))[0];
        if (!m && Math.hypot(e.x - ax, e.y - ay) > 1.5) this.pathTo(e, [Math.round(ax), Math.round(ay)]);
        // nothing to hit around the spot for a while: roam to the nearest valid monster anywhere on the map
        if (!m && !e.path.length && this.now - (e.autoBusyAt ?? this.now) > 4000) {
          const far = [...this.entities.values()].filter(o => o.kind === 'monster' && !o.dead && (qm ? o.type === qm
            : !c.skip.includes(o.type) && (!o.boss || c.bosses) && o.level <= e.level + c.levelAbove)).sort((p, q) => this.dist(e, p) - this.dist(e, q))[0];
          if (far) { e.autoAnchor = [Math.round(far.x), Math.round(far.y)]; m = far; }
          e.autoBusyAt = this.now;
        }
      }
      if (m) { e.target = m.id; e.repathAt = 0; }
      if (m || e.path.length) e.autoBusyAt = this.now;
    }
    // skills in bar order (minus the ones switched off); heal only when hurt; self-AoE only when the target is close
    if (e.target != null) e.autoBusyAt = this.now;
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
    // multi-map route (BFS over the portal graph); a direct-link lookup ping-ponged between maps
    const portalTo = (to: string) => { const h = this.nextHop(e, to); return h ? { x: h[0], y: h[1] } : undefined; };
    if (trip.phase === 'toTown') {
      if (this.map.id === 'town') { trip.phase = 'shop'; e.talkTo = 'shop'; e.repathAt = 0; return; }
      this.recall(e, 'town', TOWN_SPAWN);
    } else if (trip.phase === 'shop') {
      if (!e.talkTo) e.talkTo = 'shop';          // walkToNpc does the walking; autoShop runs on arrival
    } else {
      if (this.map.id !== trip.home) { this.recall(e, trip.home, trip.spot); return; }
      if (Math.hypot(e.x - trip.spot[0], e.y - trip.spot[1]) <= 1.5) { e.autoTrip = null; e.autoAnchor = trip.spot; e.mounted = false; return; }
      walkTo(trip.spot);
    }
    if (e.equip.mount && !e.mounted) e.mounted = true;   // ride while travelling
  }

  /** Warp after a short channel (Auto trips and the town button). Fires a portal event like walking through one. */
  recall(e: Entity, to: string, spawn: Tile) {
    if (e.dead) return;
    const at = e.cooldowns['recall'] ?? 0;
    if (!at) { e.cooldowns['recall'] = this.now + RECALL_MS; e.path = []; e.target = null; this.events.push({ t: 'msg', id: e.id, text: to === 'town' ? 'กำลังวาร์ปกลับเมือง…' : 'กำลังวาร์ปกลับจุดล่า…' }); return; }
    if (this.now < at) return;
    delete e.cooldowns['recall'];
    this.events.push({ t: 'portal', id: e.id, to, spawn });
  }

  /** At the shop during an Auto trip: sell what the filter says to sell, then restock potions. */
  private autoShop(e: Entity) {
    for (let i = e.inv.length - 1; i >= 0; i--) {
      const st = e.inv[i], d = this.defs.items[st.item];
      if (this.lootAct(e, d) === 'sell') { e.gold += this.priceOf(st) * st.qty; e.inv.splice(i, 1); }
    }
    const n = this.map.npcs.find(x => this.defs.npcs[x.id].role === 'shop'); if (!n) return;
    const sells = this.defs.npcs[n.id].sells ?? [];
    for (const [kind, want] of [['hp', e.autoCfg.buyHp], ['mp', e.autoCfg.buyMp]] as const) {
      const oi = sells.findIndex(o => this.defs.items[o.item].heal?.[kind]); if (oi < 0 || !want) continue;
      const have = e.inv.filter(s => this.defs.items[s.item].heal?.[kind]).reduce((a, s) => a + s.qty, 0);
      const qty = Math.min(want - have, Math.floor(e.gold / sells[oi].price));
      if (qty > 0) { e.gold -= sells[oi].price * qty; this.grantItem(e, sells[oi].item, qty, { filter: false }); }
    }
    if (e.inv.length >= INV_SIZE) { e.bagFullAck = true; this.events.push({ t: 'msg', id: e.id, text: 'Auto: กระเป๋ายังเต็ม (ของที่ตั้งให้เก็บ) — ล่าต่อแต่จะเก็บของเพิ่มไม่ได้ ลองขายหลายชิ้นหรือฝากคลังกลาง' }); }
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
          this.blasts.push({ x: t.x, y: t.y, r: blast.radius, at: this.now + blast.castMs, from: e.id, mult: blast.mult, status: blast.status });
          this.events.push({ t: 'telegraph', x: t.x, y: t.y, r: blast.radius, ms: blast.castMs });
        }
      }
    }
    const sm = this.defs.monsters[e.type].summon;
    if (sm && e.target != null) {
      if (!e.nextSummon) e.nextSummon = this.now + 5000;
      else if (this.now >= e.nextSummon) {
        e.nextSummon = this.now + sm.everyMs;
        const alive = [...this.entities.values()].filter(o => o.summoner === e.id && !o.dead).length;
        for (let i = 0; i < Math.min(sm.count, sm.max - alive); i++) {
          let t: Tile = [Math.round(e.x), Math.round(e.y)];
          for (let k = 0; k < 20; k++) { const c: Tile = [Math.round(e.x + this.rng() * 4 - 2), Math.round(e.y + this.rng() * 4 - 2)]; if (this.walkable(...c)) { t = c; break; } }
          const m = this.spawnMonster(sm.type, t);
          Object.assign(m, { noRespawn: true, summoner: e.id, aggro: 8, target: e.target, idleTicks: 1e9, xpReward: Math.round(m.xpReward * 0.3) });
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
    let budget = e.speed * (mount?.speed ?? 1) * (this.hasStatus(e, 'slow') ? this.defs.statuses.slow.moveMul ?? 1 : 1) * dt;
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
