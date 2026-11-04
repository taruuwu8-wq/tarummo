"""Keep only the largest blob in each sprite PNG (drops slivers of neighbouring figures), then trim.
Usage: python3 -I tools/clean_sprite.py public/sprites/*.png"""
import sys
from collections import deque
import numpy as np
from PIL import Image

for path in sys.argv[1:]:
    im = Image.open(path).convert('RGBA'); a = np.array(im); h, w = a.shape[:2]
    m = a[:, :, 3] > 20
    # dilate by 2px so weapons/hair separated by a thin gap stay attached
    d = m.copy()
    for dy in (-2, -1, 0, 1, 2):
        for dx in (-2, -1, 0, 1, 2):
            d |= np.roll(np.roll(m, dy, 0), dx, 1)
    lab = np.zeros((h, w), np.int32); best, best_n, cur = 0, 0, 0
    for y in range(h):
        for x in range(w):
            if d[y, x] and not lab[y, x]:
                cur += 1; n = 0; q = deque([(y, x)]); lab[y, x] = cur
                while q:
                    cy, cx = q.popleft(); n += m[cy, cx]
                    for ny, nx in ((cy+1, cx), (cy-1, cx), (cy, cx+1), (cy, cx-1)):
                        if 0 <= ny < h and 0 <= nx < w and d[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = cur; q.append((ny, nx))
                if n > best_n: best, best_n = cur, n
    keep = (lab == best) & m
    a[~keep, 3] = 0
    ys, xs = np.where(keep)
    out = a[ys.min():ys.max()+1, xs.min():xs.max()+1]
    Image.fromarray(out).save(path)
    print(f'{path}: {w}x{h} -> {out.shape[1]}x{out.shape[0]}')
