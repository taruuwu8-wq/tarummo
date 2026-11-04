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
import type { Defs, MapData } from './sim/world';

export const loadDefs = () => structuredClone({ balance, classes, monsters, items, skills, cards, upgrade, npcs, options, rarity, statuses }) as unknown as Defs;
export const MAPS = { meadow, town, ruins, frostwood } as unknown as Record<string, MapData>;
export const START_MAP = 'town';
