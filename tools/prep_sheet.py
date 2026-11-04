"""Make a sheet transparent: either threshold real alpha (--alpha N) or flood-remove a light/checkerboard backdrop
from the border (outlined sprites stop the flood). Usage: python3 -I tools/prep_sheet.py IN OUT [--alpha 200] [--sat 18 --min 205] (tinted checkerboards: raise --sat) [--holes 150]"""
import sys
from collections import deque
import numpy as np
from PIL import Image
a = np.array(Image.open(sys.argv[1]).convert('RGBA')); h, w = a.shape[:2]
if '--alpha' in sys.argv:
    t = int(sys.argv[sys.argv.index('--alpha') + 1]); a[:, :, 3] = np.where(a[:, :, 3] > t, 255, 0)
else:
    arg = lambda k, d: int(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    rgb = a[:, :, :3].astype(int); light = (rgb.max(2) - rgb.min(2) < arg('--sat', 18)) & (rgb.min(2) > arg('--min', 205))
    bg = np.zeros((h, w), bool); q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if light[y, x]: bg[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if light[y, x] and not bg[y, x]: bg[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and light[ny, nx] and not bg[ny, nx]: bg[ny, nx] = True; q.append((ny, nx))
    # enclosed backdrop (inside arches/bows): noisy, so group it loosely; drop bright groups bigger than --holes px
    hole = arg('--holes', 0)
    if hole:
        soft = (rgb.max(2) - rgb.min(2) < 40) & (rgb.min(2) > 185)
        seen = bg.copy()
        for y0 in range(h):
            for x0 in range(w):
                if soft[y0, x0] and not seen[y0, x0]:
                    q = deque([(y0, x0)]); seen[y0, x0] = True; pts = [(y0, x0)]
                    while q:
                        y, x = q.popleft()
                        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                            ny, nx = y + dy, x + dx
                            if 0 <= ny < h and 0 <= nx < w and soft[ny, nx] and not seen[ny, nx]: seen[ny, nx] = True; q.append((ny, nx)); pts.append((ny, nx))
                    if len(pts) > hole and np.mean([rgb[y, x].min() for y, x in pts]) > 222:
                        for y, x in pts: bg[y, x] = True
    a[:, :, 3] = np.where(bg, 0, 255)
Image.fromarray(a).save(sys.argv[2])
