"""Slice an AI character sheet (white background) into individual transparent PNGs.
Usage: python3 slice_sheet.py <sheet> <out_dir> <rows> <cols>"""
import sys, os
from collections import deque
import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
ROWS, COLS = int(sys.argv[3]), int(sys.argv[4])  # fixed grid
os.makedirs(out, exist_ok=True)
im = Image.open(src).convert("RGBA")
a = np.array(im)
h, w = a.shape[:2]
light = (a[:, :, :3].min(axis=2) > 225)
# background = light pixels connected to the border
bg = np.zeros((h, w), bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if light[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if light[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
        ny, nx = y+dy, x+dx
        if 0 <= ny < h and 0 <= nx < w and light[ny, nx] and not bg[ny, nx]:
            bg[ny, nx] = True; q.append((ny, nx))
fg = ~bg

n = 0
ch, cw = h / ROWS, w / COLS
for r in range(ROWS):
    for c in range(COLS):
        pad = int(cw * 0.15)
        y0, y1 = int(r*ch), int((r+1)*ch)
        x0, x1 = max(0, int(c*cw) - pad), min(w, int((c+1)*cw) + pad)
        sub = fg[y0:y1, x0:x1]
        if sub.sum() < 200: continue
        # split region into column clusters (gap >= 3 empty cols), keep the heaviest
        col = sub.sum(axis=0)
        clusters, start, gap = [], None, 0
        for i, v in enumerate(col):
            if v > 0:
                if start is None: start = i
                gap, end = 0, i
            elif start is not None:
                gap += 1
                if gap >= 3: clusters.append((start, end + 1)); start = None
        if start is not None: clusters.append((start, end + 1))
        cx0, cx1 = max(clusters, key=lambda t: col[t[0]:t[1]].sum())
        ys = np.where(sub[:, cx0:cx1].any(axis=1))[0]
        yy0, yy1, xx0, xx1 = y0+ys[0], y0+ys[-1]+1, x0+cx0, x0+cx1
        crop = a[yy0:yy1, xx0:xx1].copy()
        crop[bg[yy0:yy1, xx0:xx1], 3] = 0
        Image.fromarray(crop).save(os.path.join(out, f"r{r}_c{c:02d}.png"))
        n += 1
print("saved", n)
