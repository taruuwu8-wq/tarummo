// DOM HUD: player/target frames, skill bar, inventory panel, toasts.
import type { Entity, World, Intent, SkillDef, InvSlot } from '../sim/world';
import { SLOTS } from '../sim/world';
import { Hotbar } from './hotbar';
import { AutoPanel } from './autopanel';
import { SellPanel } from './sellpanel';
import { itemName, optLines, RARE_COLOR } from './itemtext';
import type { ItemDef, Slot } from '../core/stats';

type Tab = 'gear' | 'card' | 'use' | 'enh' | 'mat' | 'drop';
const SLOT_TH: Record<Slot, string> = { weapon: 'อาวุธ', armor: 'เกราะ', hat: 'หมวก', charm: 'ชาร์ม', card: 'การ์ด', mount: 'พาหนะ', offhand: 'อาวุธรอง' };
const RARITY_TH: Record<string, string> = { common: 'ธรรมดา', uncommon: 'ดี', rare: 'หายาก', epic: 'ตำนาน' };

export class Hud {
  private el = document.getElementById('hud')!;
  autoPanel!: AutoPanel;
  private sellPanel!: SellPanel;
  private autoShown: boolean | null = null;
  private tab: Tab = 'gear';
  private invSig = '';
  private sel: number | Slot | null = null;
  private hot!: Hotbar;
  private npc: string | null = null;
  private npcSig = '';
  private useProt = false;
  private useUpProt = false;
  private confirmKey = '';
  private confirmAt = 0;
  private lockUntil = 0;
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
        <button type="button" class="sb" id="autocfgbtn" title="ตั้งค่า Auto"><span class="ic">⚙️</span></button>
        <button type="button" class="sb" id="recallbtn" title="วาร์ปกลับเมือง"><span class="ic">🏠</span></button>
        <button type="button" class="sb mobile-only" id="chatbtn" title="แชท"><span class="ic">💬</span></button>
        <button type="button" class="sb wide" id="auto">AUTO<br>OFF</button>
      </div>
      <div id="bag" hidden>
        <div class="bag-head"><b>กระเป๋า</b><span><button type="button" id="sellmode" class="pill">ขายหลายชิ้น</button><button type="button" id="bagx" aria-label="ปิด">✕</button></span></div>
        <div id="sellbox" hidden></div>
        <div class="equip" id="equip"></div>
        <div class="stats" id="stats"></div>
        <div class="tabs">${(['gear', 'card', 'use', 'enh', 'mat', 'drop'] as Tab[]).map(t => `<button type="button" data-tab="${t}">${{ gear: 'อุปกรณ์', card: 'การ์ด', use: 'ของใช้', enh: 'ของตีบวก', mat: 'วัตถุดิบ', drop: 'ดรอปมอน' }[t]}</button>`).join('')}</div>
        <div class="grid" id="grid"></div>
        <div class="detail" id="detail"></div>
        <small class="muted">ตั้งค่าขาย/ทิ้งของอัตโนมัติได้ที่ ⚙ ข้างปุ่ม AUTO</small>
      </div>
      <div id="quest"><div id="qmain"></div><div id="qdaily"></div><div id="qboss"></div><button type="button" id="qauto">▶ Auto ทำเควสต์</button></div>
      <div id="npc" hidden></div>
      <div id="dg" hidden></div>
      <div id="chat"><div id="chatlog"></div><input id="chatin" maxlength="120" placeholder="Enter เพื่อพิมพ์แชท" autocomplete="off"></div>
      <div id="banner"></div>
      <div class="xp"><i id="pxp"></i><u id="prest"></u><span id="pxpt"></span></div>`;

    this.hot = new Hotbar(this.el, world, p, items, send, (t, c) => this.toast(t, c));
    this.$('skillbtn').addEventListener('click', () => this.hot.toggle('skillwin'));
    this.$('cardbtn').addEventListener('click', () => this.hot.toggle('cardpop'));
    this.$('tf-btn').addEventListener('click', () => send({ kind: 'transform', id: p.id }));
    this.$('mountbtn').addEventListener('click', () => send({ kind: 'mount', id: p.id }));
    this.$('bagbtn').addEventListener('click', () => this.toggleBag());
    this.$('bagx').addEventListener('click', () => this.toggleBag(false));
    this.sellPanel = new SellPanel(this.$('sellbox'), world, p, items, send);
    this.$('sellmode').addEventListener('click', () => {
      const on = this.$('bag').classList.toggle('selling');
      this.$('sellbox').hidden = !on; this.$('sellmode').textContent = on ? 'กลับไปกระเป๋า' : 'ขายหลายชิ้น'; this.invSig = '';
    });
    this.$('auto').addEventListener('click', () => this.toggleAuto());
    this.autoPanel = new AutoPanel(this.el, world, p, items, send);
    this.$('autocfgbtn').addEventListener('click', () => this.autoPanel.toggle());
    this.$('recallbtn').addEventListener('click', () => send({ kind: 'recall', id: p.id }));
    this.$('qauto').addEventListener('click', () => send({ kind: 'autoQuest', id: p.id, on: !p.autoQuest }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.addEventListener('click', () => { this.tab = b.dataset.tab as Tab; this.sel = null; this.invSig = ''; }));
    const chatIn = this.$('chatin') as HTMLInputElement;
    this.$('chatbtn').addEventListener('click', () => { const c = this.$('chat'); c.classList.toggle('open'); if (c.classList.contains('open')) chatIn.focus(); });
    chatIn.addEventListener('blur', () => this.$('chat').classList.remove('open'));
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
      else if (e.key === 'Escape') { this.autoPanel.toggle(false); this.toggleBag(false); this.closeNpc(); this.hot.toggle('skillwin', false); this.hot.toggle('cardpop', false); }
    };
    window.addEventListener('keydown', this.onKey);
    this.$('npc').addEventListener('click', e => this.onNpcClick(e));
    this.$('npc').addEventListener('change', e => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'useprot') { this.useProt = t.checked; this.npcSig = ''; }
      if (t.id === 'useupprot') { this.useUpProt = t.checked; this.npcSig = ''; }
    });
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

  /** Called on rarify/upgrade results: a great roll blocks clicks for a moment so spam-clicking can't skip past it. */
  bigResult(text: string) { this.lockUntil = Date.now() + 1500; this.confirmKey = ''; this.npcSig = ''; this.banner(text); }

  openNpc(id: string) { this.npc = id; this.npcSig = ''; this.$('npc').hidden = false; }
  private closeNpc() { this.npc = null; this.$('npc').hidden = true; }

  private onNpcClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!b) return;
    const p = this.p, a = b.dataset.act!;
    if (a === 'close') this.closeNpc();
    else if (a === 'buy') this.send({ kind: 'buy', id: p.id, index: Number(b.dataset.i), qty: Number(b.dataset.q) });
    else if (a === 'up' || a === 'rare') {
      // risky actions need a second, deliberate click; and right after a big result clicks are ignored briefly
      if (Date.now() < this.lockUntil) return;
      const r = b.dataset.ref!, key = a + ':' + r, ref = /^\d+$/.test(r) ? Number(r) : r as Slot;
      if (b.dataset.risk && (this.confirmKey !== key || Date.now() - this.confirmAt > 6000)) { this.confirmKey = key; this.confirmAt = Date.now(); this.npcSig = ''; return; }
      if (b.dataset.risk && Date.now() - this.confirmAt < 600) return;
      this.confirmKey = '';
      if (a === 'up') this.send({ kind: 'upgrade', id: p.id, ref, protect: this.useUpProt });
      else this.send({ kind: 'rarify', id: p.id, ref, protect: this.useProt });
    }
    else if (a === 'heal') this.send({ kind: 'heal', id: p.id });
    else if (a === 'put') this.send({ kind: 'stashPut', id: p.id, index: Number(b.dataset.i) });
    else if (a === 'take') this.send({ kind: 'stashTake', id: p.id, index: Number(b.dataset.i) });
    else if (a === 'craft') this.send({ kind: 'craft', id: p.id, recipe: b.dataset.r!, times: Number(b.dataset.n) });
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
      const sc = p.inv.find(x => x.item === this.world.defs.upgrade.protectItem)?.qty ?? 0;
      const prot = this.useUpProt && sc > 0;
      body = `<label class="chk"><input type="checkbox" id="useupprot"${this.useUpProt ? ' checked' : ''}> ใช้ใบกันแตก (ตีบวก) · เหลือ <b class="${sc ? '' : 'warn-t'}">${sc}</b></label>
        ${this.useUpProt && !sc ? '<p class="warn-t small">⚠ ใบกันแตกหมดแล้ว! ตีบวกตอนนี้ของอาจแตก</p>' : ''}`
        + (refs.map(({ ref, st, where }) => {
        const it = this.items[st.item], c = this.world.upgradeCost(st);
        if (!c) return `<div class="row"><span class="ic">${it.icon}</span><span class="nm">${itemName(this.world, st)}<small class="muted"> · ${where}</small></span><span class="pr">สูงสุด</span></div>`;
        const m = this.items[c.mat], have = p.inv.find(x => x.item === c.mat)?.qty ?? 0, ok = p.gold >= c.gold && have >= c.qty;
        const risk = c.breakChance > 0 && !prot, armed = this.confirmKey === 'up:' + ref;
        return `<div class="row"><span class="ic">${it.icon}</span><span class="nm">${itemName(this.world, st)}<small class="muted"> · ${where}<br>สำเร็จ ${Math.round(c.rate * 100)}%${c.breakChance ? ` · <span class="${prot ? '' : 'warn-t'}">พลาดแล้วแตก ${Math.round(c.breakChance * 100)}%${prot ? ' (กันไว้)' : ''}</span>` : ''} · ${c.gold} G · ${m.icon}${have}/${c.qty}</small></span>
          <button type="button" data-act="up" data-ref="${ref}"${risk ? ' data-risk="1"' : ''} class="${armed ? 'armed' : ''}"${ok ? '' : ' disabled'}>${armed ? 'ยืนยัน! เสี่ยงแตก' : 'ตีบวก'}</button></div>`;
      }).join('') || '<p class="muted">ไม่มีอาวุธ เกราะ หรือการ์ดให้ตีบวก</p>');
      body += '<p class="muted small">+0 ถึง +4 ล้มเหลวแค่เสียทองกับวัตถุดิบ · ตั้งแต่ +5 (การ์ด +7) ล้มเหลวอาจแตก · ใบกันแตกใช้ไป 1 ใบทุกครั้งที่ติ๊กไว้</p>';
    } else if (d.role === 'stash') {
      const cell = (st: InvSlot, i: number, act: string) => { const it = this.items[st.item];
        return `<button type="button" class="cell ${it.rarity}" data-act="${act}" data-i="${i}" title="${it.name}"><span class="ic">${it.icon}</span>${st.up ? `<em>+${st.up}</em>` : ''}${st.qty > 1 ? `<b>${st.qty}</b>` : ''}</button>`; };
      body = `<b>คลังกลาง (${this.world.stash.length}/60) · คลิกเพื่อหยิบ</b><div class="grid">${this.world.stash.map((st, i) => cell(st, i, 'take')).join('') || '<span class="muted">ว่าง</span>'}</div>
        <b>กระเป๋า · คลิกเพื่อฝาก</b><div class="grid">${p.inv.map((st, i) => cell(st, i, 'put')).join('') || '<span class="muted">ว่าง</span>'}</div>`;
    } else if (d.role === 'rarer') {
      const w = this.world, r = w.defs.rarity, prot = p.inv.find(x => x.item === r.rarify.protectItem)?.qty ?? 0;
      const refs: { ref: string; st: InvSlot; where: string }[] = [];
      for (const sl of r.gearSlots) { const st = p.equip[sl as Slot]; if (st) refs.push({ ref: sl, st, where: 'สวมอยู่' }); }
      p.inv.forEach((st, i) => { if (r.gearSlots.includes(this.items[st.item].slot)) refs.push({ ref: String(i), st, where: 'ในกระเป๋า' }); });
      body = `<label class="chk"><input type="checkbox" id="useprot"${this.useProt ? ' checked' : ''}> ใช้ใบกันแตก (Rare) · เหลือ <b class="${prot ? '' : 'warn-t'}">${prot}</b></label>
        ${this.useProt && !prot ? '<p class="warn-t small">⚠ ใบกันแตก (Rare) หมดแล้ว!</p>' : ''}
        <p class="muted small">ผลสุ่ม R1-R7 · โอกาสแตก ${Math.round(r.rarify.breakChance * 100)}% (ของหายถาวร ถ้าไม่ใช้ใบกันแตก) · สุ่มออฟใหม่ตาม Rare</p>`
        + (refs.map(({ ref, st, where }) => `<div class="row"><span class="ic">${this.items[st.item].icon}</span><span class="nm">${itemName(w, st)}<small class="muted"> · ${where}</small></span>
          <span class="pr">${w.rarifyCost(st)} G</span>${(() => { const hi = (st.rare ?? 0) >= 6, noProt = !(this.useProt && prot), armed = this.confirmKey === 'rare:' + ref;
            return `<button type="button" data-act="rare" data-ref="${ref}"${hi || noProt ? ' data-risk="1"' : ''} class="${armed ? 'armed' : ''}"${p.gold < w.rarifyCost(st) ? ' disabled' : ''}>${armed ? (hi ? `ยืนยัน! สุ่มทับ R${st.rare}` : 'ยืนยัน! เสี่ยงแตก') : 'สุ่ม Rare'}</button>`; })()}</div>`).join('') || '<p class="muted">ไม่มีอาวุธ อาวุธรอง หรือเกราะ</p>');
    } else if (d.role === 'craft') {
      const w = this.world, recs = w.defs.recipes.recipes.filter(r => { const c = this.items[r.out]?.class; return !c || c === p.type; });
      const cats = [...new Set(recs.map(r => r.cat))];
      body = cats.map(cat => `<b>${cat}</b>` + recs.filter(r => r.cat === cat).map(r => {
        const out = this.items[r.out], n = w.craftable(p, r), lock = p.level < r.level;
        const need = r.inputs.map(([it, q]) => { const have = p.inv.filter(s => s.item === it).reduce((a, s) => a + s.qty, 0);
          return `<span class="${have >= q ? '' : 'warn-t'}">${this.items[it].icon}${have}/${q}</span>`; }).join(' ');
        const stack = out.slot === 'use' || out.slot === 'mat';
        return `<div class="row"><span class="ic">${out.icon}</span><span class="nm">${out.name}${r.qty > 1 ? ' ×' + r.qty : ''}${lock ? ` <small class="warn-t">ต้อง Lv ${r.level}</small>` : ''}<small class="muted"><br>${need} · ${r.gold} G</small></span>
          <button type="button" data-act="craft" data-r="${r.id}" data-n="1"${n ? '' : ' disabled'}>ทำ</button>${stack ? `<button type="button" data-act="craft" data-r="${r.id}" data-n="5"${n >= 5 ? '' : ' disabled'}>×5</button>` : ''}</div>`;
      }).join('')).join('') + '<p class="muted small">อาวุธ/เกราะที่คราฟต์จะสุ่ม Rare 0-5 เหมือนของดรอป · Shell สุ่มออฟเหมือน Shell ทั่วไป</p>';
    } else if (d.role === 'debug') {
      body = [['level', '+1 เลเวล'], ['level5', '+5 เลเวล'], ['gold', '+10,000 G'], ['mats', 'วัตถุดิบตีบวกทุกขั้น ×30 (รวม Spirit Crystal +10~15)'], ['card', 'การ์ดสุ่มของอาชีพ'], ['job', 'การ์ดที่ใส่ Job +3'], ['gear', 'ของอาชีพ Rare สูง ×3'], ['shells', 'Shell ×3 (ทุกแบบ)'], ['scrolls', 'Reroll ×5 + กันแตก ×3']]
        .map(([w, t]) => `<button type="button" class="big" data-act="dbg" data-w="${w}">${t}</button>`).join('');
    } else {
      body = `<button type="button" class="big" data-act="heal">${p.hp >= p.maxHp ? 'HP/MP เต็มแล้ว' : 'ฟื้นฟู HP/MP (ฟรี)'}</button>`;
    }
    this.$('npc').innerHTML = `<div class="bag-head"><b>${d.name} · ${d.title}</b><button type="button" data-act="close" aria-label="ปิด">✕</button></div>
      <p class="greet">“${d.greet}”</p><div class="gold">💰 ${p.gold.toLocaleString()} G</div><div class="rows">${body}</div>`;
  }

  // write DOM only when the value changed (the HUD updates every frame)
  private cache = new Map<string, string>();
  private txt(id: string, v: string) { if (this.cache.get('t' + id) !== v) { this.cache.set('t' + id, v); this.$(id).textContent = v; } }
  private wid(id: string, pct: number) { const v = `${Math.round(pct * 1000) / 10}%`; if (this.cache.get('w' + id) !== v) { this.cache.set('w' + id, v); this.$(id).style.width = v; } }

  private $(id: string) { return document.getElementById(id)!; }
  private cast(skill: string) { this.send({ kind: 'skill', id: this.p.id, skill }); }
  private toggleBag(force?: boolean) { const b = this.$('bag'); b.hidden = force === undefined ? !b.hidden : !force; this.invSig = ''; }
  private toggleAuto() {
    this.send({ kind: 'auto', id: this.p.id, on: !this.p.auto });
  }

  toast(text: string, cls = '') {
    const t = document.createElement('div'); t.className = `toast ${cls}`; t.textContent = text;
    const box = this.$('toasts'); box.prepend(t);
    while (box.children.length > 5) box.lastChild!.remove();
    setTimeout(() => t.remove(), 2600);
  }

  update(xpNeed: number, t: Entity | null) {
    const p = this.p;
    this.txt('pn', `${p.name} · Lv ${p.level}${p.dead ? ' · กำลังเกิดใหม่…' : ''}`);
    this.wid('php', (p.hp / p.maxHp));
    this.txt('phpt', `${Math.ceil(p.hp)} / ${p.maxHp}`);
    this.wid('pmp', (p.mp / Math.max(1, p.maxMp)));
    this.txt('pmpt', `${Math.floor(p.mp)} / ${p.maxMp}`);
    this.txt('pg', `💰 ${p.gold.toLocaleString()} G`);
    this.wid('pxp', (p.xp / xpNeed));
    const restW = Math.min(1 - p.xp / xpNeed, (p.rested ?? 0) / xpNeed);
    this.$('prest').style.left = `${(p.xp / xpNeed) * 100}%`; this.wid('prest', Math.max(0, restW));
    this.txt('pxpt', `XP ${p.xp} / ${xpNeed}${p.rested > 0 ? ` · 😴 Rested +${Math.round(p.rested).toLocaleString()} (×2)` : ''}`);
    const tf = this.$('tf'); tf.hidden = !t;
    if (t) {
      const race = { plant: 'พืช', animal: 'สัตว์', demon: 'ปีศาจ', angel: 'เทวดา', spirit: 'วิญญาณ', robot: 'หุ่น' }[this.world.defs.monsters[t.type]?.race ?? ''] ?? '';
      this.txt('tn', `${t.name} · Lv ${t.level}${race ? ' · ' + race : ''}${t.boss ? ' · BOSS' : ''}`);
      this.wid('thp', (t.hp / t.maxHp));
      this.txt('thpt', `${Math.ceil(t.hp)} / ${t.maxHp}`);
    }
    // skill bar follows the active form
    const now = this.world.now;
    this.hot.update();
    this.autoPanel.update();
    // quest tracker
    const q = this.world.questOf(p), dq = p.quest.daily, dd = this.world.defs.quests.daily;
    const need = q ? (q.goal.type === 'kill' ? q.goal.count ?? 1 : 1) : 0;
    const prog = q?.goal.type === 'level' ? `Lv ${p.level}/${q.goal.level}` : q?.goal.type === 'kill' ? `${p.quest.prog}/${need}` : q ? (p.quest.prog ? 'สำเร็จ' : 'ยังไม่สำเร็จ') : '';
    this.txt('qmain', q ? `📜 ${q.name} · ${prog}` : '📜 ทำเควสต์หลักครบแล้ว');
    const today = new Date().toISOString().slice(0, 10), dprog = dq.day === today ? dq.prog : 0, ddone = dq.day === today && dq.done;
    this.txt('qdaily', `📅 ${dd.name} ${ddone ? '✔' : `${Math.min(dprog, dd.goal.count ?? 0)}/${dd.goal.count}`}`);
    const nextBoss = (this.world.defs.quests.bosses ?? []).find(b => !(p.quest.bossDone ?? []).includes(b.id) && (!b.map || b.map === this.world.map.id));
    this.txt('qboss', nextBoss ? `⭐ บอสกลุ่ม: ${nextBoss.name.replace(/ \(ไปกับเพื่อน\)/, '')}` : '');
    const qa = this.$('qauto'); qa.hidden = !q || !!q.group;
    if (qa.classList.contains('on') !== p.autoQuest) { qa.classList.toggle('on', p.autoQuest); qa.textContent = p.autoQuest ? '■ หยุด Auto เควสต์' : '▶ Auto ทำเควสต์'; }
    if (this.autoShown !== p.auto) { this.autoShown = p.auto; const btn = this.$('auto'); btn.innerHTML = `AUTO<br>${p.auto ? 'ON' : 'OFF'}`; btn.classList.toggle('on', p.auto); }
    const tb = this.$('tf-btn'), card = p.equip.card;
    tb.classList.toggle('on', p.transformed); tb.classList.toggle('nomp', !card);
    (tb.querySelector('.ic') as HTMLElement).textContent = card ? this.items[card.item].icon : '✨';
    const tl = Math.max(0, (p.cooldowns['transform'] ?? 0) - now);
    (tb.querySelector(".cd") as HTMLElement).style.height = `${Math.min(1, tl / 10000) * 100}%`;
    tb.classList.toggle("busy", this.world.inCombat(p));
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
    if (!this.$('bag').hidden) { if (this.$('bag').classList.contains('selling')) this.sellPanel.render(); else this.renderBag(); }
    if (this.npc) this.renderNpc();
  }

  private renderBag() {
    const p = this.p;
    const sig = JSON.stringify([p.inv, p.equip, p.level, p.gold, this.tab, this.sel, p.transformed]);
    if (sig === this.invSig) return;
    this.invSig = sig;
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab));
    const badge = (st: InvSlot) => (st.up || st.lv || st.rare) ? `<em style="color:${RARE_COLOR[st.rare ?? 0]}">${st.rare ? 'R' + st.rare + ' ' : ''}${st.up ? '+' + st.up : ''}${st.lv ? (st.up ? ' ' : '') + 'Lv' + st.lv : ''}</em>` : '';
    this.$('equip').innerHTML = SLOTS.map(s => {
      const st = p.equip[s], d = st ? this.items[st.item] : null;
      return `<button type="button" class="slot ${d ? d.rarity : 'empty'}${this.sel === s ? ' sel' : ''}" data-slot="${s}" title="${d ? d.name : SLOT_TH[s]}"><span class="ic">${d ? d.icon : ''}</span>${st ? badge(st) : ''}<small>${SLOT_TH[s]}</small></button>`;
    }).join('');
    this.$('equip').querySelectorAll<HTMLButtonElement>('[data-slot]').forEach(b => b.addEventListener('click', () => { const sl = b.dataset.slot as Slot; if (p.equip[sl]) { this.sel = sl; this.invSig = ''; } }));
    const s = p.stats;
    this.$('stats').innerHTML = `<span>ATK ${s.baseAtk + s.weapon.min}–${s.baseAtk + s.weapon.max}</span><span>DEF ${s.armor.melee}/${s.armor.ranged}/${s.armor.magic}</span><span>ACC ${s.acc}</span><span>EVA ${s.eva}</span><span>CRIT ${Math.round(s.critRate * 100)}%</span>${s.elemRate ? `<span>ธาตุ ${Math.round(s.elemRate * 100)}%</span>` : ''}`;

    const tabOf = (d: ItemDef): Tab => d.slot === 'card' ? 'card' : SLOTS.includes(d.slot as Slot) ? 'gear' : d.slot === 'use' ? 'use' : d.slot === 'shell' ? (d.tab ?? 'enh') : d.tab ?? 'mat';
    const inTab = (d: ItemDef) => tabOf(d) === this.tab;
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
    const mul = 1 + (this.world.defs.rarity.mul[st.rare ?? 0] ?? 0), rn = st.rare ? ` (R${st.rare} +${Math.round((mul - 1) * 100)}%)` : '';
    if (d.weapon) lines.push(`ดาเมจ ${Math.round(d.weapon.min * mul)}–${Math.round(d.weapon.max * mul)}${rn} · คริ +${Math.round(d.weapon.critDmg * 100)}%`);
    for (const [k, v] of Object.entries(d.bonus ?? {})) {
      const m = d.slot === 'armor' && (k === 'armor' || k === 'hp') ? mul : 1;
      lines.push(`${k.toUpperCase()} +${k === 'critRate' || k === 'elemRate' || k === 'dmgPct' ? Math.round(v * 100) + '%' : Math.round(v * m)}${m > 1 ? rn : ''}`);
    }
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
    const w = this.world;
    extra += optLines(w, st);
    const targets = (slot: string) => {
      const out: { ref: string; label: string }[] = [];
      const eq = p.equip[slot as Slot]; if (eq) out.push({ ref: slot, label: `${itemName(w, eq)} (สวมอยู่)` });
      p.inv.forEach((x, j) => { if (x !== st && this.items[x.item].slot === slot) out.push({ ref: String(j), label: itemName(w, x) }); });
      return out;
    };
    let tgtAct = '';
    if (d.slot === 'shell') {
      const t = targets(d.shellFor!);
      tgtAct = 'shell';
      extra += `<div class="muted small">ใส่แล้วจะแทนออฟเดิมทั้งหมดของชิ้นนั้น</div><div class="tg">${t.map(x => `<button type="button" data-tgt="${x.ref}">ใส่ใน ${x.label}</button>`).join('') || '<span class="muted">ไม่มี' + (d.shellFor === 'weapon' ? 'อาวุธ' : d.shellFor === 'armor' ? 'เกราะ' : 'อาวุธรอง') + 'ให้ใส่</span>'}</div>`;
    } else if (st.item === w.defs.rarity.rerollItem) {
      const t = ['weapon', 'offhand', 'armor'].flatMap(targets).filter(x => { const y = /^\d+$/.test(x.ref) ? p.inv[Number(x.ref)] : p.equip[x.ref as Slot]; return (y?.rare ?? 0) > 0; });
      tgtAct = 'reroll';
      extra += `<div class="muted small">สุ่มออฟใหม่ทุกแถว (เก็บแถวเดิมไม่ได้)</div><div class="tg">${t.map(x => `<button type="button" data-tgt="${x.ref}">รีออฟ ${x.label}</button>`).join('') || '<span class="muted">ไม่มีของ R1 ขึ้นไป</span>'}</div>`;
    }
    if (card) {
      const u = this.world.defs.upgrade, lv = st.lv ?? 1;
      const pu = Object.entries(u.card.perUp).map(([k, v]) => `${k.toUpperCase()} +${k === 'elemRate' ? Math.round(v * (st.up ?? 0) * 100) + '%' : v * (st.up ?? 0)}`).join(' · ');
      extra += `<div class="muted">${(st.up ?? 0) > 0 ? `ตีบวก +${st.up}: ${pu}<br>` : ''}${card.role} · การ์ด Lv ${lv}${lv < u.cardMaxLevel ? ` (${st.xp ?? 0}/${u.cardXpPerLevel * lv} XP ตอนแปลงร่าง)` : ' (สูงสุด)'} · โบนัส +${(lv - 1) * 10}%</div>
        <div class="muted">อาวุธหลัก: <b>${card.weapon === 'offhand' ? 'อาวุธรอง' : 'อาวุธหลัก'}</b> (อีกชิ้นเพิ่มสเตตัสอย่างเดียว)</div>
        <div class="muted">สกิล: ${card.skills.map(k => `${k.icon} ${k.name}${k.unlock > lv ? ` (Job ${k.unlock})` : ''}`).join(' · ')}</div>`;
    }
    det.innerHTML = `<div><b>${d.icon} ${itemName(w, st)}</b> <small class="muted">${RARITY_TH[d.rarity]}${req ? ' · ต้องการ ' + req : ''}${worn ? ' · สวมอยู่' : ''}</small></div>
      <div class="muted">${lines.join(' · ') || 'วัตถุดิบ ใช้ตีบวกอุปกรณ์'}</div>${extra}
      <div class="acts">${canEquip ? '<button type="button" id="act-eq">สวมใส่</button>' : ''}${worn ? '<button type="button" id="act-un">ถอด</button>' : ''}${canUse ? '<button type="button" id="act-use">ใช้</button>' : ''}${worn ? '' : `<button type="button" id="act-sell">ขาย ${w.priceOf(st) * st.qty} G</button>`}</div>`;
    det.querySelectorAll<HTMLElement>('[data-tgt]').forEach(b => b.addEventListener('click', () => {
      const r = b.dataset.tgt!, ref = /^\d+$/.test(r) ? Number(r) : r as Slot;
      if (tgtAct === 'shell') this.send({ kind: 'applyShell', id: p.id, shell: i, ref }); else this.send({ kind: 'reroll', id: p.id, ref });
      this.sel = null; this.invSig = '';
    }));
    const i = this.sel as number, sl = this.sel as Slot;
    document.getElementById('act-eq')?.addEventListener('click', () => { this.send({ kind: 'equip', id: p.id, index: i }); this.sel = d.slot as Slot; });
    document.getElementById('act-un')?.addEventListener('click', () => { this.send({ kind: 'unequip', id: p.id, slot: sl }); this.sel = null; });
    document.getElementById('act-up')?.addEventListener('click', () => { this.send({ kind: 'upgrade', id: p.id, ref: this.sel as number | Slot }); this.invSig = ''; });
    document.getElementById('act-use')?.addEventListener('click', () => this.send({ kind: 'use', id: p.id, index: i }));
    document.getElementById('act-sell')?.addEventListener('click', () => { this.send({ kind: 'sell', id: p.id, index: i }); this.sel = null; });
  }
}

export type { SkillDef };
