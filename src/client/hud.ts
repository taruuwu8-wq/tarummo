// DOM HUD: player/target frames, skill bar, inventory panel, toasts.
import type { Entity, World, Intent, SkillDef, InvSlot } from '../sim/world';
import { SLOTS } from '../sim/world';
import { Hotbar } from './hotbar';
import type { ItemDef, Slot } from '../core/stats';

type Tab = 'gear' | 'card' | 'use' | 'mat';
const SLOT_TH: Record<Slot, string> = { weapon: 'อาวุธ', armor: 'เกราะ', hat: 'หมวก', charm: 'ชาร์ม', card: 'การ์ด', mount: 'พาหนะ', offhand: 'อาวุธรอง' };
const RARITY_TH: Record<string, string> = { common: 'ธรรมดา', uncommon: 'ดี', rare: 'หายาก', epic: 'ตำนาน' };

export class Hud {
  private el = document.getElementById('hud')!;
  private auto = false;
  private tab: Tab = 'gear';
  private invSig = '';
  private sel: number | Slot | null = null;
  private hot!: Hotbar;
  private npc: string | null = null;
  private npcSig = '';
  private onKey: (e: KeyboardEvent) => void;

  constructor(private world: World, private p: Entity, private items: Record<string, ItemDef>, private send: (i: Intent) => void) {
    this.el.innerHTML = `
      <div class="frame" id="pf"><div class="name" id="pn"></div>
        <div class="bar hp"><i id="php"></i><span id="phpt"></span></div>
        <div class="bar mp"><i id="pmp"></i><span id="pmpt"></span></div>
        <div class="gold" id="pg"></div></div>
      <div class="frame target" id="tf" hidden><div class="name" id="tn"></div><div class="bar hp"><i id="thp"></i><span id="thpt"></span></div></div>
      <div id="toasts"></div>
      <div id="side">
        <button type="button" class="sb" id="bagbtn" title="กระเป๋า (I)"><span class="ic">🎒</span><span class="key">I</span></button>
        <button type="button" class="sb" id="skillbtn" title="สกิล (K)"><span class="ic">📖</span><span class="key">K</span></button>
        <button type="button" class="sb" id="cardbtn" title="สลับการ์ด (C)"><span class="ic">🃏</span><span class="key">C</span></button>
        <button type="button" class="sb" id="tf-btn" title="แปลงร่าง (T)"><span class="ic">✨</span><span class="key">T</span><i class="cd"></i></button>
        <button type="button" class="sb" id="mountbtn" title="ขี่พาหนะ (R)"><span class="ic">🐎</span><span class="key">R</span></button>
        <button type="button" class="sb wide" id="auto">AUTO<br>OFF</button>
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
      <div id="npc" hidden></div>
      <div id="dg" hidden></div>
      <div id="chat"><div id="chatlog"></div><input id="chatin" maxlength="120" placeholder="Enter เพื่อพิมพ์แชท" autocomplete="off"></div>
      <div id="banner"></div>
      <div class="xp"><i id="pxp"></i><span id="pxpt"></span></div>`;

    this.hot = new Hotbar(this.el, world, p, items, send, (t, c) => this.toast(t, c));
    this.$('skillbtn').addEventListener('click', () => this.hot.toggle('skillwin'));
    this.$('cardbtn').addEventListener('click', () => this.hot.toggle('cardpop'));
    this.$('tf-btn').addEventListener('click', () => send({ kind: 'transform', id: p.id }));
    this.$('mountbtn').addEventListener('click', () => send({ kind: 'mount', id: p.id }));
    this.$('bagbtn').addEventListener('click', () => this.toggleBag());
    this.$('bagx').addEventListener('click', () => this.toggleBag(false));
    this.$('auto').addEventListener('click', () => this.toggleAuto());
    (this.$('autosell') as HTMLInputElement).checked = p.autoSell;
    this.$('autosell').addEventListener('change', e => send({ kind: 'autoSell', id: p.id, on: (e.target as HTMLInputElement).checked }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.addEventListener('click', () => { this.tab = b.dataset.tab as Tab; this.sel = null; this.invSig = ''; }));
    const chatIn = this.$('chatin') as HTMLInputElement;
    chatIn.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = chatIn.value.trim(); if (t) send({ kind: 'chat', id: this.p.id, text: t }); chatIn.value = ''; chatIn.blur(); }
      else if (e.key === 'Escape') chatIn.blur();
    });
    this.onKey = e => {
      if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Enter') { chatIn.focus(); e.preventDefault(); return; }
      const k = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].indexOf(e.key);
      if (k >= 0) this.hot.press(k);
      else if (e.key === 'k' || e.key === 'K') this.hot.toggle('skillwin');
      else if (e.key === 'c' || e.key === 'C') this.hot.toggle('cardpop');
      else if (e.key === 't' || e.key === 'T') this.send({ kind: 'transform', id: this.p.id });
      else if (e.key === 'r' || e.key === 'R') this.send({ kind: 'mount', id: this.p.id });
      else if (e.key === 'i' || e.key === 'I') this.toggleBag();
      else if (e.key === 'Escape') { this.toggleBag(false); this.closeNpc(); this.hot.toggle('skillwin', false); this.hot.toggle('cardpop', false); }
    };
    window.addEventListener('keydown', this.onKey);
    this.$('npc').addEventListener('click', e => this.onNpcClick(e));
  }

  destroy() { window.removeEventListener('keydown', this.onKey); }

  banner(text: string) {
    const b = this.$('banner'); b.textContent = text; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  chatLine(name: string, text: string, mine: boolean) {
    const log = this.$('chatlog'), d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = name + ': '; if (mine) b.className = 'me';
    d.append(b, document.createTextNode(text));
    log.append(d);
    while (log.children.length > 8) log.firstChild!.remove();
  }

  openNpc(id: string) { this.npc = id; this.npcSig = ''; this.$('npc').hidden = false; }
  private closeNpc() { this.npc = null; this.$('npc').hidden = true; }

  private onNpcClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!b) return;
    const p = this.p, a = b.dataset.act!;
    if (a === 'close') this.closeNpc();
    else if (a === 'buy') this.send({ kind: 'buy', id: p.id, index: Number(b.dataset.i), qty: Number(b.dataset.q) });
    else if (a === 'up') { const r = b.dataset.ref!; this.send({ kind: 'upgrade', id: p.id, ref: /^\d+$/.test(r) ? Number(r) : r as Slot }); }
    else if (a === 'heal') this.send({ kind: 'heal', id: p.id });
    else if (a === 'put') this.send({ kind: 'stashPut', id: p.id, index: Number(b.dataset.i) });
    else if (a === 'take') this.send({ kind: 'stashTake', id: p.id, index: Number(b.dataset.i) });
    else if (a === 'dbg') this.send({ kind: 'debug', id: p.id, what: b.dataset.w as 'level' });
    this.npcSig = '';
  }

  private renderNpc() {
    const p = this.p, n = this.world.map.npcs.find(x => x.id === this.npc);
    if (!n || Math.hypot(n.x - p.x, n.y - p.y) > 3.2) { this.closeNpc(); return; }
    const sig = JSON.stringify([this.npc, p.gold, p.inv, p.equip, p.hp === p.maxHp, p.level, this.world.stash]);
    if (sig === this.npcSig) return;
    this.npcSig = sig;
    const d = this.world.defs.npcs[n.id];
    let body = '';
    if (d.role === 'shop') {
      body = (d.sells ?? []).map((o, i) => {
        const it = this.items[o.item], stack = it.slot === 'use' || it.slot === 'mat';
        const req = it.class ? ` · ${this.world.defs.classes[it.class].name}` : '';
        return `<div class="row"><span class="ic">${it.icon}</span><span class="nm ${it.rarity}-t">${it.name}<small class="muted">${it.level && it.level > 1 ? ' Lv' + it.level : ''}${req}</small></span>
          <span class="pr">${o.price} G</span><button type="button" data-act="buy" data-i="${i}" data-q="1"${p.gold < o.price ? ' disabled' : ''}>ซื้อ</button>${stack ? `<button type="button" data-act="buy" data-i="${i}" data-q="10"${p.gold < o.price * 10 ? ' disabled' : ''}>×10</button>` : ''}</div>`;
      }).join('');
    } else if (d.role === 'smith') {
      const refs: { ref: string; st: InvSlot; where: string }[] = [];
      for (const sl of this.world.defs.upgrade.slots) { const st = p.equip[sl]; if (st) refs.push({ ref: sl, st, where: 'สวมอยู่' }); }
      p.inv.forEach((st, i) => { if (this.world.defs.upgrade.slots.includes(this.items[st.item].slot as Slot)) refs.push({ ref: String(i), st, where: 'ในกระเป๋า' }); });
      body = refs.map(({ ref, st, where }) => {
        const it = this.items[st.item], c = this.world.upgradeCost(st);
        if (!c) return `<div class="row"><span class="ic">${it.icon}</span><span class="nm">${it.name} +${st.up}<small class="muted"> · ${where}</small></span><span class="pr">สูงสุด</span></div>`;
        const m = this.items[c.mat], have = p.inv.find(x => x.item === c.mat)?.qty ?? 0, ok = p.gold >= c.gold && have >= c.qty;
        return `<div class="row"><span class="ic">${it.icon}</span><span class="nm ${it.rarity}-t">${it.name} +${st.up ?? 0}<small class="muted"> · ${where}<br>${Math.round(c.rate * 100)}% · ${c.gold} G · ${m.icon}${have}/${c.qty}</small></span>
          <button type="button" data-act="up" data-ref="${ref}"${ok ? '' : ' disabled'}>ตีบวก</button></div>`;
      }).join('') || '<p class="muted">ไม่มีอาวุธ เกราะ หรือการ์ดให้ตีบวก</p>';
      body += '<p class="muted small">ล้มเหลว = เสียทองและวัตถุดิบ ของไม่หาย</p>';
    } else if (d.role === 'stash') {
      const cell = (st: InvSlot, i: number, act: string) => { const it = this.items[st.item];
        return `<button type="button" class="cell ${it.rarity}" data-act="${act}" data-i="${i}" title="${it.name}"><span class="ic">${it.icon}</span>${st.up ? `<em>+${st.up}</em>` : ''}${st.qty > 1 ? `<b>${st.qty}</b>` : ''}</button>`; };
      body = `<b>คลังกลาง (${this.world.stash.length}/60) · คลิกเพื่อหยิบ</b><div class="grid">${this.world.stash.map((st, i) => cell(st, i, 'take')).join('') || '<span class="muted">ว่าง</span>'}</div>
        <b>กระเป๋า · คลิกเพื่อฝาก</b><div class="grid">${p.inv.map((st, i) => cell(st, i, 'put')).join('') || '<span class="muted">ว่าง</span>'}</div>`;
    } else if (d.role === 'debug') {
      body = [['level', '+1 เลเวล'], ['level5', '+5 เลเวล'], ['gold', '+10,000 G'], ['mats', 'วัตถุดิบตีบวก ×30'], ['card', 'การ์ดสุ่มของอาชีพ'], ['job', 'การ์ดที่ใส่ Job +3']]
        .map(([w, t]) => `<button type="button" class="big" data-act="dbg" data-w="${w}">${t}</button>`).join('');
    } else {
      body = `<button type="button" class="big" data-act="heal">${p.hp >= p.maxHp ? 'HP/MP เต็มแล้ว' : 'ฟื้นฟู HP/MP (ฟรี)'}</button>`;
    }
    this.$('npc').innerHTML = `<div class="bag-head"><b>${d.name} · ${d.title}</b><button type="button" data-act="close" aria-label="ปิด">✕</button></div>
      <p class="greet">“${d.greet}”</p><div class="gold">💰 ${p.gold.toLocaleString()} G</div><div class="rows">${body}</div>`;
  }

  private $(id: string) { return document.getElementById(id)!; }
  private cast(skill: string) { this.send({ kind: 'skill', id: this.p.id, skill }); }
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
    this.hot.update();
    const tb = this.$('tf-btn'), card = p.equip.card;
    tb.classList.toggle('on', p.transformed); tb.classList.toggle('nomp', !card);
    (tb.querySelector('.ic') as HTMLElement).textContent = card ? this.items[card.item].icon : '✨';
    const tl = Math.max(0, (p.cooldowns['transform'] ?? 0) - now);
    (tb.querySelector('.cd') as HTMLElement).style.height = `${Math.min(1, tl / 10000) * 100}%`;
    const mb = this.$('mountbtn'), mt = p.equip.mount;
    mb.classList.toggle('on', p.mounted); mb.classList.toggle('nomp', !mt);
    (mb.querySelector('.ic') as HTMLElement).textContent = mt ? this.items[mt.item].icon : '🐎';
    const d = this.world.map.dungeon, dgEl = this.$('dg');
    dgEl.hidden = !d;
    if (d) {
      const st = this.world.dungeon, t = Math.floor((st.cleared || st.active ? st.timeMs : 0) / 1000);
      const time = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      const next = st.timeMs / 1000 <= d.rankSec.S ? `S ≤ ${d.rankSec.S / 60} นาที` : st.timeMs / 1000 <= d.rankSec.A ? `A ≤ ${d.rankSec.A / 60} นาที` : 'B';
      dgEl.textContent = st.cleared ? `เคลียร์แล้ว · อันดับ ${st.rank} · ${time} · ไปที่พอร์ทัลท้ายห้องเพื่อออก`
        : `ห้อง ${Math.min(st.room + 1, d.rooms.length)}/${d.rooms.length}${st.room === d.rooms.length - 1 ? ' (บอส)' : ''} · ⏱ ${time} · ${next}`;
    }
    if (!this.$('bag').hidden) this.renderBag();
    if (this.npc) this.renderNpc();
  }

  private renderBag() {
    const p = this.p;
    const sig = JSON.stringify([p.inv, p.equip, p.level, p.gold, this.tab, this.sel, p.transformed]);
    if (sig === this.invSig) return;
    this.invSig = sig;
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab));
    const badge = (st: InvSlot) => (st.up || st.lv) ? `<em>${st.up ? '+' + st.up : ''}${st.lv ? (st.up ? ' ' : '') + 'Lv' + st.lv : ''}</em>` : '';
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
      extra = `<div class="muted">ตีบวก +${st.up ?? 0} → +${(st.up ?? 0) + 1} · โอกาส ${Math.round(cost.rate * 100)}% · ${cost.gold} G + ${m.icon} ${m.name} ${have}/${cost.qty} <br><small>ตีบวกได้ที่ช่าง Brann ในเมือง</small></div>`;
    } else if (cost === null) extra = '<div class="muted">ตีบวกสูงสุดแล้ว (+10)</div>';
    if (card) {
      const u = this.world.defs.upgrade, lv = st.lv ?? 1;
      const pu = Object.entries(u.card.perUp).map(([k, v]) => `${k.toUpperCase()} +${k === 'elemRate' ? Math.round(v * (st.up ?? 0) * 100) + '%' : v * (st.up ?? 0)}`).join(' · ');
      extra += `<div class="muted">${(st.up ?? 0) > 0 ? `ตีบวก +${st.up}: ${pu}<br>` : ''}${card.role} · การ์ด Lv ${lv}${lv < u.cardMaxLevel ? ` (${st.xp ?? 0}/${u.cardXpPerLevel * lv} XP ตอนแปลงร่าง)` : ' (สูงสุด)'} · โบนัส +${(lv - 1) * 10}%</div>
        <div class="muted">สกิล: ${card.skills.map(k => `${k.icon} ${k.name}${k.unlock > lv ? ` (Job ${k.unlock})` : ''}`).join(' · ')}</div>`;
    }
    det.innerHTML = `<div><b class="${d.rarity}-t">${d.icon} ${d.name}${st.up ? ' +' + st.up : ''}</b> <small class="muted">${RARITY_TH[d.rarity]}${req ? ' · ต้องการ ' + req : ''}${worn ? ' · สวมอยู่' : ''}</small></div>
      <div class="muted">${lines.join(' · ') || 'วัตถุดิบ ใช้ตีบวกอุปกรณ์'}</div>${extra}
      <div class="acts">${canEquip ? '<button type="button" id="act-eq">สวมใส่</button>' : ''}${worn ? '<button type="button" id="act-un">ถอด</button>' : ''}${canUse ? '<button type="button" id="act-use">ใช้</button>' : ''}${worn ? '' : `<button type="button" id="act-sell">ขาย ${d.price * st.qty} G</button>`}</div>`;
    const i = this.sel as number, sl = this.sel as Slot;
    document.getElementById('act-eq')?.addEventListener('click', () => { this.send({ kind: 'equip', id: p.id, index: i }); this.sel = d.slot as Slot; });
    document.getElementById('act-un')?.addEventListener('click', () => { this.send({ kind: 'unequip', id: p.id, slot: sl }); this.sel = null; });
    document.getElementById('act-up')?.addEventListener('click', () => { this.send({ kind: 'upgrade', id: p.id, ref: this.sel as number | Slot }); this.invSig = ''; });
    document.getElementById('act-use')?.addEventListener('click', () => this.send({ kind: 'use', id: p.id, index: i }));
    document.getElementById('act-sell')?.addEventListener('click', () => { this.send({ kind: 'sell', id: p.id, index: i }); this.sel = null; });
  }
}

export type { SkillDef };
