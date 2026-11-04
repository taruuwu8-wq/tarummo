"""Cut a sheet of separate props into one PNG per object.
Background: real alpha, or a light flat/checkerboard backdrop (flood-filled from the border, so white parts
inside outlined objects survive). Objects = connected blobs (after a small dilation so thin bits stay attached).
Usage: python3 -I tools/slice_props.py SHEET OUT_DIR PREFIX [min_area=1500] [dilate_px=3]
Writes OUT_DIR/PREFIX_NN.png (trimmed, alpha) and OUT_DIR/PREFIX_index.png (numbered contact sheet)."""
import sys, os
from collections import deque
import numpy as np
from PIL import Image, ImageDraw

src, out, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
min_area = int(sys.argv[4]) if len(sys.argv) > 4 else 1500
dil = int(sys.argv[5]) if len(sys.argv) > 5 else 3   # 0 = split objects that touch the neighbours
os.makedirs(out, exist_ok=True)
im = Image.open(src).convert('RGBA'); a = np.array(im); h, w = a.shape[:2]
rgb = a[:, :, :3].astype(int)
fg = a[:, :, 3] > 40
if fg.all():   # no real alpha: flood the light, unsaturated backdrop from the border
    light = (rgb.max(2) - rgb.min(2) < 14) & (rgb.min(2) > 205)
    bg = np.zeros((h, w), bool); q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if light[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if light[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and light[ny, nx] and not bg[ny, nx]: bg[ny, nx] = True; q.append((ny, nx))
    fg = ~bg
    a[:, :, 3] = np.where(fg, 255, 0)
# blobs on a dilated mask
d = fg.copy()
for dy in (-dil, 0, dil):
    for dx in (-dil, 0, dil): d |= np.roll(np.roll(fg, dy, 0), dx, 1)
lab = np.zeros((h, w), int); n = 0; boxes = []
for y0 in range(h):
    for x0 in range(w):
        if d[y0, x0] and not lab[y0, x0]:
            n += 1; lab[y0, x0] = n; q = deque([(y0, x0)]); ys = [y0]; xs = [x0]; cnt = 0
            while q:
                y, x = q.popleft(); cnt += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and d[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n; q.append((ny, nx)); ys.append(ny); xs.append(nx)
            if cnt >= min_area: boxes.append((n, min(ys), min(xs), max(ys), max(xs)))
boxes.sort(key=lambda b: (b[1] // 120, b[2]))   # reading order (rows of ~120 px)
sheet = Image.new('RGBA', (w, h), (40, 44, 60, 255)); dr = ImageDraw.Draw(sheet)
for i, (k, y0, x0, y1, x1) in enumerate(boxes):
    m = (lab[y0:y1 + 1, x0:x1 + 1] == k) & fg[y0:y1 + 1, x0:x1 + 1]
    crop = a[y0:y1 + 1, x0:x1 + 1].copy(); crop[:, :, 3] = np.where(m, crop[:, :, 3], 0)
    Image.fromarray(crop).save(f'{out}/{prefix}_{i:02d}.png')
    sheet.alpha_composite(Image.fromarray(crop), (x0, y0)); dr.text((x0 + 4, y0 + 2), str(i), fill=(255, 80, 80, 255))
    print(i, x1 - x0 + 1, y1 - y0 + 1)
sheet.convert('RGB').save(f'{out}/{prefix}_index.png')
