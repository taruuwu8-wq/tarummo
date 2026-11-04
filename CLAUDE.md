# Nostaru — working rules for Claude

Web MMORPG for 3-5 friends (NosTale-inspired systems, own names/art). Owner writes in Thai; reply in Thai.

## Workflow (owner's standing requests)
- **Save quota**: small focused patches, test only what changed (one playtest script per change), no repeated runs of passing checks.
- **Do NOT publish the Claude artifact anymore.** The owner plays via GitHub Pages; pushing to `main` deploys it (.github/workflows/pages.yml).
- **After every feature: performance pass.** Look for per-frame work (Graphics redraws, DOM writes, allocations, particles), per-tick O(n²) loops, and snapshot size. Fix cheap wins; note bigger ones in LATER.md.
  Headless Chromium here renders on CPU (~17-25 fps regardless), so FPS numbers from it are not meaningful; reason about work done instead.
- **Keep LATER.md up to date**: anything deferred, placeholder, or to tune later goes there.
- Mention things that should be fixed/adjusted when you notice them.
- Commit with the attribution lines from the session; push with retry (GitHub sometimes returns 500).

## Layout
- `src/core/` pure combat/stat math · `src/sim/world.ts` authoritative world (runs in browser offline and on the server)
- `src/client/` Phaser scene + DOM HUD (hud.ts, hotbar.ts, autopanel.ts, itemtext.ts) · `server/index.ts` Node + ws
- `data/*.json` all tunables (classes, skills, cards, items, monsters, maps, options, rarity, statuses, upgrade, balance)
- Test servers: `npx vite preview --port 4175` (offline mode) and `PORT=8090 node --import tsx server/index.ts` (online).
  Kill old servers by PID before starting new ones (EADDRINUSE leaves the old code running). `window.__scene` exposes the scene for playtests.
