import Phaser from 'phaser';
import { GameScene } from './client/GameScene';
import { readSave, clearSave } from './client/save';
import classes from '../data/classes.json';

const pick = document.getElementById('pick')!;
const list = document.getElementById('classes')!;
const save = readSave();
const DESC: Record<string, string> = { melee: 'ระยะประชิด · ทนทาน', ranged: 'ระยะไกล · หลบเก่ง', magic: 'เวท · ธาตุไฟ/น้ำ แรงแต่บาง' };

if (save && (classes as Record<string, unknown>)[save.cls]) {
  const c = (classes as Record<string, { name: string; sprite: string }>)[save.cls];
  const cont = document.createElement('button');
  cont.type = 'button'; cont.className = 'continue';
  cont.innerHTML = `<img src="sprites/${c.sprite}.png" alt=""><b>เล่นต่อ</b><small>${c.name} · Lv ${save.level} · ${save.gold} G</small>`;
  cont.addEventListener('click', () => { pick.hidden = true; start(save.cls, save); });
  list.before(cont);
  const note = document.createElement('p'); note.textContent = 'หรือเริ่มตัวใหม่ (เซฟเก่าจะถูกแทนที่)'; list.before(note);
}
for (const [id, c] of Object.entries(classes)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<img src="sprites/${c.sprite}.png" alt=""><b>${c.name}</b><small>${DESC[c.attackType]}</small>`;
  b.addEventListener('click', () => { clearSave(); pick.hidden = true; start(id); });
  list.appendChild(b);
}

function start(cls: string, s?: typeof save) {
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent: 'game',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    backgroundColor: '#1b1f2a',
  });
  game.scene.add('game', GameScene, true, { cls, save: s ?? undefined });
}
