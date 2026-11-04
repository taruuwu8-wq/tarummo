// All game data, shared by client and server.
import balance from '../data/balance.json';
import classes from '../data/classes.json';
import monsters from '../data/monsters.json';
import items from '../data/items.json';
import skills from '../data/skills.json';
import cards from '../data/cards.json';
import upgrade from '../data/upgrade.json';
import npcs from '../data/npcs.json';
import options from '../data/options.json';
import rarity from '../data/rarity.json';
import meadow from '../data/maps/meadow.json';
import town from '../data/maps/town.json';
import ruins from '../data/maps/ruins.json';
import frostwood from '../data/maps/frostwood.json';
import statuses from '../data/statuses.json';
import quests from '../data/quests.json';
import recipes from '../data/recipes.json';
import type { Defs, MapData } from './sim/world';

export const loadDefs = () => structuredClone({ balance, classes, monsters, items, skills, cards, upgrade, npcs, options, rarity, statuses, quests, recipes, mapGraph: graph() }) as unknown as Defs;
export const MAPS = { meadow, town, ruins, frostwood } as unknown as Record<string, MapData>;
export const START_MAP = 'town';

/** Portal links between maps, so Auto can route across several maps. */
function graph() {
  const g: Record<string, { to: string; x: number; y: number; minLevel?: number; when?: string }[]> = {};
  for (const [id, m] of Object.entries(MAPS)) g[id] = m.portals.map(p => ({ to: p.to, x: p.x, y: p.y, minLevel: p.minLevel, when: p.when }));
  return g;
}
