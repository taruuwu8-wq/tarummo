// Shared item text: rare tag/colour, names, option lines.
import type { World, InvSlot } from '../sim/world';

export const RARE_COLOR = ['#c9d1e0', '#8ee68e', '#6ff08f', '#6fb6ff', '#5aa0ff', '#c58bff', '#ffab4a', '#ff5d5d'];
export const GRADE_COLOR: Record<string, string> = { C: '#c9d1e0', B: '#6ff08f', A: '#6fb6ff', S: '#ffab4a' };

export function rareTag(st: InvSlot) { return st.rare ? `R${st.rare}` : ''; }

/** "R5 Iron Sword +3" as HTML, coloured by rare */
export function itemName(w: World, st: InvSlot) {
  const d = w.defs.items[st.item];
  const r = st.rare ?? 0;
  return `<span style="color:${RARE_COLOR[r]}">${r ? `R${r} ` : ''}${d.name}${st.up ? ' +' + st.up : ''}</span>`;
}

export function optLines(w: World, st: InvSlot) {
  return (st.opts ?? []).map(l => {
    const o = w.optDef(l.id); if (!o) return '';
    return `<div class="opt"><b style="color:${GRADE_COLOR[o.grade]}">${o.grade}</b> ${o.label.replace('{v}', String(l.v))}</div>`;
  }).join('');
}
