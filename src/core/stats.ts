// Build CombatStats from JSON definitions. Pure.
import type { CombatStats, AttackType, Element } from './combat';

type Armor = Record<AttackType, number>;
export interface ClassDef {
  name: string; sprite: string; height: number; speed: number;
  attackType: AttackType; range: number; attackMs: number;
  base: { hp: number; mp: number; atk: number; armor: Armor; acc: number; eva: number; critRate: number; element?: Element; elemRate?: number };
  growth: { hp: number; mp: number; atk: number; armor: Armor; acc: number; eva: number; elemRate?: number };
  starterWeapon: string;
}
export type Slot = 'weapon' | 'armor' | 'hat' | 'charm';
export interface Bonus { hp?: number; mp?: number; atk?: number; armor?: number; acc?: number; eva?: number; critRate?: number; elemRate?: number }
export interface ItemDef {
  name: string; slot: Slot | 'use' | 'mat'; rarity: 'common' | 'uncommon' | 'rare' | 'epic'; icon: string;
  level?: number; class?: string; price: number;
  weapon?: { min: number; max: number; critDmg: number }; bonus?: Bonus; heal?: { hp?: number; mp?: number };
}
export interface MonsterDef {
  name: string; sprite: string; height: number; speed: number; wanderRadius: number;
  level: number; hp: number; xp: number; attackType: AttackType; range: number; attackMs: number;
  atk: { min: number; max: number }; armor: Armor; armorUpgrade: number;
  acc: number; eva: number; critRate: number; element: Element; res: CombatStats['res']; boss?: boolean;
  gold: [number, number]; drops: [string, number, number?][];
}

const FISTS = { min: 4, max: 6, critDmg: 0.3 };

/** Player stats = class base + growth × (level-1) + equipped gear. `gear` holds the ItemDefs in equip slots. */
export function playerStats(c: ClassDef, level: number, gear: ItemDef[] = []): { stats: CombatStats; maxHp: number; maxMp: number } {
  const L = level - 1, g = c.growth, b = c.base;
  const sum: Required<Bonus> = { hp: 0, mp: 0, atk: 0, armor: 0, acc: 0, eva: 0, critRate: 0, elemRate: 0 };
  let w = FISTS;
  for (const it of gear) {
    if (it.weapon) w = it.weapon;
    for (const k in it.bonus ?? {}) sum[k as keyof Bonus] += it.bonus![k as keyof Bonus]!;
  }
  const armor = {} as Armor;
  for (const t of ['melee', 'ranged', 'magic'] as AttackType[]) armor[t] = Math.round(b.armor[t] + g.armor[t] * L + sum.armor);
  return {
    maxHp: Math.round(b.hp + g.hp * L + sum.hp),
    maxMp: Math.round(b.mp + g.mp * L + sum.mp),
    stats: {
      level, attackType: c.attackType, baseAtk: Math.round(b.atk + g.atk * L + sum.atk),
      weapon: { min: w.min, max: w.max, critDmg: w.critDmg, upgrade: 0 }, armor, armorUpgrade: 0,
      acc: Math.round(b.acc + g.acc * L + sum.acc), eva: Math.round(b.eva + g.eva * L + sum.eva), critRate: b.critRate + sum.critRate,
      element: b.element ?? 'none', elemRate: (b.elemRate ?? 0) + (g.elemRate ?? 0) * L + sum.elemRate,
      res: {}, dmgPct: 0,
    },
  };
}

export function monsterStats(m: MonsterDef): CombatStats {
  return {
    level: m.level, attackType: m.attackType, baseAtk: 0,
    weapon: { min: m.atk.min, max: m.atk.max, upgrade: m.armorUpgrade, critDmg: 0.5 },
    armor: m.armor, armorUpgrade: m.armorUpgrade, acc: m.acc, eva: m.eva, critRate: m.critRate,
    element: m.element, elemRate: 0, res: m.res, dmgPct: 0,
  };
}
