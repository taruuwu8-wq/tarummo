# Nostaru

Phase 0: แมพ isometric + Swordsman คลิกเดิน (A*) + slime เดินสุ่ม

### เล่นคนเดียว (ไม่ต้องมีเซิร์ฟเวอร์)

```bash
npm install
npm run dev
```

### เล่นออนไลน์บนคอมตัวเอง (หลายคน)

```bash
npm install
npm start
```

- เปิด `http://localhost:8080` แล้วใส่ชื่อตัวละคร (ชื่อเดิม = เล่นตัวเดิม)
- ทดสอบคนเดียว: เปิด 2 แท็บ ใช้คนละชื่อ
- เพื่อนที่อยู่ Wi-Fi เดียวกัน: ใช้ลิงก์ `same Wi-Fi: http://192.168.x.x:8080` ที่ขึ้นในหน้าต่างเซิร์ฟเวอร์
- เซฟอยู่ในโฟลเดอร์ `saves/` (1 ไฟล์ JSON ต่อตัวละคร)
- เปลี่ยนพอร์ต: `PORT=9000 npm run server`

- `src/sim/` ลอจิกโลก (tick 10 ครั้ง/วินาที) ไม่แตะ Phaser · รันบน server จริงแล้ว
- `server/` Node + ws: 1 World ต่อแมพ, ส่ง snapshot ทุก tick, เซฟ JSON
- `src/client/net.ts` ต่อ WebSocket · ถ้าไม่มีเซิร์ฟเวอร์จะเข้าโหมดคนเดียวอัตโนมัติ
- `src/client/` Phaser: วาดแมพ, ท่าทางด้วยโค้ด (หายใจ/เด้ง)
- `data/` แมพ + ค่าตัวละคร (JSON)
- `public/sprites/` ภาพที่เกมใช้, `art/raw/` ภาพที่ตัดจากแผ่น AI (55 ชิ้น, บางชิ้นตัดไม่ครบ)
- `tools/slice_sheet.py <sheet> <out> <rows> <cols>` ตัดแผ่นภาพพื้นขาวเป็น PNG

## เล่นบน GitHub Pages

Settings → Pages → Source: **GitHub Actions** แล้วทุกครั้งที่ push ขึ้น `main` จะ build และ deploy ให้อัตโนมัติ
ลิงก์: https://taruuwu8-wq.github.io/tarummo/
