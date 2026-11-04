"""Make a sheet transparent: either threshold real alpha (--alpha N) or flood-remove a light/checkerboard backdrop
from the border (outlined sprites stop the flood). Usage: python3 -I tools/prep_sheet.py IN OUT [--alpha 200]"""
import sys
from collections import deque
import numpy as np
from PIL import Image
a = np.array(Image.open(sys.argv[1]).convert('RGBA')); h, w = a.shape[:2]
if '--alpha' in sys.argv:
    t = int(sys.argv[sys.argv.index('--alpha') + 1]); a[:, :, 3] = np.where(a[:, :, 3] > t, 255, 0)
else:
    rgb = a[:, :, :3].astype(int); light = (rgb.max(2) - rgb.min(2) < 18) & (rgb.min(2) > 205)
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
    a[:, :, 3] = np.where(bg, 0, 255)
Image.fromarray(a).save(sys.argv[2])
