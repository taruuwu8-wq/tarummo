// Headless progression sim: one character per class plays with Auto + Auto quest from Lv1.
// Run: npx tsx tools/progress.ts [hours=3]
import { World, TICK_MS, Entity, SaveData } from '../src/sim/world';
import { loadDefs, MAPS, START_MAP } from '../src/data';

const HOURS = Number(process.argv[2] ?? 3);
const defs = loadDefs();
const GEAR = ['weapon', 'offhand', 'armor', 'hat', 'charm'] as const;

function score(w: World, e: Entity, st: { item: string; rare?: number; up?: number }) {
  const d = w.defs.items[st.item], mul = 1 + (w.defs.rarity.mul[st.rare ?? 0] ?? 0);
  if ((d.level ?? 1) > e.level || (d.class && d.class !== e.type)) return -1;
  return ((d.weapon ? (d.weapon.min + d.weapon.max) / 2 : 0) + (d.bonus?.armor ?? 0) * 2 + (d.bonus?.hp ?? 0) / 10 + (d.bonus?.atk ?? 0)) * mul + (st.up ?? 0) * 2;
}
/** a sensible player: wear the best item per slot */
function autoEquip(w: World, e: Entity) {
  for (const sl of GEAR) {
    let best = -1, bi = -1;
    e.inv.forEach((st, i) => { if (w.defs.items[st.item].slot === sl) { const s = score(w, e, st); if (s > best) { best = s; bi = i; } } });
    const cur = e.equip[sl]; if (bi >= 0 && best > (cur ? score(w, e, cur) : -1)) w.apply({ kind: 'equip', id: e.id, index: bi });
  }
}

for (const cls of Object.keys(defs.classes)) {
  let world = new World(structuredClone(MAPS[START_MAP]), defs, 7);
  let e = world.spawnPlayer(cls);
  world.apply({ kind: 'autoQuest', id: e.id, on: true });
  const total = (HOURS * 3600 * 1000) / TICK_MS;
  const marks: Record<number, number> = {}, log: string[] = [];
  const crafted: string[] = [];
  let deaths = 0, trips = 0, dungeonStart = 0, lastQuest = 0;
  for (let t = 0; t < total; t++) {
    world.tick();
    for (const ev of world.events.splice(0)) {
      if (ev.t === 'die' && ev.id === e.id) deaths++;
      if (ev.t === 'level' && ev.id === e.id && !marks[ev.level]) marks[ev.level] = t;
      if (ev.t === 'msg' && ev.id === e.id && ev.text.startsWith('Auto: ยาหมด')) trips++;
      if (ev.t === 'dungeon' && ev.state === 'start') dungeonStart = t;
      if (ev.t === 'dungeon' && ev.state === 'clear') log.push(`dungeon ${ev.rank} in ${Math.round((ev.timeMs ?? 0) / 1000)}s at Lv${e.level} (${Math.round(t * TICK_MS / 60000)}m)`);
      if (ev.t === 'portal' && ev.id === e.id) {
        const save: SaveData = world.save(e), vitals = { hp: e.hp, mp: e.mp };
        save.map = ev.to;
        world = new World(structuredClone(MAPS[ev.to]), defs, 7 + t);
        e = world.spawnPlayer(save.cls, save, ev.spawn, vitals);
        break;
      }
    }
    if (e.quest.main !== lastQuest) { log.push(`quest ${lastQuest + 1} done at ${Math.round(t * TICK_MS / 60000)}m Lv${e.level}`); lastQuest = e.quest.main; }
    if (t % 600 === 0) {
      // like a player: craft the best gear recipe for this class when materials allow (NPC walk skipped)
      const recs = world.defs.recipes.recipes.filter(r => { const d = world.defs.items[r.out]; return ['weapon', 'offhand', 'armor'].includes(d.slot) && (!d.class || d.class === e.type) && r.level <= e.level; });
      for (const r of recs.sort((a, b) => b.level - a.level)) {
        const d = world.defs.items[r.out], cur = e.equip[d.slot as 'weapon'];
        if (cur && (world.defs.items[cur.item].level ?? 1) >= r.level) continue;
        if (world.craftable(e, r) > 0) { (world as unknown as { craft(p: Entity, id: string, n: number): void }).craft(e, r.id, 1); crafted.push(`${r.out}@Lv${e.level}`); }
      }
      autoEquip(world, e);
      // like a player: sell spare gear that is worse than what is worn
      const junk = e.inv.map((st, i) => ({ st, i })).filter(({ st }) => { const sl = world.defs.items[st.item].slot as typeof GEAR[number]; const cur = e.equip[sl];
        return GEAR.includes(sl) && (score(world, e, st) < 0 ? (world.defs.items[st.item].class && world.defs.items[st.item].class !== e.type) || (st.rare ?? 0) < 3 : cur && score(world, e, st) <= score(world, e, cur)); }).map(x => x.i);
      if (junk.length) world.apply({ kind: 'sellMany', id: e.id, indices: junk });
    }
    if (dungeonStart && t - dungeonStart > 6000 && world.map.id === 'ruins' && !world.dungeon.cleared && t % 3000 === 0) log.push(`dungeon still running ${Math.round((t - dungeonStart) * TICK_MS / 1000)}s room ${world.dungeon.room}`);
  }
  const m = (lv: number) => marks[lv] ? `${Math.round(marks[lv] * TICK_MS / 60000)}m` : '-';
  console.log(`\n== ${cls}: Lv${e.level} after ${HOURS}h · deaths ${deaths} · town trips ${trips} · gold ${e.gold} · map ${world.map.id} · quest ${e.quest.main}/8`);
  console.log(`   Lv3 ${m(3)} · Lv5 ${m(5)} · Lv8 ${m(8)} · Lv10 ${m(10)} · Lv12 ${m(12)} · Lv15 ${m(15)}`);
  console.log(`   gear: ${GEAR.map(s => e.equip[s] ? `${e.equip[s]!.item}${e.equip[s]!.rare ? ' R' + e.equip[s]!.rare : ''}` : '-').join(', ')}`);
  console.log('   crafted: ' + crafted.join(', '));
  for (const l of log.slice(0, 14)) console.log('   ' + l);
}
