// Procedural pixel-art map painting (v2 look). Ground is painted per pixel at half resolution into one
// canvas texture (seamless: no tile grid), props are shaded pixel blobs. Everything is baked once per map.
import Phaser from 'phaser';
import type { MapData } from '../sim/world';

export const PX = 2;   // one art pixel = 2 screen pixels (matches the chibi sprites' pixel size)

// ---- noise ----
const hash = (x: number, y: number, s = 0) => { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const smooth = (t: number) => t * t * (3 - 2 * t);
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
const fbm = (x: number, y: number, s: number) => vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 1) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 2) * 0.15;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => v / 16 - 0.5);
const dither = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)];
const rgb = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const pick = (pal: number[][], v: number) => pal[Math.max(0, Math.min(pal.length - 1, Math.floor(v * pal.length)))];

// Palettes are kept muted (lower saturation/contrast than the character sprites) so characters read first.
interface Theme { grass: number[]; dirt: number[]; sand: number; water: number[]; cliff: number[]; flowers: number[]; flowerRate: number;
  /** town: cobblestone pavers over the whole map except a grass border; fountain gets a stone rim instead of sand */
  stone?: number[]; mortar?: number }
const MEADOW: Theme = {
  grass: [0x45703c, 0x507c43, 0x5b884a, 0x679352, 0x759f5c],
  dirt: [0x76593e, 0x87694a, 0x977957, 0xa68865],
  sand: 0xcdbd90,
  water: [0x325f8e, 0x3c719f, 0x4c84b0, 0x86b8d4],
  cliff: [0x5e4632, 0x503b2a, 0x423122, 0x34271b],
  flowers: [0xeae6dc, 0xe8d27a, 0xe0a6bf, 0xb3a6d8], flowerRate: 0.007,
};
const TOWN: Theme = {
  ...MEADOW, flowerRate: 0.004,
  stone: [0x7d7870, 0x8b857b, 0x989186, 0xa59e92], mortar: 0x625e57,
};
const SNOW: Theme = {
  grass: [0xbfcad6, 0xc9d3de, 0xd3dce5, 0xdde4eb, 0xe7ecf1],   // snow (kept a bit grey so white characters still read)
  dirt: [0x98a6b6, 0xa4b1bf, 0xafbbc8, 0xbac5d0],              // trodden snow path
  sand: 0xeef2f6,                                               // snow rim of the frozen pond
  water: [0x7d9fbd, 0x91b1cb, 0xa7c3d9, 0xd2e4f0],              // ice
  cliff: [0x6b7686, 0x5c6676, 0x4d5664, 0x3e4552],
  flowers: [], flowerRate: 0,
};
const ASH: Theme = {
  grass: [0xa48562, 0xae8f6a, 0xb89972, 0xc1a37b, 0xcaad85],   // dusty sand, muted
  dirt: [0x80634a, 0x8c6e52, 0x98795b, 0xa38464],              // packed earth trail
  sand: 0xc9b08a, water: [0x4c6f86, 0x5a7f96, 0x6b90a6, 0x9fbfcf],
  cliff: [0x93593a, 0x7d4b30, 0x673e27, 0x52311f],              // red rock strata
  flowers: [], flowerRate: 0,
};
// draft themes (until their own prop sheets arrive): ground palettes per map
const MARSH: Theme = {
  grass: [0x3e5644, 0x46604b, 0x4f6a52, 0x58745a, 0x627e62], dirt: [0x4e4a3a, 0x5a5542, 0x66604a, 0x716b53], sand: 0x4e5844,
  water: [0x22403b, 0x2a4b45, 0x345850, 0x5c8277], cliff: [0x3e3a2e, 0x343026, 0x2a271f, 0x201e18], flowers: [], flowerRate: 0,
};
const SKY: Theme = {
  grass: [0xc2cde0, 0xcbd5e5, 0xd4ddeb, 0xdde4f0, 0xe6ecf5], dirt: [0xb3a98f, 0xbfb59b, 0xcac1a8, 0xd5cdb5], sand: 0xeef2f8,
  water: [0x7da2c8, 0x91b3d4, 0xa8c4de, 0xd2e2f0], cliff: [0x9fb0cc, 0x8a9cba, 0x7587a6, 0x617290], flowers: [0xf2c6dc, 0xf3e3a2, 0xd4c8f0], flowerRate: 0.005,
};
const LAVA: Theme = {
  grass: [0x3a2c2a, 0x42322f, 0x4a3834, 0x533f3a, 0x5c4640], dirt: [0x6a3020, 0x7a3826, 0x8a422c, 0x9a4c32], sand: 0x2c2220,
  water: [0xb8401c, 0xd0561e, 0xe8762a, 0xffb04a], cliff: [0x2e2422, 0x261e1c, 0x1e1716, 0x161110], flowers: [], flowerRate: 0,
};
const TWILIGHT: Theme = {
  grass: [0x55547a, 0x5d5c83, 0x66658c, 0x6f6e95, 0x78779e], dirt: [0x454262, 0x4d4a6b, 0x555274, 0x5d5a7d], sand: 0x7c7aa0,
  water: [0x3a4a78, 0x46588a, 0x56689a, 0x8a9cc8], cliff: [0x3e3a5a, 0x34304e, 0x2a2742, 0x201e36], flowers: [0xb8a6e8, 0x9ad0f0], flowerRate: 0.003,
};
const VOID: Theme = {
  grass: [0x2a2238, 0x30273f, 0x362c46, 0x3c324d, 0x433854], dirt: [0x4a2e5e, 0x54356a, 0x5e3c76, 0x684382], sand: 0x1c1626,
  water: [0x3a1e5a, 0x4a2a70, 0x5c3888, 0x9a6ad0], cliff: [0x1c1626, 0x16111f, 0x110d18, 0x0c0911], flowers: [0xc08aff], flowerRate: 0.002,
};
export const THEMES: Record<string, Theme> = { grass: MEADOW, stone: TOWN, snow: SNOW, ash: ASH, marsh: MARSH, sky: SKY, lava: LAVA, twilight: TWILIGHT, void: VOID };

/** Which sheet props a theme scatters (ids from data/props.json). */
/** back: cumulative chances for the back margin [tree, rock cluster, spire] (rest: patches/ground); spireScale for those */
/** recolor: foliage pixels (green hues) are moved to `hue` with saturation/lightness multipliers; trunks/rocks keep their colour */
export interface Recolor { hue: number; sat: number; light: number }
export interface PropSet { tint?: number; recolor?: Recolor; trees: string[]; bushes: string[]; rocks: string[]; rockSmall: string; spires: string[]; ground: string[]; patches: string[]; extras: string[]; groundSway: boolean; farTint: number; back?: [number, number, number]; spireScale?: number }
const GREEN: PropSet = {
  trees: ['oak_a', 'oak_b', 'oak_a', 'pine'], bushes: ['bush_white', 'bush_pink'], rocks: ['rock_big', 'rock_mid'], rockSmall: 'rock_small', spires: ['rock_spire'],
  ground: ['grass_a', 'grass_b', 'grass_c', 'grass_fl1', 'grass_fl2'], patches: ['fl_white', 'fl_pink', 'fl_purple', 'fl_yellow', 'fb_white', 'fb_pink', 'fb_blue', 'fb_mix'],
  extras: ['mush_red', 'mush_small', 'mush_orange'], groundSway: true, farTint: 0xb4bac2,
};
const SNOWY: PropSet = {
  trees: ['snow_pine_tall', 'snow_pine_b', 'snow_pine_small', 'snow_pine_tall', 'bare_tree_snow'], bushes: ['snow_bush', 'snow_bush_round', 'snow_berry_bush'],
  rocks: ['snow_rock_big'], rockSmall: 'snow_rock_flat', spires: ['snow_cliff', 'ice_crystal_big', 'stone_arch', 'stone_pillar'],
  ground: ['ice_sprig', 'snow_patch', 'snow_drift'], patches: ['snow_berry_small', 'snow_bush', 'ice_crystal_small', 'ice_shard', 'bush_snowy'],
  extras: ['ice_crystal_small', 'ice_shard', 'ice_crystal_small', 'ice_shard', 'ice_crystal_small', 'snowman'], groundSway: false, farTint: 0xb8c4d4,   // snowman: rare
};
const DESERT: PropSet = {
  trees: ['dead_tree', 'dead_tree', 'cactus_tall', 'cactus', 'cactus_group'], bushes: ['agave', 'desert_grass', 'cactus_barrel', 'cactus_round'],
  rocks: ['sand_rocks', 'sand_rock_big'], rockSmall: 'sand_rock_small', spires: ['sand_tower', 'sand_arch', 'sand_pillar', 'cactus_rock'],
  ground: ['dry_grass', 'dry_grass_b', 'dry_grass_c', 'sand_stone_small'], patches: ['agave', 'desert_grass', 'dry_grass_b', 'agave'],
  extras: ['cactus_small', 'cactus_round', 'skull', 'sand_stone_small', 'dune', 'sand_slab', 'dune_b'], groundSway: true, farTint: 0xc4b6a6,
  back: [0.3, 0.5, 0.82], spireScale: 1.35,   // canyon walls: mostly rock towers behind
};
// draft sets: existing props recoloured (tint) per theme
const MARSHY: PropSet = {
  trees: ['marsh_tree_isle', 'mush_glow_big', 'dead_tree', 'mush_glow_big'], bushes: ['reeds', 'reeds_mush', 'glow_grass'], rocks: ['moss_rock', 'moss_rock_b'], rockSmall: 'moss_rock_s',
  spires: ['marsh_pond', 'boardwalk', 'marsh_bridge', 'marsh_tree_isle', 'marsh_rock_pool'], ground: ['mush_tiny', 'mush_glow_small', 'glow_grass'], patches: ['mush_purple', 'reeds', 'glow_grass', 'mush_glow_small'],
  extras: ['log', 'stump_moss', 'mist', 'mush_purple'], groundSway: false, farTint: 0x9aa0a0, back: [0.3, 0.45, 0.8]
};
const SKYISH: PropSet = {
  recolor: { hue: 338, sat: 0.45, light: 1.45 }, trees: ['oak_a', 'oak_b', 'sky_tree_isle', 'sky_crystal'], bushes: ['bush_pink', 'bush_white'], rocks: ['sky_crystal', 'sky_obelisk'], rockSmall: 'sky_gem',
  spires: ['sky_falls', 'sky_crystal_isle', 'sky_tree_isle', 'sky_portal', 'sky_crystal'], ground: ['sky_shard', 'sky_shard_b', 'grass_c'], patches: ['fb_white', 'fb_pink', 'sky_gem_b', 'fl_white', 'sky_shard'],
  extras: ['sky_gem', 'sky_obelisk', 'sky_portal'], groundSway: true, farTint: 0xd8dceb, back: [0.4, 0.5, 0.8]
};
const LAVAY: PropSet = {
  trees: ['lava_obelisk', 'lava_crystal', 'lava_pillar', 'lava_crystal_rock'], bushes: ['lava_crystal_pile', 'ember_shard'], rocks: ['lava_spike_rock', 'lava_crystal_pile'], rockSmall: 'ember_ball',
  spires: ['lava_arch', 'lava_arch_b', 'lava_pillars', 'lava_float', 'lava_platform', 'lava_obelisk'], ground: ['ember_shard', 'ember_shard_b', 'ember_ball'], patches: ['ember_shard_b', 'lava_crystal_pile', 'ember_shard'],
  extras: ['lava_ruin', 'lava_ruin_floor', 'ember_ball'], groundSway: false, farTint: 0x9a8a88, back: [0.25, 0.45, 0.85]
};
const TWI: PropSet = {
  recolor: { hue: 268, sat: 0.5, light: 0.85 }, tint: 0xd0cce4, trees: ['dead_tree', 'bare_tree_snow', 'oak_b', 'pine', 'oak_a'], bushes: ['bush_green_b', 'bush_snowy'], rocks: ['rock_big', 'rock_mid'], rockSmall: 'rock_small',
  spires: ['stone_arch', 'stone_pillar', 'ice_crystal_big', 'rock_spire'], ground: ['grass_a', 'grass_c'], patches: ['ice_crystal_small', 'bush_green_a', 'grass_fl2'],
  extras: ['ice_shard', 'ice_crystal_small', 'skull'], groundSway: true, farTint: 0xb0b0c8,
};
const VOIDY: PropSet = {
  trees: ['void_tree', 'void_crystal', 'void_crystal_rock', 'void_tree'], bushes: ['void_crystal_rock', 'void_crystal'], rocks: ['void_slab', 'void_rock_float'], rockSmall: 'void_pebble',
  spires: ['void_gate', 'void_crystal_isle', 'void_crystal_float', 'void_float', 'void_rune_plat', 'void_pillar'], ground: ['void_shard', 'void_shard_b', 'void_shard_c', 'void_pebble'], patches: ['void_shard_b', 'void_crystal', 'void_shard'],
  extras: ['void_pillar', 'void_shard_c', 'void_rock_float'], groundSway: false, farTint: 0x9a90b0, back: [0.3, 0.45, 0.85]
};
export const PROP_SETS: Record<string, PropSet> = { grass: GREEN, stone: GREEN, snow: SNOWY, ash: DESERT, marsh: MARSHY, sky: SKYISH, lava: LAVAY, twilight: TWI, void: VOIDY };
/** multiply two 0xRRGGBB tints */
export const mulTint = (a: number, b: number) => (((((a >> 16) & 255) * ((b >> 16) & 255)) / 255) << 16) | (((((a >> 8) & 255) * ((b >> 8) & 255)) / 255) << 8) | (((a & 255) * (b & 255)) / 255);
export const TOWN_PROPS = ['house_tree', 'house_blue', 'house_vine', 'house_mill', 'lamp', 'flower_bush', 'bench', 'signpost', 'banner', 'sign_board', 'stall_red', 'stall_blue', 'tent', 'stump_axe', 'hay_crates', 'barrel_stone', 'cart', 'crate', 'pot_stand'];
/** Prop textures a v2 map needs (preload only these). */
export function propsFor(map: MapData) {
  if (map.art !== 'v2') return [];
  const p = PROP_SETS[map.ground] ?? GREEN;
  return [...new Set([...p.trees, ...p.bushes, ...p.rocks, p.rockSmall, ...p.spires, ...p.ground, ...p.patches, ...p.extras, ...(map.ground === 'stone' ? TOWN_PROPS : [])])];
}

/** distance from p to segment ab */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Paint the ground of `map` into a texture. Returns the texture key and the top-left screen position.
 * Tile (x, y) has its centre at screen ((x-y)*TW/2, (x+y)*TH/2).
 */
export const MARGIN = 5;   // tiles of painted, decorated but unwalkable ground around the play area
export function paintGround(scene: Phaser.Scene, map: MapData, isWater: (x: number, y: number) => boolean, TW: number, TH: number) {
  const th = THEMES[map.ground] ?? MEADOW, CLIFF = 40;
  const M = MARGIN, mw = map.width + M, mh = map.height + M;
  const minX = -(mh) * TW / 2 - TW / 2 - M * TW / 2, maxX = (mw) * TW / 2 + TW / 2 + M * TW / 2;
  const minY = -M * TH - TH / 2, maxY = (mw + mh) * TH / 2 + TH / 2 + CLIFF;
  const W = Math.ceil((maxX - minX) / PX), H = Math.ceil((maxY - minY) / PX);
  const key = `ground2_${map.id}`;
  if (scene.textures.exists(key)) return { key, x: minX, y: minY };   // deterministic: reuse on revisit
  const tex = scene.textures.createCanvas(key, W, H)!;
  const ctx = tex.getContext(), img = ctx.createImageData(W, H), d = img.data;
  const toTileF = (sx: number, sy: number) => ({ fx: (sx / (TW / 2) + sy / (TH / 2)) / 2, fy: (sy / (TH / 2) - sx / (TW / 2)) / 2 });
  const inside = (fx: number, fy: number) => fx >= -0.5 && fy >= -0.5 && fx <= map.width - 0.5 && fy <= map.height - 0.5;
  const inOuter = (fx: number, fy: number) => fx >= -0.5 - M && fy >= -0.5 - M && fx <= mw - 0.5 && fy <= mh - 0.5;
  // dirt paths: spawn → every portal (an L-shaped route reads more like a trodden path than a straight line)
  const segs: number[][] = [];
  for (const p of map.portals) { const [sx0, sy0] = map.spawn; segs.push([sx0, sy0, p.x, sy0], [p.x, sy0, p.x, p.y]); }
  const water: [number, number][] = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (isWater(x, y)) water.push([x, y]);
  const G = th.grass.map(rgb), D = th.dirt.map(rgb), WA = th.water.map(rgb), C = th.cliff.map(rgb), SA = rgb(th.sand);
  const ST = th.stone?.map(rgb), MO = th.mortar != null ? rgb(th.mortar) : null;

  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    const sx = minX + cx * PX + 1, sy = minY + cy * PX + 1, i = (cy * W + cx) * 4;
    let { fx, fy } = toTileF(sx, sy);
    let col: number[] | null = null;
    if (!inside(fx, fy) && inOuter(fx, fy)) {
      // outside the play area: plain grass a shade darker (reads as "not for walking"), deepening further out
      const out = Math.max(-0.5 - fx, -0.5 - fy, fx - map.width + 0.5, fy - map.height + 0.5);
      const n = fbm(fx * 0.32, fy * 0.32, 1) * 0.6 + fbm(fx * 1.6, fy * 1.6, 2) * 0.4;
      col = pick(G, n * 1.1 - 0.22 - Math.min(0.2, out * 0.04) + dither(cx, cy) * 0.22);
    } else if (inside(fx, fy)) {
      const dt = dither(cx, cy);
      // water: metaballs over water tiles (one smooth pond instead of a lobe per tile), wet rim, sand shore
      let wf = 0;
      for (const [wx, wy] of water) { const q = 1 - ((fx - wx) ** 2 + (fy - wy) ** 2) / 1.3; if (q > 0) wf += q * q; }
      wf += (vnoise(fx * 2.2, fy * 2.2, 7) - 0.5) * 0.12;
      if (wf > 0.42) {
        const depth = Math.min(1, (wf - 0.42) * 1.4), ripple = Math.sin((fx * 1.3 + fy) * 6 + vnoise(fx * 2, fy * 2, 9) * 5);
        col = wf < 0.5 ? WA[0] : ripple > 0.93 && depth > 0.2 ? WA[3] : pick(WA.slice(0, 3), 1 - depth * 0.8 + dt * 0.3);
      } else if (wf > 0.3) col = ST ? (wf > 0.37 ? MO! : ST[3]) : wf > 0.37 ? D[0] : SA;   // town: stone fountain rim
      else {
        let pd = 9;
        for (const s of segs) pd = Math.min(pd, segDist(fx, fy, s[0], s[1], s[2], s[3]));
        const pw = 0.42 + (vnoise(fx * 1.7, fy * 1.7, 3) - 0.5) * 0.35;
        const n = fbm(fx * 0.32, fy * 0.32, 1) * 0.6 + fbm(fx * 1.6, fy * 1.6, 2) * 0.4;
        const border = Math.min(fx + 0.5, fy + 0.5, map.width - 0.5 - fx, map.height - 0.5 - fy) + (vnoise(fx * 1.3, fy * 1.3, 6) - 0.5) * 0.9;
        if (ST && MO && (border > 1.6 || pd < 0.7)) {
          // cobblestone pavers aligned to the iso axes; offset rows, per-stone tone, bevel toward the bottom edge, worn cracks
          const u = fx * 2.4, v = fy * 2.4, row = Math.floor(v), u2 = u + (row & 1) * 0.5, cell = Math.floor(u2), fu = u2 - cell, fv = v - row;
          if (fu < 0.09 || fv < 0.12) col = hash(cell, row, 21) < 0.25 && border < 3 ? G[1] : MO;   // moss in the joints near the grass
          else col = pick(ST, 0.25 + hash(cell, row, 22) * 0.55 + dt * 0.18 - fv * 0.25 - (fu > 0.9 ? 0.2 : 0) - (vnoise(fx * 6, fy * 6, 23) < 0.12 ? 0.3 : 0));
        } else if (pd < pw + dt * 0.12) col = pick(D, fbm(fx * 2.5, fy * 2.5, 4) + dt * 0.3);
        else col = pick(G, n * 1.15 - 0.08 + dt * 0.22 - (pd < pw + 0.25 ? 0.18 : 0));
      }
    } else {
      // cliff below the two front edges: earth strata, darker with depth
      for (let k = PX; k <= CLIFF; k += PX) {
        const t = toTileF(sx, sy - k);
        if (inOuter(t.fx, t.fy)) {
          const band = k / CLIFF + (vnoise(cx * 0.15, k * 0.08, 5) - 0.5) * 0.35 + dither(cx, cy) * 0.15;
          col = k <= PX * 2 ? G[1] : pick(C, band);
          break;
        }
      }
    }
    if (col) { d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255; }
  }
  // detail pass on grass: blades, flowers, pebbles (hashed per art pixel so it's stable between visits)
  const isGrass = (cx: number, cy: number) => { const i = (cy * W + cx) * 4; return d[i + 3] && G.some(g => g[0] === d[i] && g[1] === d[i + 1] && g[2] === d[i + 2]); };
  const put = (cx: number, cy: number, c: number[]) => { if (cx < 0 || cy < 0 || cx >= W || cy >= H) return; const i = (cy * W + cx) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; };
  const FL = th.flowers.map(rgb);
  for (let cy = 3; cy < H - 3; cy++) for (let cx = 2; cx < W - 2; cx++) {
    if (!isGrass(cx, cy)) continue;
    const h = hash(cx, cy, 11);
    // flowers grow in meadows (noise patches), almost none elsewhere
    const patch = vnoise(cx * 0.035, cy * 0.07, 13), fl = patch > 0.66 ? th.flowerRate : th.flowerRate * 0.07;
    if (h < fl && isGrass(cx + 1, cy) && isGrass(cx - 1, cy) && isGrass(cx, cy - 1)) {
      const f = FL[Math.floor(vnoise(cx * 0.05, cy * 0.1, 14) * FL.length * 0.999)];
      put(cx, cy + 1, G[0]); put(cx - 1, cy, f); put(cx + 1, cy, f); put(cx, cy - 1, f); put(cx, cy, [255, 214, 90]);
    } else if (h < 0.09) {                                                    // grass blade: 2-3 px, dark base, lighter tip
      const len = h < 0.03 ? 3 : 2, dark = vnoise(cx * 0.08, cy * 0.16, 15) < 0.45;
      for (let k = 0; k < len; k++) put(cx, cy - k, k === len - 1 ? G[dark ? 2 : 4] : G[dark ? 0 : 1]);
    } else if (h > 0.985) put(cx, cy, G[4]);                                  // sun speck
  }
  ctx.putImageData(img, 0, 0); tex.refresh();
  tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
  return { key, x: minX, y: minY };
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) { ctx.fillStyle = '#' + c.toString(16).padStart(6, '0'); ctx.fillRect(x, y, w, h); }

/** Shared procedural textures for v2 maps: contact shadow, cloud shadow, floating mote (props themselves come from sheets). */
export function makeProps(scene: Phaser.Scene) {
  if (scene.textures.exists('m_shadow')) return;
  const make = (key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
    const t = scene.textures.createCanvas(key, w, h)!; draw(t.getContext()); t.refresh(); t.setFilter(Phaser.Textures.FilterMode.NEAREST);
  };
  // soft contact shadow under props (one texture, scaled per prop)
  make('m_shadow', 32, 12, c => {
    const gr = c.createRadialGradient(16, 6, 1, 16, 6, 16); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.setTransform(1, 0, 0, 0.375, 0, 3.75); c.fillStyle = gr; c.beginPath(); c.arc(16, 6, 16, 0, Math.PI * 2); c.fill();
  });
  make('m_cloud', 64, 32, c => {
    const gr = c.createRadialGradient(32, 16, 2, 32, 16, 30); gr.addColorStop(0, 'rgba(0,0,0,0.9)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.setTransform(1, 0, 0, 0.5, 0, 8); c.fillStyle = gr; c.beginPath(); c.arc(32, 16, 30, 0, Math.PI * 2); c.fill();
  });
  make('m_mote', 3, 3, c => { rect(c, 1, 0, 1, 3, 0xfff6c8); rect(c, 0, 1, 3, 1, 0xfff6c8); });
}

/** Decorative scatter positions (not blocking): tufts and bushes on grass tiles away from paths/portals/spawn. */
export function scatter(map: MapData, blocked: (x: number, y: number) => boolean, n: number, seed: number) {
  const out: [number, number][] = [];
  for (let i = 0; out.length < n && i < n * 20; i++) {
    const x = hash(i, 1, seed) * (map.width - 1), y = hash(i, 2, seed) * (map.height - 1);
    const tx = Math.round(x), ty = Math.round(y);
    if (blocked(tx, ty) || Math.hypot(tx - map.spawn[0], ty - map.spawn[1]) < 2 || map.portals.some(p => Math.hypot(p.x - tx, p.y - ty) < 2)) continue;
    out.push([x, y]);
  }
  return out;
}

/** Make (once) a copy of a prop texture with its foliage moved to another hue. Returns the key to use. */
export function recolored(scene: Phaser.Scene, key: string, rc: Recolor, tag: string) {
  const out = `${key}~${tag}`;
  if (scene.textures.exists(out)) return out;
  const src = scene.textures.get(key).getSourceImage() as HTMLImageElement, w = src.width, h = src.height;
  const tex = scene.textures.createCanvas(out, w, h)!, ctx = tex.getContext();
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 20) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dl = mx - mn;
    if (dl < 0.08) continue;                                          // greys (rocks, snow, outlines) stay
    let hh = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4; hh *= 60; if (hh < 0) hh += 360;
    if (hh < 55 || hh > 175) continue;                                // only foliage greens
    const sat0 = dl / (1 - Math.abs(2 * l - 1)), H = (rc.hue + (hh - 115) * 0.4 + 360) % 360, S = Math.min(1, sat0 * rc.sat), L = Math.min(0.95, l * rc.light);
    const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - c / 2;
    const [r1, g1, b1] = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
    d[i] = (r1 + m) * 255; d[i + 1] = (g1 + m) * 255; d[i + 2] = (b1 + m) * 255;
  }
  ctx.putImageData(img, 0, 0); tex.refresh();
  return out;
}
