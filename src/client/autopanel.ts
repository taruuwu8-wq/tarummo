// Auto settings (⚙) and the Auto summary box.
import type { Entity, World, Intent, AutoCfg, LootAct } from '../sim/world';
import type { ItemDef } from '../core/stats';

const ACT_TH: Record<LootAct, string> = { keep: 'เก็บ', sell: 'ขายทันที', drop: 'ทิ้ง' };
const RAR_TH: Record<string, string> = { common: 'ธรรมดา', uncommon: 'ดี', rare: 'หายาก', epic: 'ตำนาน' };

export class AutoPanel {
  private open = false;
  private sumSig = '';

  constructor(private root: HTMLElement, private world: World, private p: Entity, private items: Record<string, ItemDef>, private send: (i: Intent) => void) {
    root.insertAdjacentHTML('beforeend', `
      <div id="autocfg" class="panel" hidden></div>
      <div id="autosum" hidden></div>`);
    const el = document.getElementById('autocfg')!;
    el.addEventListener('input', () => this.push());
    el.addEventListener('change', () => this.push());
    el.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-close]')) this.toggle(false); });
  }

  get isOpen() { return this.open; }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    const el = document.getElementById('autocfg')!;
    el.hidden = !this.open;
    if (this.open) this.render();
  }

  private monsterTypes() {
    const m = this.world.map, ids = new Set(m.monsters.map(x => x.type));
    for (const r of m.dungeon?.rooms ?? []) for (const [t] of r.monsters) ids.add(t);
    return [...ids];
  }

  private render() {
    const c = this.p.autoCfg, el = document.getElementById('autocfg')!;
    const sel = (name: string, v: LootAct) => `<select data-k="${name}">${(['keep', 'sell', 'drop'] as LootAct[]).map(a => `<option value="${a}"${a === v ? ' selected' : ''}>${ACT_TH[a]}</option>`).join('')}</select>`;
    const mons = this.monsterTypes();
    const skills = this.world.barSkills(this.p);
    el.innerHTML = `
      <div class="bag-head"><b>ตั้งค่า Auto</b><button type="button" data-close aria-label="ปิด">✕</button></div>
      <label class="row2">ระยะล่ารอบจุดเริ่ม <b id="rangev">${c.range} ช่อง</b><input type="range" min="3" max="15" data-k="range" value="${c.range}"></label>
      <fieldset><legend>ตีมอนตัวไหน${this.world.map.dungeon ? ' (ในดันเจี้ยนตีตามห้อง)' : ''}</legend>
        ${mons.map(t => `<label class="chk"><input type="checkbox" data-mon="${t}"${c.skip.includes(t) ? '' : ' checked'}> ${this.world.defs.monsters[t].name} <small>Lv${this.world.defs.monsters[t].level}</small></label>`).join('') || '<span class="muted">แมพนี้ไม่มีมอน</span>'}
        <label class="chk"><input type="checkbox" data-k="bosses"${c.bosses ? ' checked' : ''}> ตีบอส/มินิบอสด้วย</label>
        <label class="row2">ไม่ตีมอนที่เลเวลสูงกว่าเราเกิน <input type="number" min="0" max="10" data-k="levelAbove" value="${c.levelAbove}"></label>
      </fieldset>
      <fieldset><legend>ใช้ยาอัตโนมัติ (0 = ปิด)</legend>
        <label class="row2">HP ต่ำกว่า <span><input type="number" min="0" max="90" data-k="hp" value="${c.hp}"> %</span></label>
        <label class="row2">MP ต่ำกว่า <span><input type="number" min="0" max="90" data-k="mp" value="${c.mp}"> %</span></label>
      </fieldset>
      <fieldset><legend>สกิลที่ Auto ใช้ (จากแถบสกิล)</legend>
        ${skills.map(k => `<label class="chk"><input type="checkbox" data-sk="${k.id}"${c.skipSkills.includes(k.id) ? '' : ' checked'}> ${k.icon} ${k.name}</label>`).join('') || '<span class="muted">ยังไม่มีสกิลบนแถบ</span>'}
      </fieldset>
      <fieldset><legend>ของที่ดรอป</legend>
        ${(['common', 'uncommon', 'rare', 'epic'] as const).map(r => `<label class="row2">อุปกรณ์ ${RAR_TH[r]} ${sel('gear.' + r, c.loot.gear[r])}</label>`).join('')}
        <label class="row2">ของใช้ (ยา) ${sel('use', c.loot.use)}</label>
        <label class="row2">วัตถุดิบ ${sel('mat', c.loot.mat)}</label>
        <small class="muted">การ์ดและพาหนะเก็บเสมอ</small>
      </fieldset>
      <fieldset><legend>กลับเมืองอัตโนมัติ</legend>
        <label class="chk"><input type="checkbox" data-k="returnTown"${c.returnTown ? ' checked' : ''}> ยา HP หมด หรือกระเป๋าเต็ม → กลับเมือง ขายของ ซื้อยา แล้วกลับจุดเดิม</label>
        <label class="row2">ซื้อยา HP ให้มี <input type="number" min="0" max="99" data-k="buyHp" value="${c.buyHp}"></label>
        <label class="row2">ซื้อยา MP ให้มี <input type="number" min="0" max="99" data-k="buyMp" value="${c.buyMp}"></label>
      </fieldset>`;
  }

  private push() {
    const el = document.getElementById('autocfg')!, c: AutoCfg = JSON.parse(JSON.stringify(this.p.autoCfg));
    const num = (k: string) => Number(el.querySelector<HTMLInputElement>(`[data-k="${k}"]`)?.value);
    c.range = num('range'); c.levelAbove = num('levelAbove'); c.hp = num('hp'); c.mp = num('mp'); c.buyHp = num('buyHp'); c.buyMp = num('buyMp');
    c.bosses = !!el.querySelector<HTMLInputElement>('[data-k="bosses"]')?.checked;
    c.returnTown = !!el.querySelector<HTMLInputElement>('[data-k="returnTown"]')?.checked;
    const mons = Array.from(el.querySelectorAll<HTMLInputElement>('[data-mon]'));
    c.skip = [...c.skip.filter(t => !mons.some(m => m.dataset.mon === t)), ...mons.filter(m => !m.checked).map(m => m.dataset.mon!)];
    const sks = Array.from(el.querySelectorAll<HTMLInputElement>('[data-sk]'));
    c.skipSkills = [...c.skipSkills.filter(t => !sks.some(m => m.dataset.sk === t)), ...sks.filter(m => !m.checked).map(m => m.dataset.sk!)];
    for (const r of ['common', 'uncommon', 'rare', 'epic'] as const) c.loot.gear[r] = el.querySelector<HTMLSelectElement>(`[data-k="gear.${r}"]`)!.value as LootAct;
    c.loot.use = el.querySelector<HTMLSelectElement>('[data-k="use"]')!.value as LootAct;
    c.loot.mat = el.querySelector<HTMLSelectElement>('[data-k="mat"]')!.value as LootAct;
    document.getElementById('rangev')!.textContent = `${c.range} ช่อง`;
    this.p.autoCfg = c;   // optimistic; the server echoes the cleaned copy
    this.send({ kind: 'autoCfg', id: this.p.id, cfg: c });
  }

  /** Summary box while Auto is on. */
  update() {
    const p = this.p, box = document.getElementById('autosum')!;
    box.hidden = !p.auto;
    if (!p.auto) return;
    const st = p.autoStats, sec = Math.max(1, (this.world.now - st.since) / 1000);
    const sig = JSON.stringify([st, Math.floor(sec), p.autoTrip?.phase]);
    if (sig === this.sumSig) return;
    this.sumSig = sig;
    const hr = 3600 / sec, t = Math.floor(sec);
    const top = Object.entries(st.items).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, q]) => `${this.items[id]?.icon ?? ''}×${q}`).join(' ');
    const trip = p.autoTrip ? { toTown: '🏠 กำลังกลับเมือง', shop: '🛒 ไปร้านค้า', back: '↩ กลับจุดล่า' }[p.autoTrip.phase] : '';
    box.innerHTML = `<b>AUTO</b> ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}${trip ? ' · ' + trip : ''}<br>
      XP ${st.xp.toLocaleString()} <small>(${Math.round(st.xp * hr).toLocaleString()}/ชม.)</small> · 💰 ${st.gold.toLocaleString()} · ⚔ ${st.kills}<br><small>${top || 'ยังไม่มีของ'}</small>`;
  }
}
