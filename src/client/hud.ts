// DOM HUD: player frame, XP bar, target frame, Auto button.
import type { Entity } from '../sim/world';

export class Hud {
  private el = document.getElementById('hud')!;
  private auto = false;
  constructor(onAuto: (on: boolean) => void) {
    this.el.innerHTML = `
      <div class="frame" id="pf"><div class="name" id="pn"></div>
        <div class="bar hp"><i id="php"></i><span id="phpt"></span></div>
        <div class="bar mp"><i id="pmp"></i></div></div>
      <div class="frame target" id="tf" hidden><div class="name" id="tn"></div><div class="bar hp"><i id="thp"></i><span id="thpt"></span></div></div>
      <button id="auto" type="button">AUTO: OFF</button>
      <div id="help">คลิกพื้น = เดิน · คลิกมอน = ตี · AUTO = ตีเอง</div><div class="xp"><i id="pxp"></i><span id="pxpt"></span></div>`;
    const btn = this.$('auto');
    btn.addEventListener('click', () => { this.auto = !this.auto; btn.textContent = `AUTO: ${this.auto ? 'ON' : 'OFF'}`; btn.classList.toggle('on', this.auto); onAuto(this.auto); });
  }
  private $(id: string) { return document.getElementById(id)!; }
  update(p: Entity, xpNeed: number, t: Entity | null) {
    this.$('pn').textContent = `${p.name} · Lv ${p.level}${p.dead ? ' · กำลังเกิดใหม่…' : ''}`;
    this.$('php').style.width = `${(p.hp / p.maxHp) * 100}%`;
    this.$('phpt').textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
    this.$('pmp').style.width = `${(p.mp / Math.max(1, p.maxMp)) * 100}%`;
    this.$('pxp').style.width = `${(p.xp / xpNeed) * 100}%`;
    this.$('pxpt').textContent = `XP ${p.xp} / ${xpNeed}`;
    const tf = this.$('tf');
    tf.hidden = !t;
    if (t) {
      this.$('tn').textContent = `${t.name} · Lv ${t.level}${t.boss ? ' · BOSS' : ''}`;
      this.$('thp').style.width = `${(t.hp / t.maxHp) * 100}%`;
      this.$('thpt').textContent = `${Math.ceil(t.hp)} / ${t.maxHp}`;
    }
  }
}
