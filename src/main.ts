import Phaser from 'phaser';
import { GameScene } from './client/GameScene';
import classes from '../data/classes.json';

// Class picker, then start the game scene with the chosen class.
const pick = document.getElementById('pick')!;
const list = document.getElementById('classes')!;
for (const [id, c] of Object.entries(classes)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<img src="sprites/${c.sprite}.png" alt=""><b>${c.name}</b><small>${{ melee: 'ระยะประชิด · ทนทาน', ranged: 'ระยะไกล · หลบเก่ง', magic: 'เวท · ธาตุไฟ แรงแต่บาง' }[c.attackType]}</small>`;
  b.addEventListener('click', () => { pick.hidden = true; start(id); });
  list.appendChild(b);
}

function start(cls: string) {
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent: 'game',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    backgroundColor: '#1b1f2a',
  });
  game.scene.add('game', GameScene, true, { cls });
}
