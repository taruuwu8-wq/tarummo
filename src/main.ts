import Phaser from 'phaser';
import { GameScene, SceneData } from './client/GameScene';
import { readSave, clearSave } from './client/save';
import { Net } from './client/net';
import classes from '../data/classes.json';

type ClassInfo = { name: string; sprite: string; attackType: string };
const CLASSES = classes as Record<string, ClassInfo>;
const DESC: Record<string, string> = { melee: 'ระยะประชิด · ทนทาน', ranged: 'ระยะไกล · หลบเก่ง', magic: 'เวท · ธาตุไฟ/น้ำ แรงแต่บาง' };
const pick = document.getElementById('pick')!;
const list = document.getElementById('classes')!;
const sub = pick.querySelector('p')!;

function classButton(id: string, c: ClassInfo, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<img src="sprites/${c.sprite}.png" alt=""><b>${c.name}</b><small>${DESC[c.attackType]}</small>`;
  b.addEventListener('click', onClick);
  return b;
}

function start(data: SceneData) {
  pick.hidden = true;
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent: 'game',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    backgroundColor: '#1b1f2a',
  });
  game.scene.add('game', GameScene, true, data);
}

// ---- offline (single player, save in this browser) ----
function offline() {
  const save = readSave();
  if (save && CLASSES[save.cls]) {
    const c = CLASSES[save.cls];
    const cont = document.createElement('button');
    cont.type = 'button'; cont.className = 'continue';
    cont.innerHTML = `<img src="sprites/${c.sprite}.png" alt=""><b>เล่นต่อ</b><small>${c.name} · Lv ${save.level} · ${save.gold} G</small>`;
    cont.addEventListener('click', () => start({ cls: save.cls, save }));
    list.before(cont);
    const note = document.createElement('p'); note.textContent = 'หรือเริ่มตัวใหม่ (เซฟเก่าจะถูกแทนที่)'; list.before(note);
  }
  for (const [id, c] of Object.entries(CLASSES)) list.appendChild(classButton(id, c, () => { clearSave(); start({ cls: id }); }));
}

// ---- online (server on this host) ----
function online(net: Net) {
  sub.textContent = 'ออนไลน์ · ใส่ชื่อตัวละคร (ชื่อเดิม = เล่นต่อ)';
  const form = document.createElement('div'); form.className = 'login';
  form.innerHTML = `<input id="pname" maxlength="16" placeholder="ชื่อตัวละคร" autocomplete="off"><div id="perr" class="err"></div>`;
  list.before(form);
  const input = form.querySelector('input')!, err = form.querySelector('.err')!;
  const saved = Object.entries(net.saves);
  if (saved.length) {
    const row = document.createElement('div'); row.className = 'saved';
    for (const [name, s] of saved) {
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = `${name} · ${CLASSES[s.cls]?.name ?? s.cls} Lv${s.level}`;
      b.addEventListener('click', () => join(name, s.cls));
      row.appendChild(b);
    }
    form.appendChild(row);
  }
  const join = (name: string, cls: string) => {
    if (!name.trim()) { err.textContent = 'ใส่ชื่อก่อน'; input.focus(); return; }
    err.textContent = '';
    net.onMsg = m => {
      if (m.t === 'error') err.textContent = m.text;
      if (m.t === 'tick' && net.myId >= 0) { net.onMsg = null; start({ net, cls: net.cls }); }
    };
    net.send({ t: 'join', name: name.trim(), cls });
  };
  for (const [id, c] of Object.entries(CLASSES)) list.appendChild(classButton(id, c, () => join(input.value, id)));
  const hint = document.createElement('p'); hint.textContent = 'ถ้าชื่อนี้มีตัวอยู่แล้ว จะเข้าตัวเดิม (อาชีพที่กดจะไม่มีผล)'; hint.className = 'hint';
  list.after(hint);
}

Net.connect().then(net => (net ? online(net) : offline()));
