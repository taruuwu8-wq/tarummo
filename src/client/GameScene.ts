import Phaser from 'phaser';
import { World, TICK_MS, Entity, MapData, Defs, GameEvent } from '../sim/world';
import { loadDefs, MAPS } from '../data';
import type { SaveData } from '../sim/world';
import { writeSave, readStash, writeStash, readUnlocks, writeUnlocks } from './save';
import type { Net } from './net';
import type { Intent } from '../sim/world';
import { Hud } from './hud';
import { paintGround, makeProps, scatter, PX, MARGIN } from './mapart';
import PROPS from '../../data/props.json';

const TW = 64, TH = 32;
/** visible body height / max width (px) for players + card forms, and for town NPCs (a bit smaller so they don't crowd) */
const PLAYER_CORE = 56, PLAYER_MAXW = 60, NPC_CORE = 46, NPC_MAXW = 52;
const defs = loadDefs();

// Save on tab hide/close. Registered once; points at whichever scene is current.
let saveNow: () => void = () => {};
window.addEventListener('pagehide', () => saveNow());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

export interface SceneData { net?: Net; cls: string; save?: SaveData; map?: string; at?: [number, number]; vitals?: { hp: number; mp: number } }

const fmtTime = (ms: number) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const toScreen = (x: number, y: number) => ({ sx: (x - y) * (TW / 2), sy: (x + y) * (TH / 2) });
const toTile = (sx: number, sy: number) => ({
  x: Math.round((sx / (TW / 2) + sy / (TH / 2)) / 2),
  y: Math.round((sy / (TH / 2) - sx / (TW / 2)) / 2),
});

interface View {
  body: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Ellipse; bar: Phaser.GameObjects.Graphics;
  aura?: Phaser.GameObjects.Ellipse;
  fxSig?: string; sparks?: Phaser.GameObjects.Particles.ParticleEmitter; ring?: Phaser.GameObjects.Ellipse; ringLv?: number;
  wings?: Phaser.GameObjects.Container;
  rareSparks?: Phaser.GameObjects.Particles.ParticleEmitter; rareGlow?: Phaser.FX.Glow; pillar?: Phaser.GameObjects.Image; rareLv?: number;
  barFill?: number;
  bubble?: Phaser.GameObjects.Text; bubbleUntil?: number;
  formKey?: string; tint?: number; stKey?: string; stIcons?: Phaser.GameObjects.Text; mount?: Phaser.GameObjects.Image; mountLook?: string; dust?: Phaser.GameObjects.Particles.ParticleEmitter;
  scale: number; phase: number; lunge: number; lungeDir: { x: number; y: number }; height: number;
  /** procedural animation state: hit recoil, turn squish, spawn pop, death fall (all 1 → 0 or 0 → 1), last step index */
  hitT: number; flipT: number; popT: number; dieT: number; face: number; step: number;
}

export class GameScene extends Phaser.Scene {
  private world!: World;
  private player!: Entity;
  private views = new Map<number, View>();
  private acc = 0;
  private hover!: Phaser.GameObjects.Graphics;
  private marker!: Phaser.GameObjects.Graphics;
  private ring!: Phaser.GameObjects.Graphics;
  private hud!: Hud;
  private puffs?: Phaser.GameObjects.Particles.ParticleEmitter;
  /** swaying decor (v2 maps) and drifting cloud shadows */
  private sway: { o: Phaser.GameObjects.Image; ph: number; amp: number }[] = [];
  private clouds: Phaser.GameObjects.Image[] = [];
  private bounds = { x0: 0, x1: 0, y0: 0, y1: 0 };

  constructor() { super('game'); }

  preload() {
    for (const d of [...Object.values(defs.classes), ...Object.values(defs.monsters), ...Object.values(defs.cards), ...Object.values(defs.npcs)]) if (d.sprite) this.load.image(d.sprite, `sprites/${d.sprite}.png`);
    for (const id of Object.keys(PROPS)) if (id !== '_note') this.load.image(`p_${id}`, `props/${id}.png`);
  }

  private leaving = false;
  private hudErr = false;
  private net?: Net;
  private act: (i: Intent) => void = () => {};
  private names = new Map<number, Phaser.GameObjects.Text>();
  private autoRing?: Phaser.GameObjects.Graphics;
  private doorViews: { room: number; imgs: Phaser.GameObjects.Image[] }[] = [];
  private portalLabels: { p: { to: string; label: string; minLevel?: number }; t: Phaser.GameObjects.Text }[] = [];
  private gated: { objs: Phaser.GameObjects.GameObject[] }[] = [];

  create(data: SceneData) {
    this.views.clear(); this.names.clear(); this.autoRing = undefined; this.doorViews = []; this.gated = []; this.portalLabels = []; this.sway = []; this.clouds = []; this.acc = 0; this.leaving = false; this.net = data.net;
    (window as unknown as { __scene: GameScene }).__scene = this;  // handy for automated playtests
    const net = data.net;
    const map = MAPS[net ? net.map : data.map ?? data.save?.map ?? 'town'] ?? MAPS.town;
    if (net) {
      // online: this World is only a mirror of the server's room
      this.world = new World(structuredClone(map), defs, 1, { mirror: true });
      this.world.applySnapshot(net.last!.now, net.last!.ents);
      this.player = this.world.entities.get(net.myId)!;
      net.queue.length = 0;
      this.act = i => net.intent(i);
    } else {
      this.world = new World(structuredClone(map), defs, Date.now() & 0xffff, { stash: readStash(), unlocks: readUnlocks() });
      this.player = this.world.spawnPlayer(data.cls ?? 'swordsman', data.save, data.at, data.vitals);
      this.act = i => this.world.apply(i);
    }

    // tiny 4-point star used by upgrade sparkles
    const sg = this.make.graphics({}, false);
    sg.fillStyle(0xffffff, 1).fillPoints([{ x: 4, y: 0 }, { x: 5, y: 3 }, { x: 8, y: 4 }, { x: 5, y: 5 }, { x: 4, y: 8 }, { x: 3, y: 5 }, { x: 0, y: 4 }, { x: 3, y: 3 }], true);
    sg.generateTexture('spark', 8, 8); sg.destroy();
    if (!this.textures.exists('dust')) { const dg = this.make.graphics({}, false); dg.fillStyle(0xffffff, 1).fillCircle(4, 4, 4); dg.generateTexture('dust', 8, 8); dg.destroy(); }
    // footstep dust, shared by everyone (explode() on each landing)
    this.puffs = this.add.particles(0, 0, 'dust', { emitting: false, lifespan: 380, speedX: { min: -28, max: 28 }, speedY: { min: -14, max: -4 },
      scale: { start: 0.7, end: 0 }, alpha: { start: 0.45, end: 0 }, tint: 0xe6d8b8 }).setDepth(8);
    this.drawGround(map);
    this.hover = this.add.graphics().setDepth(1);
    this.marker = this.add.graphics().setDepth(1).setAlpha(0);
    this.ring = this.add.graphics().setDepth(2);
    for (const e of this.world.entities.values()) this.makeView(e);

    const cam = this.cameras.main;
    cam.setZoom(window.innerWidth < 600 ? 1.15 : 1.5);
    cam.startFollow(this.views.get(this.player.id)!.body, true, 0.12, 0.12);

    this.hud = new Hud(this.world, this.player, defs.items, i => this.act(i));
    const save = () => { writeSave(this.world.save(this.player)); writeStash(this.world.stash); writeUnlocks(this.world.unlocks); };
    if (!net) { saveNow = save; this.time.addEvent({ delay: 5000, loop: true, callback: save }); }
    this.events.once('shutdown', () => this.hud.destroy());
    this.drawPortals(map); this.drawNpcs(map);
    this.banner(map.name + (map.safe ? ' · เขตปลอดภัย' : ''));

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.drawHover(p));
    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      const npc = over.find(o => o.getData('npc') !== undefined);
      if (npc) { this.act({ kind: 'talk', id: this.player.id, npc: npc.getData('npc') }); return; }
      const hit = over.find(o => o.getData('id') !== undefined);
      if (hit) {
        const id = hit.getData('id') as number;
        if (id !== this.player.id) { this.act({ kind: 'attack', id: this.player.id, target: id }); return; }
      }
      const { x, y } = toTile(p.worldX, p.worldY);
      if (!this.world.walkable(x, y)) return;
      this.act({ kind: 'move', id: this.player.id, to: [x, y] });
      this.showMarker(x, y);
    });
  }

  private reportErr(err: unknown) { console.error(err); if (!this.hudErr) { this.hudErr = true; this.hud.toast('เกิดข้อผิดพลาด (ดู console) — เกมยังเล่นต่อได้', 'warn'); } }

  update(_t: number, dtMs: number) {
    // use real elapsed time: Phaser smooths delta, which slows the sim down on low-FPS devices
    if (this.leaving) return;
    dtMs = this.game.loop.rawDelta;
    this.acc += Math.min(dtMs, 1000);
    if (this.net) this.drainNet();
    else while (this.acc >= TICK_MS) {
      this.world.tick(); this.acc -= TICK_MS;
      // events are always cleared, and one bad event can't stop the loop (it froze the game on dungeon entry)
      const evs = this.world.events.splice(0);
      for (const ev of evs) { try { this.onEvent(ev); } catch (err) { this.reportErr(err); } if (this.leaving) return; }
    }
    if (this.leaving) return;
    const alpha = Math.min(1, this.acc / TICK_MS), now = this.time.now / 1000;
    for (const e of this.world.entities.values()) { if (!this.views.has(e.id)) this.makeView(e); this.syncView(e, alpha, now, dtMs); }
    this.animDecor(now, dtMs);
    for (const [id, v] of this.views) if (!this.world.entities.has(id)) {
      v.body.destroy(); v.shadow.destroy(); v.bar.destroy(); v.stIcons?.destroy(); v.bubble?.destroy(); v.rareSparks?.destroy(); v.pillar?.destroy(); v.aura?.destroy(); v.sparks?.destroy(); v.ring?.destroy(); v.wings?.destroy(); v.mount?.destroy(); v.dust?.destroy();
      this.views.delete(id); this.names.get(id)?.destroy(); this.names.delete(id);
    }
    this.drawTargetRing();
    this.drawAutoRange();
    const dg = this.world.dungeon;
    for (const { p, t } of this.portalLabels) {
      const open = this.world.unlocks.includes(p.to) || this.player.level >= (p.minLevel ?? 0);
      t.setText(`${open ? '⟡' : '🔒'} ${p.label}${open ? '' : ` (ต้อง Lv ${p.minLevel})`}`).setColor(open ? '#d9d0ff' : '#ff9f9f');
    }
    for (const d of this.doorViews) for (const im of d.imgs) im.setVisible(!dg.openDoors.includes(d.room));
    for (const g of this.gated) for (const o of g.objs) (o as unknown as Phaser.GameObjects.Components.Visible).setVisible(dg.cleared);
    const tgt = this.player.target != null ? this.world.entities.get(this.player.target) ?? null : null;
    // a HUD error must never freeze the game loop
    try { this.hud.update(this.world.xpNeeded(this.player), tgt); }
    catch (err) { this.reportErr(err); }
  }

  private drainNet() {
    const net = this.net!;
    while (net.queue.length && !this.leaving) {
      const m = net.queue.shift()!;
      if (m.t === 'welcome') {
        // moved to another map: restart once the new room's first snapshot arrives
        this.leaving = true;
        const wait = () => { if (net.last && net.queue.some(q => q.t === 'tick')) { net.queue.length = 0; this.scene.restart({ net, cls: net.cls }); } else this.time.delayedCall(30, wait); };
        this.cameras.main.fadeOut(200, 27, 31, 42); wait();
      } else if (m.t === 'tick') {
        this.world.applySnapshot(m.now, m.ents); this.world.stash = m.stash; this.world.dungeon = m.dungeon; this.world.unlocks = m.unlocks; this.acc = 0;
        for (const ev of m.ev) { try { this.onEvent(ev); } catch (err) { this.reportErr(err); } }
      } else if (m.t === 'error') this.hud.toast(m.text, 'warn');
    }
  }

  /**
   * Scale that gives every character the same visible body size: measure the "core" (rows at least 35% as wide as the
   * widest row, so spiky hair, antennae, raised weapons and thin wing tips don't count), fit that to `core` px tall,
   * and never let the whole sprite get wider than `maxW`. Cached per texture.
   */
  private sizeCache = new Map<string, { core: number; w: number; h: number }>();
  private fitScale(key: string, core: number, maxW: number) {
    let m = this.sizeCache.get(key);
    if (!m) {
      const src = this.textures.get(key).getSourceImage() as HTMLImageElement, w = src.width, h = src.height;
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d')!; ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, w, h).data, rows: number[] = [];
      for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 40) n++; rows.push(n); }
      const lim = Math.max(...rows) * 0.35, top = rows.findIndex(n => n >= lim);
      let bot = h - 1; while (bot > 0 && rows[bot] < lim * 0.5) bot--;
      m = { core: Math.max(8, bot - top + 1), w, h };
      this.sizeCache.set(key, m);
    }
    const sc = Math.min(core / m.core, maxW / m.w);
    return { scale: sc, height: m.h * sc };
  }

  private makeView(e: Entity) {
    const d = e.kind === 'player' ? defs.classes[e.type] : defs.monsters[e.type];
    const body = this.add.image(0, 0, d.sprite).setOrigin(0.5, 1).setInteractive({ useHandCursor: e.kind === 'monster', pixelPerfect: false });
    body.setData('id', e.id);
    // players (and their card forms) share one body size; monsters keep their designed height
    const fit = e.kind === 'player' ? this.fitScale(d.sprite, PLAYER_CORE, PLAYER_MAXW) : { scale: d.height / body.height, height: d.height };
    const scale = fit.scale;
    const shadow = this.add.ellipse(0, 0, Math.min(46, body.width * scale * 0.6), 10, 0x000000, 0.28);
    const bar = this.add.graphics();
    const tint = 'tint' in d && d.tint ? parseInt(d.tint as string, 16) : undefined;
    if (tint) body.setTint(tint);
    this.views.set(e.id, { body, shadow, bar, scale, tint, phase: Math.random() * 6, lunge: 0, lungeDir: { x: 0, y: 0 }, height: fit.height, hitT: 0, flipT: 0, popT: 1, dieT: 0, face: e.facing, step: 0 });
  }

  private syncView(e: Entity, alpha: number, now: number, dtMs: number) {
    const v = this.views.get(e.id)!;
    const { sx, sy } = toScreen(e.px + (e.x - e.px) * alpha, e.py + (e.y - e.py) * alpha);
    // ---- procedural animation (single still sprite): breathe, hop-walk with lean + squash, wind-up lunge, recoil, turn, pop, fall ----
    const dt = dtMs / 1000;
    const held = !e.dead && (e.statuses ?? []).some(st => (st.type === 'freeze' || st.type === 'stun') && st.until > this.world.now);
    let bob = 0, sqx = 1, sqy = 1, rot = 0, shake = 0;
    if (held) { /* frozen / stunned: no motion */ }
    else if (e.moving) {
      const t = now * 9 + v.phase, s = Math.abs(Math.sin(t)), land = Math.pow(1 - s, 6);
      bob = -s * 6;
      sqy = 1 + s * 0.05 - land * 0.09; sqx = 1 - s * 0.03 + land * 0.08;
      rot = e.facing * 0.06 + Math.sin(t) * 0.035;
      const step = Math.floor(t / Math.PI);
      if (step !== v.step) { v.step = step; if (!e.mounted && !e.dead) this.puffs?.explode(2, sx, sy + 2); }
    } else {
      const b = Math.sin(now * 2.2 + v.phase);
      sqy = 1 + b * 0.03; sqx = 1 - b * 0.018; rot = Math.sin(now * 0.9 + v.phase * 1.3) * 0.02;
    }
    v.lunge = Math.max(0, v.lunge - dtMs / 260);
    const l = Math.sin(v.lunge * Math.PI) * 10;
    if (v.lunge > 0) {
      const p = 1 - v.lunge, dir = Math.sign(v.lungeDir.x) || e.facing;
      rot += p < 0.3 ? -dir * 0.16 * (p / 0.3) : dir * 0.2 * Math.sin((p - 0.3) / 0.7 * Math.PI);
      sqx *= 1 + Math.sin(p * Math.PI) * 0.08; sqy *= 1 - Math.sin(p * Math.PI) * 0.04;
    }
    if (v.hitT > 0) {
      v.hitT = Math.max(0, v.hitT - dt / 0.25);
      shake = Math.sin(v.hitT * 40) * 4 * v.hitT; sqy *= 1 - v.hitT * 0.08; sqx *= 1 + v.hitT * 0.06; rot -= e.facing * v.hitT * 0.12;
    }
    if (v.face !== e.facing) { v.face = e.facing; v.flipT = 1; }
    v.flipT = Math.max(0, v.flipT - dt / 0.14);
    v.popT = Math.max(0, v.popT - dt / 0.35);
    const k = 1 - v.popT, pop = 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);   // easeOutBack 0 → 1
    v.dieT = e.dead ? Math.min(1, v.dieT + dt / 0.4) : 0;
    if (v.dieT > 0) rot = e.facing * 1.35 * (1 - Math.pow(1 - v.dieT, 3));
    if (e.kind === 'player') this.syncForm(e, v);
    const lift = e.mounted ? -10 + Math.sin(now * 3) * 2 : 0;
    if (e.mounted) { bob *= 0.3; rot *= 0.3; }
    const x = sx + v.lungeDir.x * l + shake, y = sy + 3 + bob + lift + v.lungeDir.y * l + v.dieT * 4;
    v.body.setRotation(rot);
    sqx *= pop * (1 - v.flipT * 0.8); sqy *= pop;
    v.body.setPosition(x, y).setScale(v.scale * sqx * e.facing, v.scale * sqy);
    v.shadow.setPosition(sx, sy + 1).setScale((1 + bob / 30) * pop);
    v.body.setDepth(10 + sy); v.shadow.setDepth(2);
    if (v.mount) v.mount.setPosition(sx, y + 4).setDepth(v.body.depth - 0.2).setScale(v.mountLook === 'cloud' ? 1 + Math.sin(now * 5) * 0.03 : 1).setVisible(!e.dead);
    if (v.dust) { v.dust.setPosition(sx, sy + 2).setDepth(v.body.depth - 0.3); v.dust.emitting = e.moving && !e.dead; }
    if (v.aura) { v.aura.setPosition(sx, sy + 1).setVisible(!e.dead).setScale(1 + Math.sin(now * 4) * 0.08); }
    if (e.kind === 'player') this.syncGearFx(e, v, x, y, sx, sy, now);
    v.body.setVisible(!e.dead || v.body.alpha > 0.01); v.shadow.setVisible(!e.dead);
    if (this.net && e.kind === 'player') {
      let t = this.names.get(e.id);
      if (!t) { t = this.add.text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold', color: e.id === this.player.id ? '#ffe066' : '#9be7ff', stroke: '#1b1f2a', strokeThickness: 3 }).setOrigin(0.5).setResolution(2); this.names.set(e.id, t); }
      t.setText(`${e.name} Lv${e.level}`).setPosition(x, y - v.height * sqy - 18).setDepth(9600);
    }

    this.syncStatus(e, v, x, y - v.height * sqy - 18);
    if (v.bubble?.visible) {
      const left = (v.bubbleUntil ?? 0) - this.time.now;
      if (left <= 0) v.bubble.setVisible(false);
      else v.bubble.setPosition(x, y - v.height * sqy - (this.net && e.kind === 'player' ? 34 : 20)).setAlpha(Math.min(1, left / 400));
    }
    // HP bar: geometry is rebuilt only when the filled width changes; moving is just setPosition
    const showBar = !e.dead && (e.kind === 'player' || e.hp < e.maxHp || this.player.target === e.id);
    v.bar.setVisible(showBar);
    if (showBar) {
      const w = e.boss ? 56 : 34, fill = Math.round(w * (e.hp / e.maxHp));
      if (fill !== v.barFill) {
        v.barFill = fill;
        v.bar.clear().fillStyle(0x000000, 0.6).fillRect(-w / 2 - 1, -1, w + 2, 6);
        v.bar.fillStyle(e.kind === 'player' ? 0x5be37a : 0xe5484d, 1).fillRect(-w / 2, 0, fill, 4);
      }
      v.bar.setPosition(sx, Math.round(y - v.height * sqy - 8)).setDepth(5000 + sy);
    }
  }

  /** Status icons above the head + body tint (freeze > stun > burn > slow > bleed). */
  private syncStatus(e: Entity, v: View, x: number, y: number) {
    const now = this.world.now, act = (e.statuses ?? []).filter(st => st.until > now).map(st => st.type);
    const key = e.dead ? '' : act.join(',');
    if (key !== v.stKey) {
      v.stKey = key;
      const order = ['freeze', 'stun', 'burn', 'slow', 'bleed'] as const, top = order.find(t => act.includes(t));
      if (top) v.body.setTint(parseInt(defs.statuses[top].tint, 16)); else { v.body.clearTint(); if (v.tint) v.body.setTint(v.tint); }
      v.stIcons?.destroy(); v.stIcons = undefined;
      if (key) v.stIcons = this.add.text(0, 0, act.map(t => defs.statuses[t].icon).join(''), { fontSize: '13px' }).setOrigin(0.5, 1).setResolution(2);
    }
    if (v.stIcons) v.stIcons.setPosition(x, y - (this.net && e.kind === 'player' ? 12 : 0)).setDepth(9650);
  }

  /** Sprite/aura for card form + mount visuals. Runs every frame; only rebuilds when the key changes. */
  private syncForm(e: Entity, v: View) {
    const card = this.world.cardOf(e), mount = e.mounted && e.equip.mount ? defs.items[e.equip.mount.item].mount : undefined;
    const key = `${card?.sprite ?? ''}|${mount?.look ?? ''}`;
    if (key === v.formKey) return;
    v.formKey = key;
    const base = defs.classes[e.type];
    const sprite = card ? card.sprite : base.sprite;
    if (v.body.texture.key !== sprite) { v.body.setTexture(sprite); }
    const fit = this.fitScale(sprite, PLAYER_CORE, PLAYER_MAXW);
    v.scale = fit.scale; v.height = fit.height;
    v.aura?.destroy(); v.aura = undefined;
    if (card) v.aura = this.add.ellipse(0, 0, 56, 26, parseInt(card.aura, 16), 0.35).setDepth(2).setStrokeStyle(2, parseInt(card.aura, 16), 0.9);
    v.mount?.destroy(); v.mount = undefined; v.dust?.destroy(); v.dust = undefined; v.mountLook = mount?.look;
    if (mount) {
      const tex = mount.sprite && this.textures.exists(mount.sprite) ? mount.sprite : `mount_${mount.look}`;
      if (!this.textures.exists(tex)) this.makeMountTexture(mount.look, parseInt(mount.color, 16));
      v.mount = this.add.image(0, 0, tex).setOrigin(0.5, 0.7);
      v.dust = this.add.particles(0, 0, 'spark', { frequency: 70, lifespan: 500, speedX: { min: -20, max: 20 }, speedY: { min: -10, max: 0 },
        scale: { start: 0.8, end: 0 }, alpha: { start: 0.7, end: 0 }, tint: mount.look === 'cloud' ? 0xffffff : 0xffd23f });
    }
  }

  /** Placeholder mount art drawn in code (swap for a PNG via items.json mount.sprite). */
  private makeMountTexture(look: string, color: number) {
    const g = this.make.graphics({}, false);
    if (look === 'cloud') {
      g.translateCanvas(40, 22);
      g.fillStyle(0xdfe8ff, 1).fillEllipse(0, 6, 64, 18);
      g.fillStyle(color, 1); for (const [x, y, r] of [[-20, 0, 12], [-6, -5, 15], [10, -3, 13], [22, 3, 10], [0, 6, 14]]) g.fillCircle(x, y, r);
      g.generateTexture('mount_cloud', 80, 44);
    } else {
      g.translateCanvas(40, 20);
      g.fillStyle(0x000000, 0.25).fillEllipse(0, 10, 70, 14);
      g.fillStyle(color, 1).fillPoints([{ x: -34, y: 0 }, { x: 0, y: -14 }, { x: 34, y: 0 }, { x: 0, y: 14 }], true);
      g.lineStyle(2, 0xffd23f, 1).strokePoints([{ x: -30, y: 0 }, { x: 0, y: -12 }, { x: 30, y: 0 }, { x: 0, y: 12 }], true);
      g.fillStyle(0xffd23f, 1).fillCircle(0, 0, 3);
      g.generateTexture('mount_carpet', 80, 40);
    }
    g.destroy();
  }

  private tier<T extends { min: number }>(tiers: T[], lv: number): T | undefined {
    let t: T | undefined; for (const x of tiers) if (lv >= x.min) t = x; return t;
  }

  // Upgrade visuals: weapon +N -> sparkles, armor +N -> ground aura, card +N (while transformed) -> wings.
  private syncGearFx(e: Entity, v: View, x: number, y: number, sx: number, sy: number, now: number) {
    const wUp = e.equip.weapon?.up ?? 0, aUp = e.equip.armor?.up ?? 0, cUp = e.transformed ? e.equip.card?.up ?? 0 : 0;
    const rLv = Math.max(e.equip.weapon?.rare ?? 0, e.equip.offhand?.rare ?? 0, e.equip.armor?.rare ?? 0);
    const sig = `${wUp}|${aUp}|${cUp}|${v.height}|${rLv}`;
    const u = defs.upgrade;
    if (sig !== v.fxSig) {
      v.fxSig = sig;
      v.sparks?.destroy(); v.sparks = undefined;
      const gt = this.tier(u.glowTiers, wUp);
      if (gt && gt.rate > 0) {
        v.sparks = this.add.particles(0, 0, 'spark', {
          frequency: 1000 / gt.rate, lifespan: 900, quantity: 1,
          x: { min: -16, max: 16 }, y: { min: -v.height * 0.9, max: -6 },
          speedY: { min: -28, max: -8 }, speedX: { min: -8, max: 8 },
          scale: { start: wUp >= 9 ? 1.4 : 1, end: 0 }, alpha: { start: 1, end: 0 },
          tint: parseInt(gt.color, 16), blendMode: 'ADD',
        });
      }
      v.ring?.destroy(); v.ring = undefined; v.ringLv = aUp;
      const at = this.tier(u.glowTiers, aUp);
      if (at) v.ring = this.add.ellipse(0, 0, 50 + aUp * 2, 22 + aUp, parseInt(at.color, 16), 0.08 + aUp * 0.02)
        .setStrokeStyle(aUp >= 7 ? 3 : 2, parseInt(at.color, 16), 0.35 + aUp * 0.05).setDepth(2);
      v.wings?.destroy(); v.wings = undefined;
      const wt = this.tier(u.wingTiers, cUp);
      if (wt) v.wings = this.makeWings(wt, v.height);
      // rare visuals: sparks from the feet, outline glow (R5+), light pillar (R7)
      v.rareSparks?.destroy(); v.rareSparks = undefined; v.pillar?.destroy(); v.pillar = undefined;
      v.body.preFX?.clear(); v.rareGlow = undefined; v.rareLv = rLv;
      const rt = this.tier(defs.rarity.fx, rLv);
      if (rt) {
        const col = parseInt(rt.color, 16);
        v.rareSparks = this.add.particles(0, 0, 'spark', {
          frequency: 1000 / rt.sparks, lifespan: 1100, quantity: 1, x: { min: -20, max: 20 }, y: { min: -4, max: 4 },
          speedY: { min: -60, max: -25 }, speedX: { min: -6, max: 6 }, scale: { start: rLv >= 7 ? 1.6 : 1.1, end: 0 }, alpha: { start: 1, end: 0 },
          tint: rLv >= 7 ? [0xff3b3b, 0xffd23f, 0xffffff] : col, blendMode: 'ADD',
        });
        if (rt.glow && v.body.preFX) v.rareGlow = v.body.preFX.addGlow(col, rt.glow, 0, false, 0.1, 10);
        if (rt.pillar) {
          if (!this.textures.exists('pillar')) {
            const c = this.textures.createCanvas('pillar', 48, 200)!, ctx = c.getContext();
            const gr = ctx.createLinearGradient(0, 0, 0, 200); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0.9)');
            const gx = ctx.createLinearGradient(0, 0, 48, 0); gx.addColorStop(0, 'rgba(0,0,0,1)'); gx.addColorStop(0.5, 'rgba(0,0,0,0)'); gx.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = gr; ctx.fillRect(0, 0, 48, 200); ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = gx; ctx.fillRect(0, 0, 48, 200); c.refresh();
          }
          v.pillar = this.add.image(0, 0, 'pillar').setOrigin(0.5, 1).setTint(col).setBlendMode(Phaser.BlendModes.ADD);
        }
      }
    }
    if (v.rareSparks) { v.rareSparks.setPosition(sx, sy + 2).setDepth(v.body.depth + 0.5); v.rareSparks.emitting = !e.dead; }
    if (v.rareGlow) v.rareGlow.outerStrength = (v.rareLv ?? 0) >= 7 ? 4 + Math.sin(now * 4) * 2 : this.tier(defs.rarity.fx, v.rareLv ?? 0)!.glow;
    if (v.pillar) v.pillar.setPosition(sx, sy + 6).setDepth(v.body.depth - 0.6).setAlpha(0.65 + Math.sin(now * 2.5) * 0.2).setScale(1.5, 1 + Math.sin(now * 2.5) * 0.08).setVisible(!e.dead);
    if (v.sparks) v.sparks.setPosition(x, y).setDepth(v.body.depth + 1).emitting = !e.dead;
    if (v.ring) v.ring.setPosition(sx, sy + 1).setVisible(!e.dead).setAlpha(0.75 + Math.sin(now * 3) * 0.25);
    if (v.wings) {
      v.wings.setPosition(x, y - v.height * 0.45).setDepth(v.body.depth - 0.5).setVisible(!e.dead && v.body.alpha > 0.5);
      const f = Math.sin(now * 3.2) * 0.1;
      (v.wings.list[0] as unknown as Phaser.GameObjects.Components.Transform).scaleX = 1 + f;
      (v.wings.list[1] as unknown as Phaser.GameObjects.Components.Transform).scaleX = -(1 + f);
    }
  }

  /** Placeholder wings drawn from feather shapes; replaced by `sprite` in data/upgrade.json when real art exists. */
  private makeWings(t: { size: number; color: string; sprite: string | null }, h: number) {
    const c = this.add.container(0, 0);
    const col = parseInt(t.color, 16), k = t.size * (h / 64);
    for (const side of [1, -1]) {
      if (t.sprite && this.textures.exists(t.sprite)) {
        c.add(this.add.image(0, 0, t.sprite).setOrigin(1, 0.5).setScale(k * 0.5));
        continue;
      }
      const g = this.add.graphics();
      for (let i = 0; i < 4; i++) {
        const a = (-178 + i * 20) * Math.PI / 180, L = 54 * k * (1 - i * 0.13), w = 9 * k;
        const tx = Math.cos(a) * L, ty = Math.sin(a) * L, mx = tx * 0.55, my = ty * 0.55;
        const px = -Math.sin(a) * w, py = Math.cos(a) * w;
        g.fillStyle(col, 0.85 - i * 0.12).fillPoints([{ x: 0, y: 0 }, { x: mx + px, y: my + py }, { x: tx, y: ty }, { x: mx - px, y: my - py }], true);
        g.lineStyle(1, 0xffffff, 0.5).strokePoints([{ x: 0, y: 0 }, { x: mx + px, y: my + py }, { x: tx, y: ty }, { x: mx - px, y: my - py }], true);
      }
      g.setScale(side === 1 ? 1 : -1, 1);
      c.add(g);
    }
    return c;
  }

  private onEvent(ev: GameEvent) {
    if (ev.t === 'attack') {
      const a = this.world.entities.get(ev.from), b = this.world.entities.get(ev.to), va = a && this.views.get(a.id);
      if (!a || !b || !va) return;
      const pa = toScreen(a.x, a.y), pb = toScreen(b.x, b.y);
      const d = Math.hypot(pb.sx - pa.sx, pb.sy - pa.sy) || 1;
      va.lungeDir = { x: (pb.sx - pa.sx) / d, y: (pb.sy - pa.sy) / d }; va.lunge = 1;
      if (ev.ranged) this.projectile(a, pa, pb);
    } else if (ev.t === 'dmg') {
      const e = this.world.entities.get(ev.to), v = e && this.views.get(e.id);
      if (!e || !v) return;
      const { sx, sy } = toScreen(e.x, e.y);
      if (ev.dot) { this.floatText(sx + 14, sy - v.height + 6, String(ev.amount), ev.dot === 'burn' ? '#ff9f43' : '#ff5d7a', 12, 600); return; }
      const txt = ev.miss ? 'MISS' : String(ev.amount);
      const color = ev.miss ? '#c9d1e0' : e.kind === 'player' ? '#ff6b6b' : ev.crit ? '#ffd23f' : '#ffffff';
      this.floatText(sx, sy - v.height - 6, txt + (ev.crit ? '!' : ''), color, ev.crit ? 20 : 15);
      if (!ev.miss) { v.hitT = 1; v.body.setTintFill(0xffffff); this.time.delayedCall(70, () => v.body.setTint(0xff8080)); this.time.delayedCall(170, () => { v.body.clearTint(); if (v.tint) v.body.setTint(v.tint); v.stKey = undefined; }); }
    } else if (ev.t === 'die') {
      const v = this.views.get(ev.id); if (!v) return;   // died the tick it spawned (no sprite yet)
      this.tweens.add({ targets: v.body, alpha: 0, duration: 450 });
    } else if (ev.t === 'respawn') {
      const v = this.views.get(ev.id); if (!v) return;
      v.popT = 1; v.dieT = 0;
      v.body.setAlpha(0); this.tweens.add({ targets: v.body, alpha: 1, duration: 400 });
    } else if (ev.t === 'xp' && ev.id === this.player.id) {
      const { sx, sy } = toScreen(this.player.x, this.player.y);
      this.floatText(sx, sy - 80, `+${ev.amount} XP`, '#9be7ff', 13);
    } else if (ev.t === 'portal' && ev.id === this.player.id && !this.net && !this.leaving) {
      this.leaving = true;
      const p = this.player, data: SceneData = { cls: p.type, save: this.world.save(p), map: ev.to, at: ev.spawn, vitals: { hp: p.hp, mp: p.mp } };
      data.save!.map = ev.to; writeSave(data.save!); writeUnlocks(this.world.unlocks);
      // don't wait on camerafadeoutcomplete: it never fires if another fade is running
      this.cameras.main.fadeOut(200, 27, 31, 42);
      this.time.delayedCall(220, () => this.scene.restart(data));
    } else if (ev.t === 'status') {
      const e = this.world.entities.get(ev.id), v = e && this.views.get(e.id);
      if (e && v) { const { sx, sy } = toScreen(e.x, e.y); this.floatText(sx, sy - v.height - 22, defs.statuses[ev.type].name, '#ffe9a8', 12, 700); }
    } else if (ev.t === 'quest' && ev.id === this.player.id) {
      if (ev.done) this.hud.banner(`✅ ${ev.daily ? 'เควสต์รายวัน' : 'เควสต์'}สำเร็จ: ${ev.name}`); else this.hud.toast(`📜 เควสต์ใหม่: ${ev.name}`, 'rare');
    } else if (ev.t === 'unlock') {
      this.hud.banner(`🔓 ${ev.by} ปลดล็อก ${MAPS[ev.map]?.name ?? ev.map} ให้ทั้งกลุ่มแล้ว`);
    } else if (ev.t === 'locked' && ev.id === this.player.id) {
      this.hud.toast(`🔒 ${MAPS[ev.map]?.name ?? ev.map} ต้อง Lv ${ev.level} หรือรอให้เพื่อนในกลุ่มเข้าไปปลดล็อกก่อน`, 'warn');
    } else if (ev.t === 'rested' && ev.id === this.player.id) {
      this.hud.banner(`😴 พักไป ${ev.hours} ชม. · Rested XP +${ev.amount.toLocaleString()} (XP จากมอน ×2)`);
    } else if (ev.t === 'telegraph') {
      const { sx, sy } = toScreen(ev.x, ev.y), w = ev.r * TW * 2, h = ev.r * TH * 2;
      const ring = this.add.ellipse(sx, sy, w, h).setStrokeStyle(3, 0xff3b3b, 0.95).setDepth(3);
      const fill = this.add.ellipse(sx, sy, w, h, 0xff3b3b, 0.35).setDepth(3).setScale(0);
      this.tweens.add({ targets: fill, scale: 1, duration: ev.ms, onComplete: () => {
        ring.destroy(); fill.setFillStyle(0xffb36b, 0.8);
        this.tweens.add({ targets: fill, alpha: 0, scale: 1.15, duration: 250, onComplete: () => fill.destroy() });
        this.cameras.main.shake(120, 0.004);
      } });
    } else if (ev.t === 'dungeon') {
      if (ev.state === 'start') this.hud.banner('ดันเจี้ยนเริ่มแล้ว! เคลียร์ทุกห้อง');
      else if (ev.state === 'door') this.hud.toast('ประตูเปิดแล้ว', 'uncommon');
      else if (ev.state === 'clear') this.hud.banner(`เคลียร์! อันดับ ${ev.rank} · ${fmtTime(ev.timeMs ?? 0)}`);
    } else if (ev.t === 'chat') {
      this.hud.chatLine(ev.name, ev.text, ev.id === this.player.id);
      const v = this.views.get(ev.id);
      if (v) {
        // one bubble per character, re-used and positioned every frame in syncView
        const txt = ev.text.length > 40 ? ev.text.slice(0, 40) + '…' : ev.text;
        if (!v.bubble) v.bubble = this.add.text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: '#1b1f2a', backgroundColor: '#ffffffee', padding: { x: 6, y: 3 } })
          .setOrigin(0.5, 1).setDepth(9700).setResolution(2);
        v.bubble.setText(txt).setAlpha(1).setVisible(true); v.bubbleUntil = this.time.now + 4000;
      }
    } else if (ev.t === 'talk' && ev.id === this.player.id) {
      this.hud.openNpc(ev.npc);
    } else if (ev.t === 'transform') {
      const e = this.world.entities.get(ev.id)!, v = this.views.get(e.id);
      if (!v) return;
      this.syncForm(e, v);
      const card = this.world.cardOf(e), height = v.height;
      const { sx, sy } = toScreen(e.x, e.y);
      const g = this.add.graphics().setDepth(9000).setPosition(sx, sy - height / 2);
      g.fillStyle(card ? parseInt(card.aura, 16) : 0xffffff, 0.8).fillCircle(0, 0, 30);
      this.tweens.add({ targets: g, scale: 2.5, alpha: 0, duration: 500, onComplete: () => g.destroy() });
      if (e.id === this.player.id) this.hud.toast(card ? `แปลงร่างเป็น ${card.name}` : 'คืนร่าง', card ? 'rare' : 'muted');
    } else if (ev.t === 'rarify' && ev.id === this.player.id) {
      const d = defs.items[ev.item];
      if (ev.result === 'ok' && ev.rare >= 6) this.hud.bigResult(`🎉 ได้ R${ev.rare}! ${d.name}`);
      this.hud.toast(ev.result === 'ok' ? `สุ่มได้ R${ev.rare}! ${d.name}` : ev.result === 'saved' ? `แตก! แต่ใบกันแตกช่วยไว้ ${d.name} ยังเป็น R${ev.rare}` : `${d.name} แตกหายไปแล้ว...`, ev.result === 'ok' ? (ev.rare >= 6 ? 'epic' : 'rare') : 'warn');
    } else if (ev.t === 'upgrade' && ev.id === this.player.id) {
      const d = defs.items[ev.item];
      if (ev.broke) this.hud.bigResult(`💥 ${d.name} แตกหายไปแล้ว`);
      else if (ev.ok && ev.up >= 8) this.hud.bigResult(`✨ ${d.name} +${ev.up}!`);
      this.hud.toast(ev.ok ? `ตีบวกสำเร็จ! ${d.name} +${ev.up}` : ev.broke ? `${d.name} แตก!` : ev.saved ? `ล้มเหลว แต่ใบกันแตกช่วยไว้ ${d.name} ยังเป็น +${ev.up}` : `ตีบวกล้มเหลว ${d.name} ยังเป็น +${ev.up}`, ev.ok ? 'uncommon' : 'warn');
    } else if (ev.t === 'cardLevel' && ev.id === this.player.id) {
      this.hud.toast(`${defs.items[ev.card].name} เลเวลอัป! Lv ${ev.lv}${ev.lv === 3 ? ' · ปลดล็อกสกิลที่ 3' : ''}`, 'rare');
    } else if (ev.t === 'skill') {
      this.skillFx(ev.skill, ev.x, ev.y, ev.aoe);
    } else if (ev.t === 'heal') {
      const e = this.world.entities.get(ev.to)!, { sx, sy } = toScreen(e.x, e.y);
      this.floatText(sx, sy - 75, `+${ev.amount}`, ev.mp ? '#7fb2ff' : '#6ff08f', 15);
    } else if (ev.t === 'loot' && ev.id === this.player.id) {
      const d = defs.items[ev.item];
      const st = !ev.sold ? [...this.player.inv].reverse().find(x => x.item === ev.item) : undefined;
      this.hud.toast(ev.sold ? `ขายอัตโนมัติ ${d.name} +${d.price * ev.qty} G` : `ได้รับ ${d.icon} ${st?.rare ? 'R' + st.rare + ' ' : ''}${d.name}${ev.qty > 1 ? ' ×' + ev.qty : ''}`, ev.sold ? 'muted' : (st?.rare ?? 0) >= 6 ? 'epic' : d.rarity);
    } else if (ev.t === 'gold' && ev.id === this.player.id) {
      const { sx, sy } = toScreen(this.player.x, this.player.y);
      this.floatText(sx + 18, sy - 62, `+${ev.amount} G`, '#ffd23f', 12);
    } else if (ev.t === 'msg' && ev.id === this.player.id) {
      this.hud.toast(ev.text, 'warn');
    } else if (ev.t === 'level' && ev.id === this.player.id) {
      const { sx, sy } = toScreen(this.player.x, this.player.y);
      this.floatText(sx, sy - 95, `LEVEL UP! Lv ${ev.level}`, '#ffe066', 20, 1600);
      const g = this.add.graphics().setDepth(3).setPosition(sx, sy);
      g.lineStyle(3, 0xffe066, 1).strokeEllipse(0, 0, 50, 25);
      this.tweens.add({ targets: g, scale: 2.4, alpha: 0, duration: 700, onComplete: () => g.destroy() });
    }
  }

  private skillFx(skill: string, x: number, y: number, aoe: number) {
    const { sx, sy } = toScreen(x, y);
    const color = /fire|flame/.test(skill) ? 0xff7a2f : /ice/.test(skill) ? 0x7fd6ff : /second/.test(skill) ? 0x6ff08f : 0xfff1a8;
    const g = this.add.graphics().setDepth(3).setPosition(sx, sy);
    if (aoe) {
      g.fillStyle(color, 0.25).fillEllipse(0, 0, aoe * TW * 2, aoe * TH * 2);
      g.lineStyle(3, color, 0.9).strokeEllipse(0, 0, aoe * TW * 2, aoe * TH * 2);
      g.setScale(0.3);
      this.tweens.add({ targets: g, scale: 1, alpha: 0, duration: 450, ease: 'Cubic.easeOut', onComplete: () => g.destroy() });
    } else {
      g.lineStyle(3, color, 1).strokeEllipse(0, -24, 44, 44);
      this.tweens.add({ targets: g, scale: 1.6, alpha: 0, duration: 380, onComplete: () => g.destroy() });
    }
  }

  private projectile(a: Entity, pa: { sx: number; sy: number }, pb: { sx: number; sy: number }) {
    const magic = (a.stats?.attackType ?? defs.monsters[a.type]?.attackType) === 'magic';
    const g = this.add.graphics().setDepth(9000);
    if (magic) { g.fillStyle(0xff8a3d, 1).fillCircle(0, 0, 5); g.fillStyle(0xffe08a, 1).fillCircle(0, 0, 2.5); }
    else { g.lineStyle(2, 0xf2e6c9, 1).lineBetween(-7, 0, 7, 0); }
    g.setPosition(pa.sx, pa.sy - 30).setRotation(Math.atan2(pb.sy - pa.sy, pb.sx - pa.sx));
    this.tweens.add({ targets: g, x: pb.sx, y: pb.sy - 20, duration: 160, onComplete: () => g.destroy() });
  }

  private floatText(x: number, y: number, s: string, color: string, size: number, ms = 800) {
    const t = this.add.text(x, y, s, { fontFamily: 'system-ui, sans-serif', fontSize: `${size}px`, fontStyle: 'bold', color, stroke: '#1b1f2a', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(10000).setResolution(2);
    t.x += (Math.random() - 0.5) * 12;
    this.tweens.add({ targets: t, y: y - 28, alpha: 0, duration: ms, ease: 'Cubic.easeOut', onComplete: () => t.destroy() });
  }

  /** Auto hunting radius around its anchor (or around you while the settings are open). */
  private drawAutoRange() {
    const g = this.autoRing ??= this.add.graphics().setDepth(1.5);
    g.clear();
    const p = this.player, a = p.auto ? p.autoAnchor : this.hud.autoPanel.isOpen ? [p.x, p.y] as [number, number] : null;
    if (!a || this.world.map.dungeon || p.autoTrip) return;
    const { sx, sy } = toScreen(a[0], a[1]), r = p.autoCfg.range * Math.SQRT2;
    g.fillStyle(0x9be7ff, 0.06).fillEllipse(sx, sy, r * TW, r * TH);
    g.lineStyle(2, 0x9be7ff, 0.55).strokeEllipse(sx, sy, r * TW, r * TH);
  }

  private drawTargetRing() {
    this.ring.clear();
    const t = this.player.target != null ? this.world.entities.get(this.player.target) : undefined;
    if (!t || t.dead) return;
    const { sx, sy } = toScreen(t.x, t.y);
    this.ring.lineStyle(2, 0xff5d5d, 0.9).strokeEllipse(sx, sy + 1, t.boss ? 64 : 40, t.boss ? 30 : 18);
  }

  // Ground is baked into one texture; trees/rocks are shared textures. Graphics objects re-tessellate every frame.
  private animDecor(now: number, dtMs: number) {
    for (const s of this.sway) s.o.setRotation(Math.sin(now * 1.4 + s.ph) * s.amp + Math.sin(now * 0.37 + s.ph * 2) * s.amp * 0.5);
    const b = this.bounds;
    for (const c of this.clouds) { c.x += dtMs * 0.012; c.y += dtMs * 0.004; if (c.x > b.x1 + 300) { c.x = b.x0 - 300; c.y = b.y0 + Math.random() * (b.y1 - b.y0); } }
  }

  /** v2 look: painted ground (with an unwalkable decorated margin), sheet props in clusters with contact shadows. */
  private drawGroundV2(map: MapData) {
    const g = paintGround(this, map, (x, y) => this.world.isWater(x, y), TW, TH);
    this.add.image(g.x, g.y, g.key).setOrigin(0, 0).setScale(PX).setDepth(0);
    makeProps(this);
    const h = (x: number, y: number, s = 0) => ((((Math.round(x * 13) + s * 31) * 73856093) ^ (Math.round(y * 17) * 19349663)) >>> 0) % 1000 / 1000;
    const pickOf = <T,>(arr: T[], x: number, y: number, s = 0) => arr[Math.floor(h(x, y, s) * arr.length) % arr.length];
    const P = PROPS as unknown as Record<string, { h: number; w: number }>;
    // margin props are baked into one texture (bake != null): they never meet a player, and ~1000 live images was too many
    let bake: Phaser.GameObjects.Image[] | null = null;
    const img = (x: number, y: number, key: string) => { if (!bake) return this.add.image(x, y, key); const o = this.make.image({ x, y, key }, false); bake.push(o); return o; };
    const prop = (id: string, fx: number, fy: number, o: { scale?: number; sway?: number; flip?: boolean; shadow?: number; tint?: number; above?: number } = {}) => {
      const { sx, sy } = toScreen(fx, fy), sc = o.scale ?? 1;
      const sw = o.shadow ?? 0.7;
      if (sw > 0) img(sx, sy + 3, 'm_shadow').setScale(P[id].w * sc * sw / 32, P[id].w * sc * sw / 80).setDepth(1.5);
      const im = img(sx, sy + 4, `p_${id}`).setOrigin(0.5, 0.96).setScale(0.5 * sc).setDepth(10 + sy + (o.above ?? 0)).setFlipX(o.flip ?? h(fx, fy, 7) > 0.5);
      if (o.tint) im.setTint(o.tint);
      if (o.sway && !bake) this.sway.push({ o: im, ph: h(fx, fy) * 6.28, amp: o.sway });
      return im;
    };
    const GRASS = ['grass_a', 'grass_b', 'grass_c', 'grass_fl1', 'grass_fl2'], FLOW = ['fl_white', 'fl_pink', 'fl_purple', 'fl_yellow', 'fb_white', 'fb_pink', 'fb_blue', 'fb_mix'];
    const MUSH = ['mush_red', 'mush_small', 'mush_orange'], TREES = ['oak_a', 'oak_b', 'oak_a', 'pine'];
    const grass = (x: number, y: number) => prop(pickOf(GRASS, x, y, 1), x, y, { sway: 0.1, scale: 0.8 + h(x, y, 2) * 0.4, shadow: 0 });
    const tree = (x: number, y: number, far = false) => {
      prop(pickOf(TREES, x, y, 3), x, y, { scale: (far ? 0.85 : 0.9) + h(x, y, 4) * 0.2, sway: far ? 0.012 : 0.018, tint: far ? 0xb4bac2 : undefined });
      if (!far) { grass(x - 0.4, y + 0.3); if (h(x, y, 5) > 0.5) prop(pickOf(['bush_white', 'bush_pink'], x, y), x + 0.45, y + 0.15, { scale: 0.85 }); }
    };
    const rocks = (x: number, y: number) => {
      prop(h(x, y, 6) > 0.4 ? 'rock_mid' : 'rock_big', x, y, { scale: 0.85 });
      prop('rock_small', x + 0.5, y + 0.4, { scale: 0.6 }); grass(x - 0.45, y + 0.35);
    };
    const flowers = (x: number, y: number) => {   // a patch: 2-3 flower clumps, grass, sometimes a mushroom
      const f = pickOf(FLOW, x, y, 8);
      prop(f, x, y, { sway: 0.06, shadow: 0 }); prop(f, x + 0.35, y + 0.3, { sway: 0.06, scale: 0.8, shadow: 0 });
      if (h(x, y, 9) > 0.5) prop(pickOf(FLOW, x, y, 10), x - 0.3, y + 0.35, { sway: 0.06, scale: 0.75, shadow: 0 });
      if (h(x, y, 11) > 0.75) prop(pickOf(MUSH, x, y, 12), x + 0.1, y - 0.35, { shadow: 0.5 });
      grass(x + 0.5, y - 0.1);
    };
    // blocking trees on the two front edges would hide players walking along them: low bushes there instead
    for (const [x, y] of map.trees) { if (x >= map.width - 2 || y >= map.height - 2) prop(pickOf(['bush_white', 'bush_pink'], x, y), x, y); else tree(x, y); }
    for (const [x, y] of map.rocks) rocks(x, y);
    const blocked = (x: number, y: number) => !this.world.walkable(x, y) || this.world.isWater(x, y) || map.npcs.some(n => Math.hypot(n.x - x, n.y - y) < 2.2);
    const town = map.ground === 'stone';
    for (const [x, y] of scatter(map, blocked, town ? 0 : 9, 3)) flowers(x, y);
    for (const [x, y] of scatter(map, blocked, town ? 6 : 28, 5)) grass(x, y);
    if (!town) for (const [x, y] of scatter(map, blocked, 4, 13)) prop(pickOf(MUSH, x, y), x, y, { shadow: 0.5 });
    // ---- margin (unwalkable): dense forest behind the two back edges, only low props in front so nothing hides players
    const M = MARGIN, W = map.width, H = map.height;
    bake = [];
    const houses = town ? this.townHouses(map, img) : [];
    const nearHouse = (x: number, y: number) => houses.some(([hx, hy, r]) => Math.hypot(hx - x, hy - y) < r);
    for (let y = -M; y < H + M; y += 1.25) for (let x = -M; x < W + M; x += 1.25) {
      const jx = x + (h(x, y, 14) - 0.5) * 0.8, jy = y + (h(x, y, 15) - 0.5) * 0.8;
      const out = Math.max(-0.6 - jx, -0.6 - jy, jx - W + 0.4, jy - H + 0.4);
      if (out <= 0.2 || nearHouse(jx, jy)) continue;
      const back = jx < -0.5 || jy < -0.5, front = jx > W - 0.5 || jy > H - 0.5, k = h(jx, jy, 16);
      if (back && !front) {
        if (k < 0.62) tree(jx, jy, out > 1.5);
        else if (k < 0.72) rocks(jx, jy);
        else if (k < 0.76 && !town) prop('rock_spire', jx, jy, { scale: 0.9 });
        else if (k < 0.9) flowers(jx, jy);
        else grass(jx, jy);
      } else {
        if (k < 0.3) prop(pickOf(['bush_white', 'bush_pink'], jx, jy), jx, jy, { scale: 0.9 });
        else if (k < 0.55) flowers(jx, jy);
        else if (k < 0.65) prop('rock_small', jx, jy);
        else if (k < 0.92) grass(jx, jy);
      }
    }
    {
      const PAD = 200, tex = this.textures.get(g.key).getSourceImage(), rw = tex.width * PX, rh = tex.height * PX + PAD;
      const rt = this.add.renderTexture(g.x, g.y - PAD, rw, rh).setOrigin(0, 0).setDepth(1.6);
      rt.beginDraw();
      for (const o of bake.sort((a, b) => a.depth - b.depth)) rt.batchDraw(o, o.x - g.x, o.y - g.y + PAD);
      rt.endDraw();
      for (const o of bake) o.destroy();
      bake = null;
    }
    if (town) this.townDecor(map, prop);
    const c0 = toScreen(0, H), c1 = toScreen(W, 0), c2 = toScreen(W, H);
    this.bounds = { x0: c0.sx, x1: c1.sx, y0: 0, y1: c2.sy };
    for (let i = 0; i < 3; i++) this.clouds.push(this.add.image(c0.sx + (c1.sx - c0.sx) * (i / 3), c2.sy * (0.2 + i * 0.3), 'm_cloud').setScale(9, 7).setAlpha(0.08).setDepth(1));
    this.add.particles(0, 0, 'm_mote', {
      x: { min: c0.sx, max: c1.sx }, y: { min: 0, max: c2.sy }, lifespan: 7000, frequency: 320, quantity: 1,
      speedX: { min: -6, max: 6 }, speedY: { min: -12, max: -4 }, scale: { min: 1, max: 1.6 }, alpha: { onUpdate: (_p: unknown, _k: string, t: number) => Math.sin(t * Math.PI) * 0.6 }, blendMode: 'ADD',
    }).setDepth(9000);
  }

  /** Houses sit in the back margin (scenery, not walkable). Returns [x, y, keep-clear radius] so trees avoid them. */
  private townHouses(map: MapData, img: (x: number, y: number, key: string) => Phaser.GameObjects.Image): [number, number, number][] {
    const list: [string, number, number][] = [['house_tree', -2.6, 3.5], ['house_blue', -2.3, 11], ['house_vine', 4.5, -2.3], ['house_mill', 12, -2.6]];
    for (const [id, x, y] of list) {
      const { sx, sy } = toScreen(x, y);
      img(sx, sy + 14, 'm_shadow').setScale(5.5, 2.2).setDepth(1.5);
      img(sx, sy + 20, `p_${id}`).setOrigin(0.5, 0.92).setScale(0.5).setDepth(10 + sy);
    }
    void map;
    return list.map(([, x, y]) => [x, y, 3.2]);
  }

  /** Town plaza: fountain spout, lamps, benches; a stall or tent by each merchant, crates/barrels/cart by the others. */
  private townDecor(map: MapData, prop: (id: string, fx: number, fy: number, o?: { scale?: number; flip?: boolean; shadow?: number; above?: number; sway?: number }) => Phaser.GameObjects.Image) {
    const water = map.water;
    if (water.length) {
      const cx = water.reduce((a, w) => a + w[0], 0) / water.length, cy = water.reduce((a, w) => a + w[1], 0) / water.length;
      if (!this.textures.exists('m_spout')) {
        const t = this.textures.createCanvas('m_spout', 14, 30)!, c = t.getContext();
        const R = (x: number, y: number, w: number, hh: number, col: string) => { c.fillStyle = col; c.fillRect(x, y, w, hh); };
        R(4, 8, 6, 20, '#5d5952'); R(5, 8, 3, 20, '#8b857b'); R(1, 26, 12, 4, '#5d5952'); R(2, 26, 10, 1, '#a59e92'); R(2, 4, 10, 4, '#5d5952'); R(3, 4, 8, 1, '#a59e92'); R(5, 1, 4, 3, '#8b857b');
        t.refresh(); t.setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
      const { sx, sy } = toScreen(cx, cy);
      this.add.image(sx, sy + 4, 'm_spout').setOrigin(0.5, 1).setScale(PX).setDepth(10 + sy);
      this.add.particles(sx, sy - 52, 'dust', { lifespan: 700, frequency: 45, speedX: { min: -38, max: 38 }, speedY: { min: -70, max: -30 }, gravityY: 220,
        scale: { start: 0.45, end: 0.15 }, alpha: { start: 0.8, end: 0 }, tint: 0xbfe3ff }).setDepth(10 + sy + 0.5);
      for (const [dx, dy] of [[2.6, -2.6], [-2.6, 2.6]]) prop('lamp', cx + dx, cy + dy, { shadow: 0.5 });
      for (const [dx, dy] of [[-1.7, 0.2], [0.2, -1.7]]) prop('flower_bush', cx + dx, cy + dy);
      prop('bench', cx + 2.1, cy + 0.6); prop('bench', cx + 0.6, cy + 2.1, { flip: true });
    }
    const p = map.portals[0];
    if (p) { prop('signpost', p.x - 1.2, p.y - 0.8); prop('banner', p.x + 0.9, p.y - 1.1); }
    for (const n of map.npcs) {
      const X = n.x, Y = n.y;
      if (n.id === 'shop') prop('stall_red', X + 0.4, Y + 0.4, { above: 1 });
      else if (n.id === 'rarer') prop('stall_blue', X + 0.4, Y + 0.4, { above: 1 });
      else if (n.id === 'craft') { prop('tent', X - 0.7, Y - 0.6); prop('stump_axe', X + 0.6, Y + 0.6); }
      else if (n.id === 'smith') { prop('hay_crates', X - 0.75, Y + 0.3); prop('barrel_stone', X + 0.5, Y - 0.6); }
      else if (n.id === 'stash') { prop('cart', X + 0.2, Y - 0.9); prop('crate', X - 0.7, Y + 0.4); }
      else if (n.id === 'healer') { prop('flower_bush', X - 0.7, Y + 0.4); prop('pot_stand', X + 0.5, Y - 0.7); }
    }
  }

  private drawGround(map: MapData) {
    if (map.art === 'v2') { this.drawGroundV2(map); return; }
    const minX = -map.height * TW / 2 - TW / 2, maxX = map.width * TW / 2 + TW / 2;
    const minY = -TH / 2, maxY = (map.width + map.height) * TH / 2 + TH / 2;
    const g = this.make.graphics({}, false);
    g.translateCanvas(-minX, -minY);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      const { sx, sy } = toScreen(x, y);
      const water = this.world.isWater(x, y);
      const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      const GROUND: Record<string, [number[], number]> = { ash: [[0x8a6f5a, 0x826852, 0x927663], 0x6e5646], marsh: [[0x3f5a46, 0x3a5442, 0x44604b], 0x2f4637], temple: [[0x3d5a6e, 0x385468, 0x426074], 0x2c4556],
        sky: [[0xc9dcf5, 0xc1d5f1, 0xd2e3f8], 0xa7bfe0], lava: [[0x5a2a24, 0x52261f, 0x632f28], 0x3f1b16], crystal: [[0x6a5a8e, 0x645486, 0x726296], 0x4e4270],
        twilight: [[0x5a5a7e, 0x545476, 0x626288], 0x434362], void: [[0x2e2440, 0x2a213b, 0x332848], 0x1d1729], eclipse: [[0x4a2f3a, 0x452b36, 0x523440], 0x321e27] };
      const gx = GROUND[map.ground];
      const stone = map.ground !== 'grass' && map.ground !== 'snow' && !gx, ruin = map.ground === 'ruin', snow = map.ground === 'snow';
      const base = water ? (map.ground === 'marsh' ? 0x2f5f55 : 0x8fd3f0) : gx ? gx[0][n % 3] : snow ? [0xe8f0f8, 0xdfe9f4, 0xf1f6fb][n % 3] : ruin ? [0x5b5466, 0x564f60, 0x605a6b][n % 3] : stone ? [0xc9c2b4, 0xc2bba9, 0xd0c9bb][n % 3] : [0x7cc56b, 0x76bf65, 0x82ca70][n % 3];
      this.diamond(g, sx, sy, base, water ? 0x3a8cc0 : gx ? gx[1] : snow ? 0xc5d4e4 : ruin ? 0x48425a : stone ? 0xa8a090 : 0x68ad58);
      if (!water && !stone && !gx && n % 11 === 0) { g.fillStyle(0xf4e27a, 1).fillCircle(sx - 6, sy + 2, 2); g.fillStyle(0xffffff, 1).fillCircle(sx + 8, sy - 3, 1.6); }
    }
    const key = `ground_${map.id}`;
    if (this.textures.exists(key)) this.textures.remove(key);
    g.generateTexture(key, maxX - minX, maxY - minY); g.destroy();
    this.add.image(minX, minY, key).setOrigin(0, 0).setDepth(0);

    if (!this.textures.exists('tree')) {
      const t = this.make.graphics({}, false); t.translateCanvas(24, 58);
      t.fillStyle(0x000000, 0.25).fillEllipse(0, 4, 38, 12);
      t.fillStyle(0x7a5232, 1).fillRect(-4, -22, 8, 24);
      t.fillStyle(0x3f9a4a, 1).fillCircle(0, -34, 20);
      t.fillStyle(0x56b65e, 1).fillCircle(-7, -40, 11);
      t.generateTexture('tree', 48, 70); t.destroy();
      const r = this.make.graphics({}, false); r.translateCanvas(22, 20);
      r.fillStyle(0x000000, 0.25).fillEllipse(0, 4, 40, 12);
      r.fillStyle(0x8a8f9c, 1).fillEllipse(0, -4, 34, 22);
      r.fillStyle(0xa9aeba, 1).fillEllipse(-5, -9, 18, 10);
      r.generateTexture('rock', 44, 30); r.destroy();
    }
    // per-map leaf colour (tinting can't turn green leaves purple, so bake a variant texture)
    let treeKey = 'tree';
    if (map.treeTint) {
      treeKey = `tree_${map.treeTint}`;
      if (!this.textures.exists(treeKey)) {
        const leaf = Phaser.Display.Color.ValueToColor(parseInt(map.treeTint, 16)), hi = leaf.clone().lighten(15).color, lo = leaf.color;
        const t = this.make.graphics({}, false); t.translateCanvas(24, 58);
        t.fillStyle(0x000000, 0.25).fillEllipse(0, 4, 38, 12);
        t.fillStyle(0x4a3a3a, 1).fillRect(-4, -22, 8, 24);
        t.fillStyle(lo, 1).fillCircle(0, -34, 20);
        t.fillStyle(hi, 1).fillCircle(-7, -40, 11);
        t.generateTexture(treeKey, 48, 70); t.destroy();
      }
    }
    for (const [x, y] of map.trees) { const { sx, sy } = toScreen(x, y); this.add.image(sx, sy, treeKey).setOrigin(24 / 48, 58 / 70).setDepth(10 + sy); }
    if (!this.textures.exists('wall')) {
      const w = this.make.graphics({}, false); w.translateCanvas(32, 44);
      w.fillStyle(0x3a3446, 1).fillPoints([{ x: -32, y: 0 }, { x: 0, y: 16 }, { x: 0, y: -12 }, { x: -32, y: -28 }], true);
      w.fillStyle(0x2c2738, 1).fillPoints([{ x: 32, y: 0 }, { x: 0, y: 16 }, { x: 0, y: -12 }, { x: 32, y: -28 }], true);
      w.fillStyle(0x6b6380, 1).fillPoints([{ x: -32, y: -28 }, { x: 0, y: -44 }, { x: 32, y: -28 }, { x: 0, y: -12 }], true);
      w.generateTexture('wall', 64, 62);
      const d = this.make.graphics({}, false); d.translateCanvas(32, 44);
      d.fillStyle(0x7a5232, 1).fillPoints([{ x: -28, y: -2 }, { x: 0, y: 12 }, { x: 0, y: -16 }, { x: -28, y: -30 }], true);
      d.lineStyle(3, 0xffd23f, 0.9); for (const k of [-21, -14, -7]) d.lineBetween(k, -28 + (k + 28) / 2 + 2, k, (k + 28) / 2 + 2);
      d.generateTexture('door', 64, 62); w.destroy(); d.destroy();
    }
    for (const [x, y] of map.walls ?? []) { const { sx, sy } = toScreen(x, y); this.add.image(sx, sy, 'wall').setOrigin(0.5, 44 / 62).setDepth(10 + sy); }
    this.doorViews = (map.dungeon?.doors ?? []).map(d => ({ room: d.room, imgs: d.tiles.map(([x, y]) => { const { sx, sy } = toScreen(x, y); return this.add.image(sx, sy, 'door').setOrigin(0.5, 44 / 62).setDepth(10 + sy); }) }));
    for (const [x, y] of map.rocks) { const { sx, sy } = toScreen(x, y); this.add.image(sx, sy, 'rock').setOrigin(0.5, 20 / 30).setDepth(10 + sy); }
  }

  private drawPortals(map: MapData) {
    this.gated = [];
    for (const p of map.portals) {
      const { sx, sy } = toScreen(p.x, p.y);
      const before = this.children.list.length;
      const ring = this.add.ellipse(sx, sy, 54, 26, 0x8f7bff, 0.35).setStrokeStyle(3, 0xc6b8ff, 1).setDepth(2);
      this.tweens.add({ targets: ring, scaleX: 1.15, scaleY: 1.15, alpha: 0.6, yoyo: true, repeat: -1, duration: 700 });
      this.add.particles(sx, sy, 'spark', { frequency: 120, lifespan: 1000, x: { min: -20, max: 20 }, speedY: { min: -40, max: -15 },
        scale: { start: 1, end: 0 }, alpha: { start: 1, end: 0 }, tint: 0xc6b8ff, blendMode: 'ADD' }).setDepth(9 + sy);
      const lb = this.label(sx, sy - 46, '⟡ ' + p.label, '#d9d0ff');
      if (p.minLevel) this.portalLabels.push({ p, t: lb });
      if (p.when === 'cleared') this.gated.push({ objs: this.children.list.slice(before) });
    }
  }

  private drawNpcs(map: MapData) {
    for (const n of map.npcs) {
      const d = defs.npcs[n.id], { sx, sy } = toScreen(n.x, n.y);
      this.add.ellipse(sx, sy + 1, 36, 10, 0x000000, 0.28).setDepth(2);
      const img = this.add.image(sx, sy + 3, d.sprite).setOrigin(0.5, 1).setInteractive({ useHandCursor: true });
      const fit = this.fitScale(d.sprite, NPC_CORE, NPC_MAXW);
      img.setScale(fit.scale).setDepth(10 + sy).setData('npc', n.id);
      this.tweens.add({ targets: img, scaleY: img.scaleY * 1.025, yoyo: true, repeat: -1, duration: 1100, ease: 'Sine.easeInOut' });
      this.label(sx, sy - fit.height - 4, `${d.name} · ${d.title}`, '#ffe9a8');
    }
  }

  private label(x: number, y: number, s: string, color: string) {
    return this.add.text(x, y, s, { fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold', color, stroke: '#1b1f2a', strokeThickness: 3 })
      .setOrigin(0.5).setDepth(9500).setResolution(2);
  }

  private banner(s: string) { this.hud.banner(s); this.cameras.main.fadeIn(250, 27, 31, 42); }

  private diamond(g: Phaser.GameObjects.Graphics, sx: number, sy: number, fill: number, line: number) {
    g.fillStyle(fill, 1).beginPath().moveTo(sx, sy - TH / 2).lineTo(sx + TW / 2, sy).lineTo(sx, sy + TH / 2).lineTo(sx - TW / 2, sy);
    g.closePath().fillPath().lineStyle(1, line, 0.6).strokePath();
  }

  private drawHover(p: Phaser.Input.Pointer) {
    const { x, y } = toTile(p.worldX, p.worldY);
    this.hover.clear();
    if (p.wasTouch || !this.world.walkable(x, y)) return;
    const { sx, sy } = toScreen(x, y);
    this.hover.lineStyle(2, 0xffffff, 0.6).strokePoints([
      { x: sx, y: sy - TH / 2 }, { x: sx + TW / 2, y: sy }, { x: sx, y: sy + TH / 2 }, { x: sx - TW / 2, y: sy },
    ], true);
  }

  private showMarker(x: number, y: number) {
    const { sx, sy } = toScreen(x, y);
    this.marker.clear().lineStyle(2, 0xffe066, 1).strokeEllipse(0, 0, 30, 15);
    this.marker.setPosition(sx, sy).setAlpha(1).setScale(1);
    this.tweens.killTweensOf(this.marker);
    this.tweens.add({ targets: this.marker, alpha: 0, scale: 0.4, duration: 500 });
  }
}
