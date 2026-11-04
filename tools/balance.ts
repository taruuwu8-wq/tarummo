// Balance check: simulate 1,000 duels per class x monster x level.
// Run: node --experimental-strip-types tools/balance.ts
import { readFileSync } from 'node:fs';
import { rollAttack, xpToNext, type Balance } from '../src/core/combat.ts';
import { playerStats, monsterStats, type ClassDef, type MonsterDef } from '../src/core/stats.ts';

const j = (p: string) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
const B: Balance = j('balance.json'), C: Record<string, ClassDef> = j('classes.json'), M: Record<string, MonsterDef> = j('monsters.json'), I = j('items.json');
let s = 12345; const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

const N = 1000;
console.log('class      lv monster   | sec-to-kill  dmg-taken  win%  | xp/min');
for (const [cid, c] of Object.entries(C)) for (const lv of [1, 3, 6]) for (const [mid, m] of Object.entries(M)) {
  const p = playerStats(c, lv, [{ def: I[c.starterWeapon], up: 0 }]), ms = monsterStats(m);
  let tSum = 0, taken = 0, wins = 0;
  for (let i = 0; i < N; i++) {
    let php = p.maxHp, mhp = m.hp, t = 0, pNext = 0, mNext = m.range < c.range ? 1500 : 0; // ranged gets a head start
    while (php > 0 && mhp > 0 && t < 300000) {
      if (pNext <= mNext) { t = pNext; mhp -= rollAttack(B, p.stats, ms, rng).dmg; pNext += c.attackMs; }
      else { t = mNext; const d = rollAttack(B, ms, p.stats, rng).dmg; php -= d; taken += d; mNext += m.attackMs; }
    }
    if (mhp <= 0) wins++;
    tSum += t;
  }
  const sec = tSum / N / 1000;
  console.log(`${cid.padEnd(10)} ${String(lv).padStart(2)} ${mid.padEnd(9)} | ${sec.toFixed(1).padStart(10)}  ${(taken / N).toFixed(0).padStart(9)}  ${(wins / N * 100).toFixed(0).padStart(4)}  | ${(m.xp / (sec + 3) * 60).toFixed(0).padStart(5)}`);
}
console.log('\nxp to next:', [1, 2, 3, 4, 5, 6, 8, 10].map(l => `L${l}=${xpToNext(B, l)}`).join(' '));
