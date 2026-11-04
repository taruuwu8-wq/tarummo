import Phaser from 'phaser';
import { World, TICK_MS, Entity, MapData, Defs, GameEvent } from '../sim/world';
import { loadDefs, MAPS } from '../data';
import type { SaveData } from '../sim/world';
import { writeSave } from './save';
import type { Net } from './net';
import type { Intent } from '../sim/world';
import { Hud } from './hud';

const TW = 64, TH = 32;
const defs = loadDefs();

// Save on tab hide/close. Registered once; points at whichever scene is current.
let saveNow: () => void = () => {};
window.addEventListener('pagehide', () => saveNow());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

export interface SceneData { net?: Net; cls: string; save?: SaveData; map?: string; at?: [number, number]; vitals?: { hp: number; mp: number } }

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
  scale: number; phase: number; lunge: number; lungeDir: { x: number; y: number }; height: number;
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

  constructor() { super('game'); }

  preload() {
    for (const d of [...Object.values(defs.classes), ...Object.values(defs.monsters), ...Object.values(defs.cards), ...Object.values(defs.npcs)]) if (d.sprite) this.load.image(d.sprite, `sprites/${d.sprite}.png`);
  }

  private leaving = false;
  private net?: Net;
  private act: (i: Intent) => void = () => {};
  private names = new Map<number, Phaser.GameObjects.Text>();

  create(data: SceneData) {
    this.views.clear(); this.names.clear(); this.acc = 0; this.leaving = false; this.net = data.net;
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
      this.world = new World(structuredClone(map), defs, Date.now() & 0xffff);
      this.player = this.world.spawnPlayer(data.cls ?? 'swordsman', data.save, data.at, data.vitals);
      this.act = i => this.world.apply(i);
    }

    // tiny 4-point star used by upgrade sparkles
    const sg = this.make.graphics({}, false);
    sg.fillStyle(0xffffff, 1).fillPoints([{ x: 4, y: 0 }, { x: 5, y: 3 }, { x: 8, y: 4 }, { x: 5, y: 5 }, { x: 4, y: 8 }, { x: 3, y: 5 }, { x: 0, y: 4 }, { x: 3, y: 3 }], true);
    sg.generateTexture('spark', 8, 8); sg.destroy();
    this.drawGround(map);
    this.hover = this.add.graphics().setDepth(1);
    this.marker = this.add.graphics().setDepth(1).setAlpha(0);
    this.ring = this.add.graphics().setDepth(2);
    for (const e of this.world.entities.values()) this.makeView(e);

    const cam = this.cameras.main;
    cam.setZoom(window.innerWidth < 600 ? 1.15 : 1.5);
    cam.startFollow(this.views.get(this.player.id)!.body, true, 0.12, 0.12);

    this.hud = new Hud(this.world, this.player, defs.items, i => this.act(i));
    const save = () => writeSave(this.world.save(this.player));
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

  update(_t: number, dtMs: number) {
    // use real elapsed time: Phaser smooths delta, which slows the sim down on low-FPS devices
    if (this.leaving) return;
    dtMs = this.game.loop.rawDelta;
    this.acc += Math.min(dtMs, 1000);
    if (this.net) this.drainNet();
    else while (this.acc >= TICK_MS) {
      this.world.tick(); this.acc -= TICK_MS;
      for (const ev of this.world.events) { this.onEvent(ev); if (this.leaving) return; }
      this.world.events.length = 0;
    }
    if (this.leaving) return;
    const alpha = Math.min(1, this.acc / TICK_MS), now = this.time.now / 1000;
    for (const e of this.world.entities.values()) { if (!this.views.has(e.id)) this.makeView(e); this.syncView(e, alpha, now, dtMs); }
    for (const [id, v] of this.views) if (!this.world.entities.has(id)) {
      v.body.destroy(); v.shadow.destroy(); v.bar.destroy(); v.aura?.destroy(); v.sparks?.destroy(); v.ring?.destroy(); v.wings?.destroy();
      this.views.delete(id); this.names.get(id)?.destroy(); this.names.delete(id);
    }
    this.drawTargetRing();
    const tgt = this.player.target != null ? this.world.entities.get(this.player.target) ?? null : null;
    this.hud.update(this.world.xpNeeded(this.player), tgt);
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
        this.world.applySnapshot(m.now, m.ents); this.acc = 0;
        for (const ev of m.ev) this.onEvent(ev);
      } else if (m.t === 'error') this.hud.toast(m.text, 'warn');
    }
  }

  private makeView(e: Entity) {
    const d = e.kind === 'player' ? defs.classes[e.type] : defs.monsters[e.type];
    const body = this.add.image(0, 0, d.sprite).setOrigin(0.5, 1).setInteractive({ useHandCursor: e.kind === 'monster', pixelPerfect: false });
    body.setData('id', e.id);
    const scale = d.height / body.height;
    const shadow = this.add.ellipse(0, 0, body.width * scale * 0.6, 10, 0x000000, 0.28);
    const bar = this.add.graphics();
    this.views.set(e.id, { body, shadow, bar, scale, phase: Math.random() * 6, lunge: 0, lungeDir: { x: 0, y: 0 }, height: d.height });
  }

  private syncView(e: Entity, alpha: number, now: number, dtMs: number) {
    const v = this.views.get(e.id)!;
    const { sx, sy } = toScreen(e.px + (e.x - e.px) * alpha, e.py + (e.y - e.py) * alpha);
    const t = now * (e.moving ? 9 : 2.2) + v.phase;
    let bob = 0, sqx = 1, sqy = 1;
    if (e.moving) { bob = -Math.abs(Math.sin(t)) * 5; sqy = 1 + Math.abs(Math.sin(t)) * 0.04; }
    else { sqy = 1 + Math.sin(t) * 0.025; sqx = 1 - Math.sin(t) * 0.015; }
    v.lunge = Math.max(0, v.lunge - dtMs / 180);
    const l = Math.sin(v.lunge * Math.PI) * 10;
    const x = sx + v.lungeDir.x * l, y = sy + 3 + bob + v.lungeDir.y * l;
    v.body.setPosition(x, y).setScale(v.scale * sqx * e.facing, v.scale * sqy);
    v.shadow.setPosition(sx, sy + 1).setScale(1 + bob / 30);
    v.body.setDepth(10 + sy); v.shadow.setDepth(2);
    if (v.aura) { v.aura.setPosition(sx, sy + 1).setVisible(!e.dead).setScale(1 + Math.sin(now * 4) * 0.08); }
    if (e.kind === 'player') this.syncGearFx(e, v, x, y, sx, sy, now);
    v.body.setVisible(!e.dead || v.body.alpha > 0.01); v.shadow.setVisible(!e.dead);
    if (this.net && e.kind === 'player') {
      let t = this.names.get(e.id);
      if (!t) { t = this.add.text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold', color: e.id === this.player.id ? '#ffe066' : '#9be7ff', stroke: '#1b1f2a', strokeThickness: 3 }).setOrigin(0.5).setResolution(2); this.names.set(e.id, t); }
      t.setText(`${e.name} Lv${e.level}`).setPosition(x, y - v.height * sqy - 18).setDepth(9600);
    }

    v.bar.clear();
    const showBar = !e.dead && (e.kind === 'player' || e.hp < e.maxHp || this.player.target === e.id);
    if (showBar) {
      const w = e.boss ? 56 : 34, bx = sx - w / 2, by = y - v.height * sqy - 8;
      v.bar.fillStyle(0x000000, 0.6).fillRect(bx - 1, by - 1, w + 2, 6);
      v.bar.fillStyle(e.kind === 'player' ? 0x5be37a : 0xe5484d, 1).fillRect(bx, by, w * (e.hp / e.maxHp), 4);
      v.bar.setDepth(5000 + sy);
    }
  }

  private tier<T extends { min: number }>(tiers: T[], lv: number): T | undefined {
    let t: T | undefined; for (const x of tiers) if (lv >= x.min) t = x; return t;
  }

  // Upgrade visuals: weapon +N -> sparkles, armor +N -> ground aura, card +N (while transformed) -> wings.
  private syncGearFx(e: Entity, v: View, x: number, y: number, sx: number, sy: number, now: number) {
    const wUp = e.equip.weapon?.up ?? 0, aUp = e.equip.armor?.up ?? 0, cUp = e.transformed ? e.equip.card?.up ?? 0 : 0;
    const sig = `${wUp}|${aUp}|${cUp}|${v.height}`;
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
    }
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
      const a = this.world.entities.get(ev.from)!, b = this.world.entities.get(ev.to)!, va = this.views.get(a.id)!;
      const pa = toScreen(a.x, a.y), pb = toScreen(b.x, b.y);
      const d = Math.hypot(pb.sx - pa.sx, pb.sy - pa.sy) || 1;
      va.lungeDir = { x: (pb.sx - pa.sx) / d, y: (pb.sy - pa.sy) / d }; va.lunge = 1;
      if (ev.ranged) this.projectile(a, pa, pb);
    } else if (ev.t === 'dmg') {
      const e = this.world.entities.get(ev.to)!, v = this.views.get(e.id)!;
      const { sx, sy } = toScreen(e.x, e.y);
      const txt = ev.miss ? 'MISS' : String(ev.amount);
      const color = ev.miss ? '#c9d1e0' : e.kind === 'player' ? '#ff6b6b' : ev.crit ? '#ffd23f' : '#ffffff';
      this.floatText(sx, sy - v.height - 6, txt + (ev.crit ? '!' : ''), color, ev.crit ? 20 : 15);
      if (!ev.miss) { v.body.setTintFill(0xffffff); this.time.delayedCall(70, () => v.body.setTint(0xff8080)); this.time.delayedCall(170, () => v.body.clearTint()); }
    } else if (ev.t === 'die') {
      const v = this.views.get(ev.id)!;
      this.tweens.add({ targets: v.body, alpha: 0, duration: 450 });
    } else if (ev.t === 'respawn') {
      const v = this.views.get(ev.id)!;
      v.body.setAlpha(0); this.tweens.add({ targets: v.body, alpha: 1, duration: 400 });
    } else if (ev.t === 'xp' && ev.id === this.player.id) {
      const { sx, sy } = toScreen(this.player.x, this.player.y);
      this.floatText(sx, sy - 80, `+${ev.amount} XP`, '#9be7ff', 13);
    } else if (ev.t === 'portal' && ev.id === this.player.id && !this.net && !this.leaving) {
      this.leaving = true;
      const p = this.player, data: SceneData = { cls: p.type, save: this.world.save(p), map: ev.to, at: ev.spawn, vitals: { hp: p.hp, mp: p.mp } };
      data.save!.map = ev.to; writeSave(data.save!);
      // don't wait on camerafadeoutcomplete: it never fires if another fade is running
      this.cameras.main.fadeOut(200, 27, 31, 42);
      this.time.delayedCall(220, () => this.scene.restart(data));
    } else if (ev.t === 'talk' && ev.id === this.player.id) {
      this.hud.openNpc(ev.npc);
    } else if (ev.t === 'transform') {
      const e = this.world.entities.get(ev.id)!, v = this.views.get(e.id)!;
      const card = this.world.cardOf(e), base = defs.classes[e.type];
      const sprite = card ? card.sprite : base.sprite, height = card ? card.height : base.height;
      v.body.setTexture(sprite); v.scale = height / v.body.height; v.height = height;
      v.aura?.destroy(); v.aura = undefined;
      if (card) v.aura = this.add.ellipse(0, 0, 56, 26, parseInt(card.aura, 16), 0.35).setDepth(2).setStrokeStyle(2, parseInt(card.aura, 16), 0.9);
      const { sx, sy } = toScreen(e.x, e.y);
      const g = this.add.graphics().setDepth(9000).setPosition(sx, sy - height / 2);
      g.fillStyle(card ? parseInt(card.aura, 16) : 0xffffff, 0.8).fillCircle(0, 0, 30);
      this.tweens.add({ targets: g, scale: 2.5, alpha: 0, duration: 500, onComplete: () => g.destroy() });
      if (e.id === this.player.id) this.hud.toast(card ? `แปลงร่างเป็น ${card.name}` : 'คืนร่าง', card ? 'rare' : 'muted');
    } else if (ev.t === 'upgrade' && ev.id === this.player.id) {
      const d = defs.items[ev.item];
      this.hud.toast(ev.ok ? `ตีบวกสำเร็จ! ${d.name} +${ev.up}` : `ตีบวกล้มเหลว ${d.name} ยังเป็น +${ev.up}`, ev.ok ? 'uncommon' : 'warn');
    } else if (ev.t === 'cardLevel' && ev.id === this.player.id) {
      this.hud.toast(`${defs.items[ev.card].name} เลเวลอัป! Lv ${ev.lv}${ev.lv === 3 ? ' · ปลดล็อกสกิลที่ 3' : ''}`, 'rare');
    } else if (ev.t === 'skill') {
      this.skillFx(ev.skill, ev.x, ev.y, ev.aoe);
    } else if (ev.t === 'heal') {
      const e = this.world.entities.get(ev.to)!, { sx, sy } = toScreen(e.x, e.y);
      this.floatText(sx, sy - 75, `+${ev.amount}`, ev.mp ? '#7fb2ff' : '#6ff08f', 15);
    } else if (ev.t === 'loot' && ev.id === this.player.id) {
      const d = defs.items[ev.item];
      this.hud.toast(ev.sold ? `ขายอัตโนมัติ ${d.name} +${d.price * ev.qty} G` : `ได้รับ ${d.icon} ${d.name}${ev.qty > 1 ? ' ×' + ev.qty : ''}`, ev.sold ? 'muted' : d.rarity);
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
    const magic = a.stats?.attackType === 'magic';
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

  private drawTargetRing() {
    this.ring.clear();
    const t = this.player.target != null ? this.world.entities.get(this.player.target) : undefined;
    if (!t || t.dead) return;
    const { sx, sy } = toScreen(t.x, t.y);
    this.ring.lineStyle(2, 0xff5d5d, 0.9).strokeEllipse(sx, sy + 1, t.boss ? 64 : 40, t.boss ? 30 : 18);
  }

  // Ground is baked into one texture; trees/rocks are shared textures. Graphics objects re-tessellate every frame.
  private drawGround(map: MapData) {
    const minX = -map.height * TW / 2 - TW / 2, maxX = map.width * TW / 2 + TW / 2;
    const minY = -TH / 2, maxY = (map.width + map.height) * TH / 2 + TH / 2;
    const g = this.make.graphics({}, false);
    g.translateCanvas(-minX, -minY);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      const { sx, sy } = toScreen(x, y);
      const water = this.world.isWater(x, y);
      const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      const stone = map.ground === 'stone';
      const base = water ? 0x4aa3d8 : stone ? [0xc9c2b4, 0xc2bba9, 0xd0c9bb][n % 3] : [0x7cc56b, 0x76bf65, 0x82ca70][n % 3];
      this.diamond(g, sx, sy, base, water ? 0x3a8cc0 : stone ? 0xa8a090 : 0x68ad58);
      if (!water && !stone && n % 11 === 0) { g.fillStyle(0xf4e27a, 1).fillCircle(sx - 6, sy + 2, 2); g.fillStyle(0xffffff, 1).fillCircle(sx + 8, sy - 3, 1.6); }
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
    for (const [x, y] of map.trees) { const { sx, sy } = toScreen(x, y); this.add.image(sx, sy, 'tree').setOrigin(24 / 48, 58 / 70).setDepth(10 + sy); }
    for (const [x, y] of map.rocks) { const { sx, sy } = toScreen(x, y); this.add.image(sx, sy, 'rock').setOrigin(0.5, 20 / 30).setDepth(10 + sy); }
  }

  private drawPortals(map: MapData) {
    for (const p of map.portals) {
      const { sx, sy } = toScreen(p.x, p.y);
      const ring = this.add.ellipse(sx, sy, 54, 26, 0x8f7bff, 0.35).setStrokeStyle(3, 0xc6b8ff, 1).setDepth(2);
      this.tweens.add({ targets: ring, scaleX: 1.15, scaleY: 1.15, alpha: 0.6, yoyo: true, repeat: -1, duration: 700 });
      this.add.particles(sx, sy, 'spark', { frequency: 120, lifespan: 1000, x: { min: -20, max: 20 }, speedY: { min: -40, max: -15 },
        scale: { start: 1, end: 0 }, alpha: { start: 1, end: 0 }, tint: 0xc6b8ff, blendMode: 'ADD' }).setDepth(9 + sy);
      this.label(sx, sy - 46, '⟡ ' + p.label, '#d9d0ff');
    }
  }

  private drawNpcs(map: MapData) {
    for (const n of map.npcs) {
      const d = defs.npcs[n.id], { sx, sy } = toScreen(n.x, n.y);
      this.add.ellipse(sx, sy + 1, 36, 10, 0x000000, 0.28).setDepth(2);
      const img = this.add.image(sx, sy + 3, d.sprite).setOrigin(0.5, 1).setInteractive({ useHandCursor: true });
      img.setScale(d.height / img.height).setDepth(10 + sy).setData('npc', n.id);
      this.tweens.add({ targets: img, scaleY: img.scaleY * 1.025, yoyo: true, repeat: -1, duration: 1100, ease: 'Sine.easeInOut' });
      this.label(sx, sy - d.height - 6, `${d.name} · ${d.title}`, '#ffe9a8');
    }
  }

  private label(x: number, y: number, s: string, color: string) {
    this.add.text(x, y, s, { fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold', color, stroke: '#1b1f2a', strokeThickness: 3 })
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
