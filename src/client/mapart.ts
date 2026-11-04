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

interface Theme { grass: number[]; dirt: number[]; sand: number; water: number[]; cliff: number[]; flowers: number[] }
const MEADOW: Theme = {
  grass: [0x3f7a3a, 0x4d8f3f, 0x5ea546, 0x70b84e, 0x86c95a],
  dirt: [0x7d5a3a, 0x93704a, 0xa9855a, 0xbd9a6a],
  sand: 0xd8c48c,
  water: [0x2f6fae, 0x3f86c6, 0x58a2dc, 0x8fd0f0],
  cliff: [0x6a4a30, 0x5a3e28, 0x4a3220, 0x3a2818],
  flowers: [0xffffff, 0xffe066, 0xff9fc8, 0xb7a2ff],
};

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
  const th = MEADOW, CLIFF = 40;
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
      } else if (wf > 0.3) col = wf > 0.37 ? D[0] : SA;
      else {
        let pd = 9;
        for (const s of segs) pd = Math.min(pd, segDist(fx, fy, s[0], s[1], s[2], s[3]));
        const pw = 0.42 + (vnoise(fx * 1.7, fy * 1.7, 3) - 0.5) * 0.35;
        const n = fbm(fx * 0.32, fy * 0.32, 1) * 0.6 + fbm(fx * 1.6, fy * 1.6, 2) * 0.4;
        if (pd < pw + dt * 0.12) col = pick(D, fbm(fx * 2.5, fy * 2.5, 4) + dt * 0.3);
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
    const patch = vnoise(cx * 0.035, cy * 0.07, 13), fl = patch > 0.66 ? 0.012 : 0.0008;
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
  const LEAF = [0x1f3d22, 0x2d5a2e, 0x3d7a3a, 0x4f9a44, 0x6cb85a, 0x8fd06a];
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
