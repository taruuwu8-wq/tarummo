# Nostaru

Phase 0: แมพ isometric + Swordsman คลิกเดิน (A*) + slime เดินสุ่ม

```bash
npm install
npm run dev
```

- `src/sim/` ลอจิกโลก (tick 10 ครั้ง/วินาที) ไม่แตะ Phaser — ย้ายไป server ได้
- `src/client/` Phaser: วาดแมพ, ท่าทางด้วยโค้ด (หายใจ/เด้ง)
- `data/` แมพ + ค่าตัวละคร (JSON)
- `public/sprites/` ภาพที่เกมใช้, `art/raw/` ภาพที่ตัดจากแผ่น AI (55 ชิ้น, บางชิ้นตัดไม่ครบ)
- `tools/slice_sheet.py <sheet> <out> <rows> <cols>` ตัดแผ่นภาพพื้นขาวเป็น PNG
