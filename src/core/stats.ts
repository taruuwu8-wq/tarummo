// Build CombatStats from JSON definitions. Pure.
import type { CombatStats, AttackType, Element } from './combat';

type Armor = Record<AttackType, number>;
export interface ClassDef {
  name: string; sprite: string; height: number; speed: number;
  attackType: AttackType; range: number; attackMs: number;
  base: { hp: number; mp: number; atk: number; armor: Armor; acc: number; eva: number; critRate: number; element?: Element; elemRate?: number };
  growth: { hp: number; mp: number; atk: number; armor: Armor; acc: number; eva: number; elemRate?: number };
  weapon: { min: number; max: number; upgrade: number; critDmg: number };
}
export interface MonsterDef {
  name: string; sprite: string; height: number; speed: number; wanderRadius: number;
  level: number; hp: number; xp: number; attackType: AttackType; range: number; attackMs: number;
  atk: { min: number; max: number }; armor: Armor; armorUpgrade: number;
  acc: number; eva: number; critRate: number; element: Element; res: CombatStats['res']; boss?: boolean;
}

export function playerStats(c: ClassDef, level: number): { stats: CombatStats; maxHp: number; maxMp: number } {
  const L = level - 1, g = c.growth, b = c.base;
  const armor = {} as Armor;
  for (const t of ['melee', 'ranged', 'magic'] as AttackType[]) armor[t] = Math.round(b.armor[t] + g.armor[t] * L);
  return {
    maxHp: Math.round(b.hp + g.hp * L),
    maxMp: Math.round(b.mp + g.mp * L),
    stats: {
      level, attackType: c.attackType, baseAtk: Math.round(b.atk + g.atk * L),
      weapon: { ...c.weapon }, armor, armorUpgrade: 0,
      acc: Math.round(b.acc + g.acc * L), eva: Math.round(b.eva + g.eva * L), critRate: b.critRate,
      element: b.element ?? 'none', elemRate: (b.elemRate ?? 0) + (g.elemRate ?? 0) * L,
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
