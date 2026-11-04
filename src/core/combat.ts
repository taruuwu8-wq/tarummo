// Pure combat math, shared by client prototype, balance script and (later) server.
// Structure adapted from hatz2/nostale-dmg-calculator (MIT):
//   physical = (baseAtk + weapon*(1+upg) + flat) - armor*(1+armorUpg)   [crit multiplies this part]
//   elemental = (attackTotal + elemFlat) * elemRate * (1 - res) * (1 + elementBonus)
//   morale   = attackerLevel - defenderLevel
//   total    = (physical + elemental + morale) * (1 + dmgPct) * skillMult
// Simplified: no fairy, gems, shells or bcards. Hit chance is our own addition.

export type AttackType = 'melee' | 'ranged' | 'magic';
export type Element = 'none' | 'fire' | 'water' | 'light' | 'shadow';

export interface Balance {
  flatAttack: number;
  upgradeBonus: number[];
  elementBonus: Record<Exclude<Element, 'none'>, Record<Element, number>>;
  elementFlat: number;
  hit: { base: number; k: number; min: number; max: number };
  xpCurve: { a: number; p: number; b: number };
}

export interface CombatStats {
  level: number;
  attackType: AttackType;
  baseAtk: number;
  weapon: { min: number; max: number; upgrade: number; critDmg: number };
  /** secondary weapon (crossbow / dagger / orb); skills with offhand: true use it */
  offhand?: { min: number; max: number; upgrade: number; critDmg: number };
  armor: Record<AttackType, number>;
  armorUpgrade: number;
  acc: number; eva: number; critRate: number;
  element: Element; elemRate: number;          // elemRate: 0.25 = 25% (stands in for fairy level)
  res: Partial<Record<Exclude<Element, 'none'>, number>>;  // 0.1 = 10%
  dmgPct: number;                              // 0.1 = +10% damage
  // ---- equipment options (rare/shell lines); all optional, 0.1 = 10% ----
  race?: string;                               // defender: plant / animal / demon / angel / spirit / robot
  raceDmg?: Record<string, number>;            // attacker: extra damage vs a race
  dungeonDmg?: number; softcrit?: number;      // softcrit: chance to deal +15%
  elemPow?: Partial<Record<Element, number>>;  // extra elemRate for that element
  critRateRed?: number; critDmgRed?: number; dmgTakenRed?: number;
}
export interface HitCtx { dungeon?: boolean }

export interface Skill { mult: number; flat: number; element?: Element; attackType?: AttackType; offhand?: boolean }
export const BASIC: Skill = { mult: 1, flat: 0 };

export interface DamageRange { min: number; max: number; critMin: number; critMax: number }
export interface AttackResult { hit: boolean; crit: boolean; dmg: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const upg = (b: Balance, diff: number) => b.upgradeBonus[clamp(diff, 0, b.upgradeBonus.length - 1)];

export function hitChance(b: Balance, acc: number, eva: number) {
  return clamp(b.hit.base + (acc - eva) / (acc + eva + b.hit.k), b.hit.min, b.hit.max);
}

export function damageRange(b: Balance, a: CombatStats, d: CombatStats, skill: Skill = BASIC, ctx: HitCtx = {}): DamageRange {
  const type = skill.attackType ?? a.attackType;
  const w = (skill.offhand && a.offhand) || a.weapon;
  const wMul = 1 + upg(b, w.upgrade - d.armorUpgrade);
  const atkMin = a.baseAtk + skill.flat + w.min * wMul + b.flatAttack;
  const atkMax = a.baseAtk + skill.flat + w.max * wMul + b.flatAttack;
  const def = d.armor[type] * (1 + upg(b, d.armorUpgrade - w.upgrade));

  const elem = skill.element ?? a.element;
  let eMul = 0;
  const rate = elem === 'none' ? 0 : a.elemRate + (a.elemPow?.[elem] ?? 0);
  if (elem !== 'none' && rate > 0) {
    const res = clamp(1 - (d.res[elem] ?? 0), 0, 2);
    eMul = rate * res * (1 + b.elementBonus[elem][d.element]);
  }
  const morale = a.level - d.level;
  const k = (1 + a.dmgPct) * (1 + (d.race ? a.raceDmg?.[d.race] ?? 0 : 0)) * (ctx.dungeon ? 1 + (a.dungeonDmg ?? 0) : 1)
    * (1 - (d.dmgTakenRed ?? 0)) * skill.mult;
  const critMul = 1 + w.critDmg * (1 - (d.critDmgRed ?? 0));
  const total = (atk: number, crit: boolean) => {
    const phys = Math.max(0, atk - def) * (crit ? critMul : 1);
    const el = (atk + b.elementFlat) * eMul;
    return Math.max(1, Math.floor((phys + el + morale) * k));
  };
  return { min: total(atkMin, false), max: total(atkMax, false), critMin: total(atkMin, true), critMax: total(atkMax, true) };
}

export function rollAttack(b: Balance, a: CombatStats, d: CombatStats, rng: () => number, skill: Skill = BASIC, ctx: HitCtx = {}): AttackResult {
  if (rng() > hitChance(b, a.acc, d.eva)) return { hit: false, crit: false, dmg: 0 };
  const r = damageRange(b, a, d, skill, ctx);
  const crit = rng() < Math.max(0, a.critRate - (d.critRateRed ?? 0));
  const lo = crit ? r.critMin : r.min, hi = crit ? r.critMax : r.max;
  let dmg = lo + Math.floor(rng() * (hi - lo + 1));
  if (!crit && a.softcrit && rng() < a.softcrit) dmg = Math.floor(dmg * 1.15);
  return { hit: true, crit, dmg };
}

export function xpToNext(b: Balance, level: number) {
  return Math.floor(b.xpCurve.a * Math.pow(level, b.xpCurve.p) + b.xpCurve.b * level);
}
