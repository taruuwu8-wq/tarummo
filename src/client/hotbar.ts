// Hotbar (10 slots, per form), skills window (K), card quick-switch (C), pointer drag & drop (works on touch).
import type { Entity, World, Intent, BarRef } from '../sim/world';
import { BAR_SIZE } from '../sim/world';
import type { ItemDef } from '../core/stats';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export class Hotbar {
  private barSig = '';
  private winSig = '';
  private cardSig = '';
  private drag: { ref: string; from: number | null; ghost: HTMLElement | null; x: number; y: number } | null = null;

  constructor(private root: HTMLElement, private world: World, private p: Entity, private items: Record<string, ItemDef>,
    private send: (i: Intent) => void, private toast: (t: string, c?: string) => void) {
    root.insertAdjacentHTML('beforeend', `
      <div id="bar"></div>
      <div id="skillwin" class="panel" hidden><div class="bag-head"><b>สกิล</b><button type="button" data-close="skillwin" aria-label="ปิด">✕</button></div><div id="skillbody"></div></div>
      <div id="cardpop" class="panel" hidden><div class="bag-head"><b>สลับการ์ด</b><button type="button" data-close="cardpop" aria-label="ปิด">✕</button></div><div id="cardbody"></div></div>`);
    root.querySelectorAll<HTMLElement>('[data-close]').forEach(b => b.addEventListener('click', () => { document.getElementById(b.dataset.close!)!.hidden = true; }));
    root.addEventListener('pointerdown', e => this.down(e));
    window.addEventListener('pointermove', e => this.move(e));
    window.addEventListener('pointerup', e => this.up(e));
    document.getElementById('cardbody')!.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-card]'); if (!b) return;
      this.send({ kind: 'switchCard', id: this.p.id, index: Number(b.dataset.card) });
    });
  }

  toggle(id: 'skillwin' | 'cardpop', force?: boolean) {
    const el = document.getElementById(id)!; el.hidden = force === undefined ? !el.hidden : !force;
    this.winSig = this.cardSig = '';
  }

  /** Press a hotbar slot (keyboard 1-0 or tap). */
  press(i: number) {
    const ref = this.world.barOf(this.p)[i];
    if (!ref) return;
    const id = ref.slice(2);
    if (ref.startsWith('s:')) {
      if (!this.world.skillsOf(this.p).some(k => k.id === id)) { this.toast('สกิลนี้ยังไม่ปลดล็อก', 'warn'); return; }
      this.send({ kind: 'skill', id: this.p.id, skill: id });
    } else {
      const idx = this.p.inv.findIndex(s => s.item === id);
      if (idx < 0) { this.toast(`ไม่มี ${this.items[id]?.name ?? id}`, 'warn'); return; }
      this.send({ kind: 'use', id: this.p.id, index: idx });
    }
  }

  private icon(ref: string) {
    const id = ref.slice(2);
    if (ref.startsWith('i:')) return this.items[id]?.icon ?? '?';
    return this.world.allSkillsOf(this.p).find(k => k.id === id)?.icon ?? '?';
  }

  update() {
    const p = this.p, now = this.world.now, bar = this.world.barOf(p);
    const un = this.world.skillsOf(p), all = this.world.allSkillsOf(p);
    const sig = JSON.stringify([bar, un.map(k => k.id)]);
    if (sig !== this.barSig) {
      this.barSig = sig;
      document.getElementById('bar')!.innerHTML = Array.from({ length: BAR_SIZE }, (_, i) => {
        const ref = bar[i] ?? null;
        return `<button type="button" class="sk${ref ? '' : ' empty'}" data-slot="${i}"${ref ? ` data-ref="${ref}"` : ''}><span class="ic">${ref ? this.icon(ref) : ''}</span><span class="key">${KEYS[i]}</span><span class="mpc"></span><i class="cd"></i></button>`;
      }).join('');
    }
    // per-frame: cooldowns, mp, item counts
    document.querySelectorAll<HTMLElement>('#bar [data-slot]').forEach(b => {
      const ref = b.dataset.ref; if (!ref) return;
      const id = ref.slice(2), cd = b.querySelector<HTMLElement>('.cd')!, lab = b.querySelector<HTMLElement>('.mpc')!;
      if (ref.startsWith('s:')) {
        const k = all.find(x => x.id === id);
        const locked = !un.some(x => x.id === id);
        const left = Math.max(0, (p.cooldowns[id] ?? 0) - now);
        cd.style.height = locked ? '100%' : `${k ? (left / k.cooldownMs) * 100 : 0}%`;
        lab.textContent = k ? String(k.mp) : ''; lab.className = 'mpc';
        b.classList.toggle('nomp', !k || p.mp < k.mp || locked);
        b.classList.toggle('queued', p.pendingSkill === id);
        b.title = k ? `${k.name} · MP ${k.mp}${locked ? ' (ยังไม่ปลดล็อก)' : ''}` : '';
      } else {
        const q = p.inv.filter(s => s.item === id).reduce((a, s) => a + s.qty, 0);
        const left = Math.max(0, (p.cooldowns['potion'] ?? 0) - now);
        cd.style.height = `${(left / 1500) * 100}%`;
        lab.textContent = String(q); lab.className = 'mpc qty';
        b.classList.toggle('nomp', q === 0);
        b.title = this.items[id]?.name ?? id;
      }
    });
    if (!document.getElementById('skillwin')!.hidden) this.renderSkills();
    if (!document.getElementById('cardpop')!.hidden) this.renderCards();
  }

  private renderSkills() {
    const p = this.p, lv = this.world.unlockLevel(p), card = this.world.cardOf(p);
    const sig = JSON.stringify([this.world.formOf(p), lv, this.world.barOf(p), p.inv.map(s => s.item)]);
    if (sig === this.winSig) return;
    this.winSig = sig;
    const unit = card ? 'Job' : 'Lv', bar = this.world.barOf(p);
    const rows = this.world.allSkillsOf(p).map(k => {
      const locked = k.unlock > lv, on = bar.includes('s:' + k.id);
      const what = k.heal ? `ฟื้น HP ${k.heal * 100}%` : `×${k.mult}${k.hits ? ` ${k.hits} ครั้ง` : ''}${k.aoe ? ' · วงกว้าง' : ''}${k.offhand ? ' · อาวุธรอง' : ''}${k.element ? ' · ' + k.element : ''}`;
      return `<div class="srow${locked ? ' locked' : ''}"><span class="sic"${locked ? '' : ` data-drag="s:${k.id}"`}>${k.icon}</span>
        <span class="snm"><b>${k.name}</b><small>${locked ? `🔒 ปลดล็อก ${unit} ${k.unlock}` : `MP ${k.mp} · ${k.cooldownMs / 1000}s · ${what}`}${on ? ' · อยู่บนแถบ' : ''}</small></span></div>`;
    }).join('');
    const pas = card ? (card.passives ?? []).map(ps => `<div class="srow${ps.unlock > lv ? ' locked' : ''}"><span class="sic">${ps.icon}</span><span class="snm"><b>${ps.name}</b><small>${ps.unlock > lv ? `🔒 Job ${ps.unlock}` : 'ทำงานอัตโนมัติ'} · ${ps.desc}</small></span></div>`).join('') : '';
    const uses = [...new Set(p.inv.filter(s => this.items[s.item].heal).map(s => s.item))]
      .map(id => `<span class="sic" data-drag="i:${id}" title="${this.items[id].name}">${this.items[id].icon}</span>`).join('');
    document.getElementById('skillbody')!.innerHTML = `
      <p class="muted small">${card ? `ร่าง ${card.name} · Job ${lv}` : `ร่างปกติ · Lv ${lv}`} · ลากไอคอนลงแถบด้านล่าง ลากออกจากแถบเพื่อเอาออก</p>
      ${rows}${pas ? `<b>Passive</b>${pas}` : ''}<b>ของใช้</b><div class="uses">${uses || '<span class="muted">ไม่มี</span>'}</div>`;
  }

  private renderCards() {
    const p = this.p;
    const sig = JSON.stringify([p.inv.map(s => s.item), p.equip.card, p.transformed]);
    if (sig === this.cardSig) return;
    this.cardSig = sig;
    const cur = p.equip.card;
    const list = p.inv.map((st, i) => ({ st, i, d: this.items[st.item] })).filter(c => c.d.slot === 'card' && c.d.class === p.type);
    document.getElementById('cardbody')!.innerHTML = `
      ${cur ? `<div class="crow cur"><span class="sic">${this.items[cur.item].icon}</span><span class="snm"><b>${this.items[cur.item].name}</b><small>ใส่อยู่ · +${cur.up ?? 0} · Job ${cur.lv ?? 1}${p.transformed ? ' · แปลงร่างอยู่' : ''}</small></span></div>` : ''}
      ${list.map(c => `<button type="button" class="crow" data-card="${c.i}"><span class="sic">${c.d.icon}</span><span class="snm"><b>${c.d.name}</b><small>+${c.st.up ?? 0} · Job ${c.st.lv ?? 1}</small></span></button>`).join('') || '<p class="muted">ไม่มีการ์ดอื่นในกระเป๋า</p>'}
      <p class="muted small">${p.transformed ? 'สลับตอนแปลงร่าง = แปลงเป็นใบใหม่ทันที (คูลดาวน์ 10 วิ)' : 'กด T เพื่อแปลงร่าง'}</p>`;
  }

  // ---- drag & drop ----
  private down(e: PointerEvent) {
    const t = e.target as HTMLElement;
    const src = t.closest<HTMLElement>('[data-drag]'), slot = t.closest<HTMLElement>('#bar [data-slot]');
    if (src) this.drag = { ref: src.dataset.drag!, from: null, ghost: null, x: e.clientX, y: e.clientY };
    else if (slot) this.drag = { ref: slot.dataset.ref ?? '', from: Number(slot.dataset.slot), ghost: null, x: e.clientX, y: e.clientY };
    if (this.drag && src) e.preventDefault();
  }
  private move(e: PointerEvent) {
    const d = this.drag; if (!d || !d.ref) return;
    if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      d.ghost = document.createElement('div'); d.ghost.className = 'ghost'; d.ghost.textContent = this.icon(d.ref);
      document.body.appendChild(d.ghost);
    }
    if (d.ghost) { d.ghost.style.left = `${e.clientX}px`; d.ghost.style.top = `${e.clientY}px`; }
  }
  private up(e: PointerEvent) {
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (!d.ghost) { if (d.from !== null) this.press(d.from); return; }   // plain tap
    d.ghost.remove();
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('#bar [data-slot]');
    const ref: BarRef = d.ref;
    if (over) this.send({ kind: 'setBar', id: this.p.id, slot: Number(over.dataset.slot), ref });
    else if (d.from !== null) this.send({ kind: 'setBar', id: this.p.id, slot: d.from, ref: null });
    this.barSig = this.winSig = '';
  }
}
