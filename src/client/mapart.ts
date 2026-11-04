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
export const THEMES: Record<string, Theme> = { grass: MEADOW, stone: TOWN };

/** distance from p to segment ab */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Paint the ground of `map` into a texture. Returns the texture key and the top-left screen position.
 * Tile (x, y) has its centre at screen ((x-y)*TW/2, (x+y)*TH/2).
 */
export function paintGround(scene: Phaser.Scene, map: MapData, isWater: (x: number, y: number) => boolean, TW: number, TH: number) {
  const th = THEMES[map.ground] ?? MEADOW, CLIFF = 40;
  const minX = -map.height * TW / 2 - TW / 2, maxX = map.width * TW / 2 + TW / 2;
  const minY = -TH / 2, maxY = (map.width + map.height) * TH / 2 + TH / 2 + CLIFF;
  const W = Math.ceil((maxX - minX) / PX), H = Math.ceil((maxY - minY) / PX);
  const key = `ground2_${map.id}`;
  if (scene.textures.exists(key)) return { key, x: minX, y: minY };   // deterministic: reuse on revisit
  const tex = scene.textures.createCanvas(key, W, H)!;
  const ctx = tex.getContext(), img = ctx.createImageData(W, H), d = img.data;
  const toTileF = (sx: number, sy: number) => ({ fx: (sx / (TW / 2) + sy / (TH / 2)) / 2, fy: (sy / (TH / 2) - sx / (TW / 2)) / 2 });
  const inside = (fx: number, fy: number) => fx >= -0.5 && fy >= -0.5 && fx <= map.width - 0.5 && fy <= map.height - 0.5;
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
    if (inside(fx, fy)) {
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
        if (inside(t.fx, t.fy)) {
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

// ---- props: shaded pixel blobs (light from the top-left), dark outline ----
interface Circle { x: number; y: number; r: number }
function blob(ctx: CanvasRenderingContext2D, w: number, h: number, circles: Circle[], pal: number[], seed: number) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data, P = pal.map(rgb);
  const inAt = (x: number, y: number) => { let best = -1, bc: Circle | null = null; for (const c of circles) { const q = c.r - Math.hypot(x - c.x, y - c.y); if (q > best) { best = q; bc = c; } } return bc ? { bc, q: best } : null; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = inAt(x + 0.5, y + 0.5); if (!r) continue;
    const i = (y * w + x) * 4;
    const edge = !inAt(x + 1.5, y + 0.5) || !inAt(x - 0.5, y + 0.5) || !inAt(x + 0.5, y + 1.5) || !inAt(x + 0.5, y - 0.5);
    let c: number[];
    if (edge) c = P[0];
    else {
      const nx = (x - r.bc.x) / r.bc.r, ny = (y - r.bc.y) / r.bc.r;           // local normal
      const lit = 0.55 - nx * 0.35 - ny * 0.45 + (hash(x, y, seed) - 0.5) * 0.18 + dither(x, y) * 0.2;
      c = pick(P.slice(1), lit);
    }
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) { ctx.fillStyle = '#' + c.toString(16).padStart(6, '0'); ctx.fillRect(x, y, w, h); }

/** Make the meadow prop textures once. Keys: m_oak0..2, m_pine, m_bush, m_rock, m_tuft, m_cloud. Origins: bottom centre. */
export function makeProps(scene: Phaser.Scene) {
  if (scene.textures.exists('m_oak0')) return;
  const make = (key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
    const t = scene.textures.createCanvas(key, w, h)!; draw(t.getContext()); t.refresh(); t.setFilter(Phaser.Textures.FilterMode.NEAREST);
  };
  const LEAF = [0x22381f, 0x2f4f2c, 0x3d6438, 0x4b7843, 0x5e8b51, 0x76a062];
  for (let k = 0; k < 3; k++) make(`m_oak${k}`, 40, 52, c => {
    // trunk with bark shading, roots
    rect(c, 17, 30, 6, 20, 0x3a2616); rect(c, 18, 30, 4, 20, 0x5a3a22); rect(c, 18, 30, 1, 20, 0x74502e); rect(c, 15, 48, 10, 2, 0x3a2616);
    const cs: Circle[] = [{ x: 20, y: 20, r: 13 }, { x: 11 + k, y: 25, r: 9 }, { x: 29 - k, y: 24, r: 9 }, { x: 20, y: 11 + k, r: 9 }, { x: 14, y: 15, r: 7 }];
    blob(c, 40, 52, cs, LEAF, 20 + k);
  });
  make('m_pine', 32, 56, c => {
    rect(c, 14, 44, 4, 10, 0x3a2616); rect(c, 15, 44, 2, 10, 0x5a3a22);
    const cs: Circle[] = []; for (let i = 0; i < 6; i++) cs.push({ x: 16, y: 40 - i * 6, r: 12 - i * 1.7 });
    blob(c, 32, 56, cs, [0x16301f, 0x1f4a2c, 0x2b6338, 0x3a7d44, 0x52985a], 31);
  });
  make('m_bush', 26, 16, c => blob(c, 26, 16, [{ x: 8, y: 9, r: 6 }, { x: 17, y: 9, r: 7 }, { x: 13, y: 6, r: 5 }], LEAF, 41));
  make('m_rock', 24, 16, c => {
    blob(c, 24, 16, [{ x: 10, y: 9, r: 7 }, { x: 16, y: 10, r: 5 }], [0x3a3f4a, 0x5f6674, 0x7b8291, 0x989fad, 0xbcc2cc], 51);
    rect(c, 7, 3, 4, 1, 0x5e9a46); rect(c, 6, 4, 3, 1, 0x4d8f3f);   // moss
  });
  make('m_tuft', 10, 8, c => {
    const g = [0x3f7a3a, 0x5ea546, 0x86c95a];
    for (const [x, hh, ci] of [[1, 4, 0], [3, 7, 1], [5, 5, 2], [7, 6, 1], [8, 3, 0]]) rect(c, x, 8 - hh, 1, hh, g[ci]);
  });
  // soft cloud shadow (radial alpha), drawn small and scaled up
  make('m_cloud', 64, 32, c => {
    const gr = c.createRadialGradient(32, 16, 2, 32, 16, 30); gr.addColorStop(0, 'rgba(0,0,0,0.9)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.setTransform(1, 0, 0, 0.5, 0, 8); c.fillStyle = gr; c.beginPath(); c.arc(32, 16, 30, 0, Math.PI * 2); c.fill();
  });
  // town props
  make('m_lamp', 10, 40, c => {
    rect(c, 4, 10, 2, 28, 0x2b2a30); rect(c, 4, 10, 1, 28, 0x4a4852); rect(c, 2, 37, 6, 3, 0x2b2a30);
    rect(c, 2, 2, 6, 8, 0x2b2a30); rect(c, 3, 3, 4, 6, 0xffd77a); rect(c, 3, 3, 2, 3, 0xfff2c4); rect(c, 1, 1, 8, 2, 0x3a3842);
  });
  make('m_crate', 16, 16, c => {
    rect(c, 1, 3, 14, 12, 0x4a3320); rect(c, 2, 4, 12, 10, 0x8a6440); rect(c, 2, 4, 12, 2, 0xa57a50); rect(c, 7, 4, 2, 10, 0x6d4d30); rect(c, 2, 8, 12, 1, 0x6d4d30);
  });
  make('m_barrel', 14, 18, c => {
    rect(c, 2, 1, 10, 16, 0x3e2a1a); rect(c, 3, 2, 8, 14, 0x7a5434); rect(c, 3, 2, 3, 14, 0x956a42); rect(c, 2, 5, 10, 1, 0x55555e); rect(c, 2, 12, 10, 1, 0x55555e); rect(c, 4, 1, 6, 2, 0x5a3e26);
  });
  make('m_flowerpot', 14, 14, c => {
    blob(c, 14, 10, [{ x: 4, y: 5, r: 4 }, { x: 9, y: 5, r: 4 }, { x: 7, y: 3, r: 3 }], LEAF, 61);
    rect(c, 4, 4, 1, 1, 0xe0a6bf); rect(c, 8, 3, 1, 1, 0xe8d27a); rect(c, 10, 6, 1, 1, 0xe0a6bf);
    rect(c, 2, 9, 10, 5, 0x6a3e2a); rect(c, 3, 9, 8, 1, 0x8e573a);
  });
  for (const [k, a, b2] of [['red', 0xa8453e, 0xe6ddd0], ['blue', 0x3e64a8, 0xe6ddd0], ['green', 0x3e8a5a, 0xe6ddd0]] as [string, number, number][]) make(`m_stall_${k}`, 40, 34, c => {
    // striped awning on two posts over a counter (the NPC stands behind it)
    rect(c, 3, 8, 2, 24, 0x4a3320); rect(c, 35, 8, 2, 24, 0x4a3320);
    for (let i = 0; i < 8; i++) rect(c, 1 + i * 5, 2, 5, 7, i % 2 ? b2 : a);
    rect(c, 1, 2, 38, 1, 0x2a1f18); rect(c, 1, 8, 38, 1, 0x2a1f18);
    for (let i = 0; i < 8; i++) rect(c, 2 + i * 5, 9, 3, 1, i % 2 ? b2 : a);
    rect(c, 2, 22, 36, 11, 0x4a3320); rect(c, 3, 23, 34, 9, 0x8a6440); rect(c, 3, 23, 34, 2, 0xa57a50); rect(c, 3, 27, 34, 1, 0x6d4d30);
  });
  // soft contact shadow under props (one texture, scaled per prop)
  make('m_shadow', 32, 12, c => {
    const gr = c.createRadialGradient(16, 6, 1, 16, 6, 16); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.setTransform(1, 0, 0, 0.375, 0, 3.75); c.fillStyle = gr; c.beginPath(); c.arc(16, 6, 16, 0, Math.PI * 2); c.fill();
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
