import type { Intent, GameEvent, Entity, SaveData, InvSlot, DungeonState } from '../sim/world';

export type ClientMsg =
  | { t: 'join'; name: string; cls: string }
  | { t: 'intent'; intent: Intent };

export type ServerMsg =
  | { t: 'hello'; saves: Record<string, { cls: string; level: number }> }
  | { t: 'welcome'; id: number; map: string; cls: string }
  | { t: 'tick'; now: number; ents: Partial<Entity>[]; ev: GameEvent[]; stash: InvSlot[]; dungeon: DungeonState; unlocks: string[] }
  | { t: 'error'; text: string };

export type { SaveData };
