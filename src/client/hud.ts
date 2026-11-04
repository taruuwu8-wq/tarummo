// DOM HUD: player/target frames, skill bar, inventory panel, toasts.
import type { Entity, World, Intent, SkillDef, InvSlot } from '../sim/world';
import { SLOTS } from '../sim/world';
import type { ItemDef, Slot } from '../core/stats';

type Tab = 'gear' | 'card' | 'use' | 'mat';
const SLOT_TH: Record<Slot, string> = { weapon: 'อาวุธ', armor: 'เกราะ', hat: 'หมวก', charm: 'ชาร์ม', card: 'การ์ด' };
const RARITY_TH: Record<string, string> = { common: 'ธรรมดา', uncommon: 'ดี', rare: 'หายาก', epic: 'ตำนาน' };

export class Hud {
  private el = document.getElementById('hud')!;
  private auto = false;
  private tab: Tab = 'gear';
  private invSig = '';
  private sel: number | Slot | null = null;
  private skillSig = '';

  constructor(private world: World, private p: Entity, private items: Record<string, ItemDef>, private send: (i: Intent) => void) {
    this.el.innerHTML = `
      <div class="frame" id="pf"><div class="name" id="pn"></div>
        <div class="bar hp"><i id="php"></i><span id="phpt"></span></div>
        <div class="bar mp"><i id="pmp"></i><span id="pmpt"></span></div>
        <div class="gold" id="pg"></div></div>
      <div class="frame target" id="tf" hidden><div class="name" id="tn"></div><div class="bar hp"><i id="thp"></i><span id="thpt"></span></div></div>
      <div id="toasts"></div>
      <div id="bar">
        <span id="skills"></span>
        <button type="button" class="sk" id="tf-btn" title="แปลงร่าง (T)"><span class="ic">✨</span><span class="key">T</span><i class="cd"></i></button>
        <button type="button" class="sk" id="potion" title="HP Potion"><span class="ic">🧪</span><span class="key">Q</span><span class="mpc" id="potq"></span><i class="cd"></i></button>
        <button type="button" class="sk wide" id="bagbtn" title="กระเป๋า"><span class="ic">🎒</span><span class="key">I</span></button>
        <button type="button" class="sk wide" id="auto">AUTO<br>OFF</button>
      </div>
      <div id="bag" hidden>
        <div class="bag-head"><b>กระเป๋า</b><button type="button" id="bagx" aria-label="ปิด">✕</button></div>
        <div class="equip" id="equip"></div>
        <div class="stats" id="stats"></div>
        <div class="tabs">${(['gear', 'card', 'use', 'mat'] as Tab[]).map(t => `<button type="button" data-tab="${t}">${{ gear: 'อุปกรณ์', card: 'การ์ด', use: 'ของใช้', mat: 'วัตถุดิบ' }[t]}</button>`).join('')}</div>
        <div class="grid" id="grid"></div>
        <div class="detail" id="detail"></div>
        <label class="autosell"><input type="checkbox" id="autosell"> ขายอุปกรณ์ระดับธรรมดาอัตโนมัติ</label>
      </div>
      <div class="xp"><i id="pxp"></i><span id="pxpt"></span></div>`;

    this.$('skills').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sk]'); if (b) this.cast(b.dataset.sk!); });
    this.$('tf-btn').addEventListener('click', () => send({ kind: 'transform', id: p.id }));
    this.$('potion').addEventListener('click', () => this.potion());
    this.$('bagbtn').addEventListener('click', () => this.toggleBag());
    this.$('bagx').addEventListener('click', () => this.toggleBag(false));
    this.$('auto').addEventListener('click', () => this.toggleAuto());
    (this.$('autosell') as HTMLInputElement).checked = p.autoSell;
    this.$('autosell').addEventListener('change', e => send({ kind: 'autoSell', id: p.id, on: (e.target as HTMLInputElement).checked }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.addEventListener('click', () => { this.tab = b.dataset.tab as Tab; this.sel = null; this.invSig = ''; }));
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      const n = Number(e.key), skills = this.world.skillsOf(this.p);
      if (n >= 1 && n <= skills.length) this.cast(skills[n - 1].id);
      else if (e.key === 't' || e.key === 'T') this.send({ kind: 'transform', id: this.p.id });
      else if (e.key === 'q' || e.key === 'Q') this.potion();
      else if (e.key === 'i' || e.key === 'I') this.toggleBag();
      else if (e.key === 'Escape') this.toggleBag(false);
    });
  }

  private $(id: string) { return document.getElementById(id)!; }
  private cast(skill: string) { this.send({ kind: 'skill', id: this.p.id, skill }); }
  private potion() { const i = this.p.inv.findIndex(s => this.items[s.item].heal?.hp); if (i >= 0) this.send({ kind: 'use', id: this.p.id, index: i }); else this.toast('ไม่มี HP Potion'); }
  private toggleBag(force?: boolean) { const b = this.$('bag'); b.hidden = force === undefined ? !b.hidden : !force; this.invSig = ''; }
  private toggleAuto() {
    this.auto = !this.auto;
    const btn = this.$('auto'); btn.innerHTML = `AUTO<br>${this.auto ? 'ON' : 'OFF'}`; btn.classList.toggle('on', this.auto);
    this.send({ kind: 'auto', id: this.p.id, on: this.auto });
  }

  toast(text: string, cls = '') {
    const t = document.createElement('div'); t.className = `toast ${cls}`; t.textContent = text;
    const box = this.$('toasts'); box.prepend(t);
    while (box.children.length > 5) box.lastChild!.remove();
    setTimeout(() => t.remove(), 2600);
  }

  update(xpNeed: number, t: Entity | null) {
    const p = this.p;
    this.$('pn').textContent = `${p.name} · Lv ${p.level}${p.dead ? ' · กำลังเกิดใหม่…' : ''}`;
    this.$('php').style.width = `${(p.hp / p.maxHp) * 100}%`;
    this.$('phpt').textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
    this.$('pmp').style.width = `${(p.mp / Math.max(1, p.maxMp)) * 100}%`;
    this.$('pmpt').textContent = `${Math.floor(p.mp)} / ${p.maxMp}`;
    this.$('pg').textContent = `💰 ${p.gold.toLocaleString()} G`;
    this.$('pxp').style.width = `${(p.xp / xpNeed) * 100}%`;
    this.$('pxpt').textContent = `XP ${p.xp} / ${xpNeed}`;
    const tf = this.$('tf'); tf.hidden = !t;
    if (t) {
      this.$('tn').textContent = `${t.name} · Lv ${t.level}${t.boss ? ' · BOSS' : ''}`;
      this.$('thp').style.width = `${(t.hp / t.maxHp) * 100}%`;
      this.$('thpt').textContent = `${Math.ceil(t.hp)} / ${t.maxHp}`;
    }
    // skill bar follows the active form
    const now = this.world.now;
    const sks = this.world.skillsOf(p), sig = sks.map(k => k.id).join();
    if (sig !== this.skillSig) {
      this.skillSig = sig;
      this.$('skills').innerHTML = sks.map((s, i) => `<button type="button" class="sk" data-sk="${s.id}" title="${s.name} · MP ${s.mp}"><span class="ic">${s.icon}</span><span class="key">${i + 1}</span><span class="mpc">${s.mp}</span><i class="cd"></i></button>`).join('');
    }
    const tb = this.$('tf-btn'), card = p.equip.card;
    tb.classList.toggle('on', p.transformed); tb.classList.toggle('nomp', !card);
    (tb.querySelector('.ic') as HTMLElement).textContent = card ? this.items[card.item].icon : '✨';
    const tl = Math.max(0, (p.cooldowns['transform'] ?? 0) - now);
    (tb.querySelector('.cd') as HTMLElement).style.height = `${Math.min(1, tl / 10000) * 100}%`;
    for (const s of this.world.skillsOf(p)) {
      const b = this.el.querySelector<HTMLElement>(`[data-sk="${s.id}"]`)!;
      const left = Math.max(0, (p.cooldowns[s.id] ?? 0) - now);
      (b.querySelector('.cd') as HTMLElement).style.height = `${(left / s.cooldownMs) * 100}%`;
      b.classList.toggle('nomp', p.mp < s.mp);
      b.classList.toggle('queued', p.pendingSkill === s.id);
    }
    const pl = Math.max(0, (p.cooldowns['potion'] ?? 0) - now);
    (this.$('potion').querySelector('.cd') as HTMLElement).style.height = `${(pl / 1500) * 100}%`;
    this.$('potq').textContent = String(p.inv.filter(s => this.items[s.item].heal?.hp).reduce((a, s) => a + s.qty, 0));
    if (!this.$('bag').hidden) this.renderBag();
  }

  private renderBag() {
    const p = this.p;
    const sig = JSON.stringify([p.inv, p.equip, p.level, p.gold, this.tab, this.sel, p.transformed]);
    if (sig === this.invSig) return;
    this.invSig = sig;
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab));
    const badge = (st: InvSlot) => st.lv ? `<em>Lv${st.lv}</em>` : st.up ? `<em>+${st.up}</em>` : '';
    this.$('equip').innerHTML = SLOTS.map(s => {
      const st = p.equip[s], d = st ? this.items[st.item] : null;
      return `<button type="button" class="slot ${d ? d.rarity : 'empty'}${this.sel === s ? ' sel' : ''}" data-slot="${s}" title="${d ? d.name : SLOT_TH[s]}"><span class="ic">${d ? d.icon : ''}</span>${st ? badge(st) : ''}<small>${SLOT_TH[s]}</small></button>`;
    }).join('');
    this.$('equip').querySelectorAll<HTMLButtonElement>('[data-slot]').forEach(b => b.addEventListener('click', () => { const sl = b.dataset.slot as Slot; if (p.equip[sl]) { this.sel = sl; this.invSig = ''; } }));
    const s = p.stats;
    this.$('stats').innerHTML = `<span>ATK ${s.baseAtk + s.weapon.min}–${s.baseAtk + s.weapon.max}</span><span>DEF ${s.armor.melee}/${s.armor.ranged}/${s.armor.magic}</span><span>ACC ${s.acc}</span><span>EVA ${s.eva}</span><span>CRIT ${Math.round(s.critRate * 100)}%</span>${s.elemRate ? `<span>ธาตุ ${Math.round(s.elemRate * 100)}%</span>` : ''}`;

    const inTab = (d: ItemDef) => this.tab === 'gear' ? SLOTS.includes(d.slot as Slot) && d.slot !== 'card' : d.slot === this.tab;
    const cells = p.inv.map((st, i) => ({ st, i, d: this.items[st.item] })).filter(c => inTab(c.d));
    this.$('grid').innerHTML = cells.map(c => `<button type="button" class="cell ${c.d.rarity}${this.sel === c.i ? ' sel' : ''}" data-i="${c.i}" title="${c.d.name}"><span class="ic">${c.d.icon}</span>${badge(c.st)}${c.st.qty > 1 ? `<b>${c.st.qty}</b>` : ''}</button>`).join('')
      + `<span class="count">${p.inv.length} / 30</span>`;
    this.$('grid').querySelectorAll<HTMLButtonElement>('[data-i]').forEach(b => b.addEventListener('click', () => { this.sel = Number(b.dataset.i); this.invSig = ''; }));

    const det = this.$('detail');
    const worn = typeof this.sel === 'string';
    const st = this.sel == null ? undefined : worn ? p.equip[this.sel as Slot] : p.inv[this.sel as number];
    if (!st) { det.innerHTML = '<span class="muted">เลือกไอเทมเพื่อดูรายละเอียด</span>'; return; }
    const d = this.items[st.item];
    const lines: string[] = [];
    if (d.weapon) lines.push(`ดาเมจ ${d.weapon.min}–${d.weapon.max} · คริ +${Math.round(d.weapon.critDmg * 100)}%`);
    for (const [k, v] of Object.entries(d.bonus ?? {})) lines.push(`${k.toUpperCase()} +${k === 'critRate' || k === 'elemRate' || k === 'dmgPct' ? Math.round(v * 100) + '%' : v}`);
    if (d.heal?.hp) lines.push(`ฟื้น HP ${d.heal.hp * 100}%`);
    if (d.heal?.mp) lines.push(`ฟื้น MP ${d.heal.mp * 100}%`);
    const req = [d.level && d.level > 1 ? `Lv ${d.level}` : '', d.class ? this.world.defs.classes[d.class].name : ''].filter(Boolean).join(' · ');
    const canEquip = !worn && SLOTS.includes(d.slot as Slot), canUse = !worn && !!d.heal;
    const cost = this.world.defs.upgrade.slots.includes(d.slot as Slot) ? this.world.upgradeCost(st) : undefined;
    const card = d.slot === 'card' ? this.world.defs.cards[st.item] : undefined;
    let extra = '';
    if (cost) {
      const have = p.inv.find(x => x.item === cost.mat)?.qty ?? 0, m = this.items[cost.mat];
      extra = `<div class="muted">ตีบวก +${st.up ?? 0} → +${(st.up ?? 0) + 1} · โอกาส ${Math.round(cost.rate * 100)}% · ${cost.gold} G + ${m.icon} ${m.name} ${have}/${cost.qty} <br><small>ล้มเหลว = เสียทองและวัตถุดิบ ของไม่หาย</small></div>`;
    } else if (cost === null) extra = '<div class="muted">ตีบวกสูงสุดแล้ว (+10)</div>';
    if (card) {
      const u = this.world.defs.upgrade, lv = st.lv ?? 1;
      extra = `<div class="muted">${card.role} · การ์ด Lv ${lv}${lv < u.cardMaxLevel ? ` (${st.xp ?? 0}/${u.cardXpPerLevel * lv} XP ตอนแปลงร่าง)` : ' (สูงสุด)'} · โบนัส +${(lv - 1) * 10}%</div>
        <div class="muted">สกิล: ${card.skills.map((k, i) => `${k.icon} ${k.name}${i >= 2 && lv < 3 ? ' (ปลดล็อก Lv3)' : ''}`).join(' · ')}</div>`;
    }
    det.innerHTML = `<div><b class="${d.rarity}-t">${d.icon} ${d.name}${st.up ? ' +' + st.up : ''}</b> <small class="muted">${RARITY_TH[d.rarity]}${req ? ' · ต้องการ ' + req : ''}${worn ? ' · สวมอยู่' : ''}</small></div>
      <div class="muted">${lines.join(' · ') || 'วัตถุดิบ ใช้ตีบวกอุปกรณ์'}</div>${extra}
      <div class="acts">${canEquip ? '<button type="button" id="act-eq">สวมใส่</button>' : ''}${worn ? '<button type="button" id="act-un">ถอด</button>' : ''}${canUse ? '<button type="button" id="act-use">ใช้</button>' : ''}${cost ? '<button type="button" id="act-up">ตีบวก</button>' : ''}${worn ? '' : `<button type="button" id="act-sell">ขาย ${d.price * st.qty} G</button>`}</div>`;
    const i = this.sel as number, sl = this.sel as Slot;
    document.getElementById('act-eq')?.addEventListener('click', () => { this.send({ kind: 'equip', id: p.id, index: i }); this.sel = d.slot as Slot; });
    document.getElementById('act-un')?.addEventListener('click', () => { this.send({ kind: 'unequip', id: p.id, slot: sl }); this.sel = null; });
    document.getElementById('act-up')?.addEventListener('click', () => { this.send({ kind: 'upgrade', id: p.id, ref: this.sel as number | Slot }); this.invSig = ''; });
    document.getElementById('act-use')?.addEventListener('click', () => this.send({ kind: 'use', id: p.id, index: i }));
    document.getElementById('act-sell')?.addEventListener('click', () => { this.send({ kind: 'sell', id: p.id, index: i }); this.sel = null; });
  }
}

export type { SkillDef };
