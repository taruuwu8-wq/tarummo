"""Cut an icon grid sheet (rows x cols, light/white backdrop) into square icons.
Background = light unsaturated pixels connected to the border, plus large enclosed light areas (inside bows);
per cell only the biggest blob is kept (neighbouring icons poke into misaligned cells).
Usage: python3 -I tools/slice_icons.py SHEET OUT_DIR 'row1,row2,...' COLS [size=64]   -> OUT_DIR/w_<row>_<col>.png"""
import sys
from collections import deque
import numpy as np
from PIL import Image

src, out, names, cols = sys.argv[1], sys.argv[2], sys.argv[3].split(','), int(sys.argv[4])
size = int(sys.argv[5]) if len(sys.argv) > 5 else 64
a = np.array(Image.open(src).convert('RGBA')); H, W = a.shape[:2]; rgb = a[:, :, :3].astype(int)
light = (rgb.max(2) - rgb.min(2) < 22) & (rgb.min(2) > 200)

def comps(mask):
    h, w = mask.shape; lab = np.zeros((h, w), int); n = 0; info = []
    for y in range(h):
        for x in range(w):
            if mask[y, x] and not lab[y, x]:
                n += 1; q = deque([(y, x)]); lab[y, x] = n; cnt = 0; edge = False
                while q:
                    cy, cx = q.popleft(); cnt += 1
                    if cy in (0, h - 1) or cx in (0, w - 1): edge = True
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]: lab[ny, nx] = n; q.append((ny, nx))
                info.append((cnt, edge))
    return lab, info

lab, info = comps(light)
bgids = [i + 1 for i, (cnt, edge) in enumerate(info) if edge or cnt > 250]
bg = np.isin(lab, bgids)
fg = ~bg
for r, name in enumerate(names):
    for c in range(cols):
        x0, x1, y0, y1 = int(c * W / cols), int((c + 1) * W / cols), int(r * H / len(names)), int((r + 1) * H / len(names))
        m = fg[y0:y1, x0:x1]
        d = m.copy()
        for dy in (-2, 0, 2):
            for dx in (-2, 0, 2): d |= np.roll(np.roll(m, dy, 0), dx, 1)
        l2, inf2 = comps(d)
        big = 1 + int(np.argmax([cnt for cnt, _ in inf2]))
        keep = (l2 == big) & m
        ys, xs = np.nonzero(keep)
        cell = a[y0:y1, x0:x1].copy(); cell[:, :, 3] = np.where(keep, 255, 0)
        crop = Image.fromarray(cell[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
        s = size / max(crop.size); crop = crop.resize((max(1, round(crop.width * s)), max(1, round(crop.height * s))), Image.LANCZOS)
        crop.putalpha(crop.getchannel('A').point(lambda v: 255 if v > 120 else 0))
        o = Image.new('RGBA', (size, size)); o.paste(crop, ((size - crop.width) // 2, (size - crop.height) // 2), crop)
        o.save(f'{out}/w_{name}_{c}.png', optimize=True)
