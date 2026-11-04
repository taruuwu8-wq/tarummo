import Phaser from 'phaser';
import { World, TICK_MS, Entity, MapData, Defs, GameEvent } from '../sim/world';
import meadow from '../../data/meadow.json';
import balance from '../../data/balance.json';
import classes from '../../data/classes.json';
import monsters from '../../data/monsters.json';
import items from '../../data/items.json';
import skills from '../../data/skills.json';
import type { SaveData } from '../sim/world';
import { writeSave } from './save';
import { Hud } from './hud';

const TW = 64, TH = 32;
const defs = { balance, classes, monsters, items, skills } as unknown as Defs;

const toScreen = (x: number, y: number) => ({ sx: (x - y) * (TW / 2), sy: (x + y) * (TH / 2) });
const toTile = (sx: number, sy: number) => ({
  x: Math.round((sx / (TW / 2) + sy / (TH / 2)) / 2),
  y: Math.round((sy / (TH / 2) - sx / (TW / 2)) / 2),
});

interface View {
  body: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Ellipse; bar: Phaser.GameObjects.Graphics;
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
    for (const d of [...Object.values(defs.classes), ...Object.values(defs.monsters)]) this.load.image(d.sprite, `sprites/${d.sprite}.png`);
  }

  create(data: { cls: string; save?: SaveData }) {
    const map = meadow as unknown as MapData;
    this.world = new World(map, defs, Date.now() & 0xffff);
    this.player = this.world.spawnPlayer(data.cls ?? 'swordsman', data.save);

    this.drawGround(map);
    this.hover = this.add.graphics().setDepth(1);
    this.marker = this.add.graphics().setDepth(1).setAlpha(0);
    this.ring = this.add.graphics().setDepth(2);
    for (const e of this.world.entities.values()) this.makeView(e);

    const cam = this.cameras.main;
    cam.setZoom(window.innerWidth < 600 ? 1.15 : 1.5);
    cam.startFollow(this.views.get(this.player.id)!.body, true, 0.12, 0.12);

    this.hud = new Hud(this.world, this.player, defs.items, i => this.world.apply(i));
    const save = () => writeSave(this.world.save(this.player));
    this.time.addEvent({ delay: 5000, loop: true, callback: save });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.drawHover(p));
    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      const hit = over.find(o => o.getData('id') !== undefined);
      if (hit) {
        const id = hit.getData('id') as number;
        if (id !== this.player.id) { this.world.apply({ kind: 'attack', id: this.player.id, target: id }); return; }
      }
      const { x, y } = toTile(p.worldX, p.worldY);
      if (!this.world.walkable(x, y)) return;
      this.world.apply({ kind: 'move', id: this.player.id, to: [x, y] });
      this.showMarker(x, y);
    });
  }

  update(_t: number, dtMs: number) {
    this.acc += Math.min(dtMs, 1000);
    while (this.acc >= TICK_MS) {
      this.world.tick(); this.acc -= TICK_MS;
      for (const ev of this.world.events) this.onEvent(ev);
      this.world.events.length = 0;
    }
    const alpha = this.acc / TICK_MS, now = this.time.now / 1000;
    for (const e of this.world.entities.values()) this.syncView(e, alpha, now, dtMs);
    this.drawTargetRing();
    const tgt = this.player.target != null ? this.world.entities.get(this.player.target) ?? null : null;
    this.hud.update(this.world.xpNeeded(this.player), tgt);
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
    v.body.setVisible(!e.dead || v.body.alpha > 0.01); v.shadow.setVisible(!e.dead);

    v.bar.clear();
    const showBar = !e.dead && (e.kind === 'player' || e.hp < e.maxHp || this.player.target === e.id);
    if (showBar) {
      const w = e.boss ? 56 : 34, bx = sx - w / 2, by = y - v.height * sqy - 8;
      v.bar.fillStyle(0x000000, 0.6).fillRect(bx - 1, by - 1, w + 2, 6);
      v.bar.fillStyle(e.kind === 'player' ? 0x5be37a : 0xe5484d, 1).fillRect(bx, by, w * (e.hp / e.maxHp), 4);
      v.bar.setDepth(5000 + sy);
    }
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
    const magic = a.stats.attackType === 'magic';
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

  private drawGround(map: MapData) {
    const g = this.add.graphics().setDepth(0);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      const { sx, sy } = toScreen(x, y);
      const water = this.world.isWater(x, y);
      const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      const base = water ? 0x4aa3d8 : [0x7cc56b, 0x76bf65, 0x82ca70][n % 3];
      this.diamond(g, sx, sy, base, water ? 0x3a8cc0 : 0x68ad58);
      if (!water && n % 11 === 0) { g.fillStyle(0xf4e27a, 1).fillCircle(sx - 6, sy + 2, 2); g.fillStyle(0xffffff, 1).fillCircle(sx + 8, sy - 3, 1.6); }
      if (this.world.isRock(x, y)) {
        const r = this.add.graphics().setDepth(10 + sy);
        r.fillStyle(0x000000, 0.25).fillEllipse(sx, sy + 4, 40, 12);
        r.fillStyle(0x8a8f9c, 1).fillEllipse(sx, sy - 4, 34, 22);
        r.fillStyle(0xa9aeba, 1).fillEllipse(sx - 5, sy - 9, 18, 10);
      }
    }
  }

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
