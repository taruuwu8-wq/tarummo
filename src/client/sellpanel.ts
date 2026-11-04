// Bulk sell inside the bag: filter by type / rarity / rare / upgrade, untick exceptions, sell in one go.
import type { Entity, World, Intent, InvSlot } from '../sim/world';
import type { ItemDef } from '../core/stats';
import { itemName, ic } from './itemtext';

type Cat = 'gear' | 'use' | 'mat' | 'shell';
const CAT_TH: Record<Cat, string> = { gear: 'อุปกรณ์', use: 'ของใช้', mat: 'วัตถุดิบ', shell: 'Shell' };
const RAR: { id: ItemDef['rarity']; th: string }[] = [{ id: 'common', th: 'ธรรมดา' }, { id: 'uncommon', th: 'ดี' }, { id: 'rare', th: 'หายาก' }, { id: 'epic', th: 'ตำนาน' }];
const GEAR = ['weapon', 'offhand', 'armor', 'hat', 'charm'];

export class SellPanel {
  private cats = new Set<Cat>(['gear']);
  private rars = new Set<string>(['common', 'uncommon']);
  private maxRare = 2;
  private skipUpgraded = true;
  private skipped = new Set<InvSlot>();     // items the player unticked
  private armed = 0;
  private sig = '';

  constructor(private box: HTMLElement, private world: World, private p: Entity, private items: Record<string, ItemDef>, private send: (i: Intent) => void) {
    box.addEventListener('change', e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.cat) t.checked ? this.cats.add(t.dataset.cat as Cat) : this.cats.delete(t.dataset.cat as Cat);
      else if (t.dataset.rar) t.checked ? this.rars.add(t.dataset.rar) : this.rars.delete(t.dataset.rar);
      else if (t.id === 'sell-maxr') this.maxRare = Number(t.value);
      else if (t.id === 'sell-up') this.skipUpgraded = t.checked;
      else if (t.dataset.pick) { const st = this.p.inv[Number(t.dataset.pick)]; if (st) t.checked ? this.skipped.delete(st) : this.skipped.add(st); }
      this.armed = 0; this.sig = '';
    });
    box.addEventListener('click', e => {
      if (!(e.target as HTMLElement).closest('#sell-go')) return;
      const list = this.selected();
      if (!list.length) return;
      // valuable items in the selection need a second click
      const risky = list.some(({ st }) => (st.rare ?? 0) >= 5 || (st.up ?? 0) >= 5 || this.items[st.item].rarity === 'epic');
      if (risky && Date.now() - this.armed > 5000) { this.armed = Date.now(); this.sig = ''; return; }
      this.send({ kind: 'sellMany', id: this.p.id, indices: list.map(x => x.i) });
      this.armed = 0; this.skipped.clear(); this.sig = '';
    });
  }

  private cat(d: ItemDef): Cat | null {
    if (GEAR.includes(d.slot)) return 'gear';
    if (d.slot === 'use' || d.slot === 'mat' || d.slot === 'shell') return d.slot;
    return null;   // cards, mounts: never bulk-sold
  }

  private matches() {
    return this.p.inv.map((st, i) => ({ st, i, d: this.items[st.item] })).filter(({ st, d }) => {
      const c = d && this.cat(d);
      if (!c || !this.cats.has(c) || !this.rars.has(d.rarity)) return false;
      if ((st.rare ?? 0) > this.maxRare) return false;
      if (this.skipUpgraded && (st.up ?? 0) > 0) return false;
      return true;
    });
  }
  private selected() { return this.matches().filter(x => !this.skipped.has(x.st)); }

  render() {
    const m = this.matches(), sel = m.filter(x => !this.skipped.has(x.st));
    const sig = JSON.stringify([this.p.inv.length, m.map(x => x.i), sel.length, this.armed > 0, [...this.cats], [...this.rars], this.maxRare, this.skipUpgraded]);
    if (sig === this.sig) return;
    this.sig = sig;
    const total = sel.reduce((a, x) => a + this.world.priceOf(x.st) * x.st.qty, 0);
    const armed = this.armed > 0 && Date.now() - this.armed < 5000;
    this.box.innerHTML = `
      <div class="sellf">${(Object.keys(CAT_TH) as Cat[]).map(c => `<label class="chip"><input type="checkbox" data-cat="${c}"${this.cats.has(c) ? ' checked' : ''}>${CAT_TH[c]}</label>`).join('')}</div>
      <div class="sellf">${RAR.map(r => `<label class="chip"><input type="checkbox" data-rar="${r.id}"${this.rars.has(r.id) ? ' checked' : ''}>${r.th}</label>`).join('')}</div>
      <div class="sellf"><label>Rare ไม่เกิน <select id="sell-maxr">${[0, 1, 2, 3, 4, 5, 6, 7].map(r => `<option value="${r}"${r === this.maxRare ? ' selected' : ''}>R${r}</option>`).join('')}</select></label>
        <label class="chip"><input type="checkbox" id="sell-up"${this.skipUpgraded ? ' checked' : ''}>ไม่รวมของที่ตีบวกแล้ว</label></div>
      <div class="selll">${m.map(({ st, i, d }) => `<label class="sellrow"><input type="checkbox" data-pick="${i}"${this.skipped.has(st) ? '' : ' checked'}><span>${ic(d)} ${itemName(this.world, st)}${st.qty > 1 ? ' ×' + st.qty : ''}</span><b>${(this.world.priceOf(st) * st.qty).toLocaleString()} G</b></label>`).join('') || '<p class="muted">ไม่มีของที่ตรงตัวกรอง</p>'}</div>
      <p class="muted small">การ์ดและพาหนะไม่ถูกขายจากหน้านี้</p>
      <button type="button" id="sell-go" class="${armed ? 'armed' : ''}"${sel.length ? '' : ' disabled'}>${armed ? `ยืนยัน! มีของดีปนอยู่ ขาย ${sel.length} ชิ้น` : `ขาย ${sel.length} ชิ้น · ${total.toLocaleString()} G`}</button>`;
  }
}
