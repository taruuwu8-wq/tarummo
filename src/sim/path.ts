// A* on a tile grid, 8 directions, no corner cutting.
export type Tile = [number, number];

export function findPath(
  walkable: (x: number, y: number) => boolean,
  from: Tile, to: Tile, maxNodes = 4000,
): Tile[] | null {
  const key = (x: number, y: number) => y * 10000 + x;
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to[0]), dy = Math.abs(y - to[1]);
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
  };
  const open: { x: number; y: number; f: number }[] = [{ x: from[0], y: from[1], f: h(from[0], from[1]) }];
  const g = new Map<number, number>([[key(from[0], from[1]), 0]]);
  const came = new Map<number, number>();
  let seen = 0;
  while (open.length && seen++ < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.x === to[0] && cur.y === to[1]) {
      const out: Tile[] = [];
      let k = key(cur.x, cur.y);
      while (k !== key(from[0], from[1])) { out.push([k % 10000, Math.floor(k / 10000)]); k = came.get(k)!; }
      return out.reverse();
    }
    const cg = g.get(key(cur.x, cur.y))!;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!walkable(nx, ny)) continue;
      if (dx && dy && (!walkable(cur.x + dx, cur.y) || !walkable(cur.x, cur.y + dy))) continue;
      const ng = cg + (dx && dy ? 1.414 : 1), nk = key(nx, ny);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng); came.set(nk, key(cur.x, cur.y));
        open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}
