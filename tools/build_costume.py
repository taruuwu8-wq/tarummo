"""Cut costume pieces (headwear, wing pairs, auras) from the paper-doll sheet into public/costume/.
Each crop keeps only the large blobs (drops leftover checkerboard specks). Usage: python3 -I tools/build_costume.py WINGS_T HATS_DIR"""
import sys, json
from collections import deque
import numpy as np
from PIL import Image
wings_t, hats_dir = sys.argv[1], sys.argv[2]
def clean(im):
    a = np.array(im.convert('RGBA')); m = a[:, :, 3] > 40; h, w = m.shape; lab = np.zeros((h, w), int); sizes = [0]; n = 0
    for y in range(h):
        for x in range(w):
            if m[y, x] and not lab[y, x]:
                n += 1; q = deque([(y, x)]); lab[y, x] = n; c = 0
                while q:
                    cy, cx = q.popleft(); c += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not lab[ny, nx]: lab[ny, nx] = n; q.append((ny, nx))
                sizes.append(c)
    big = max(sizes); keep = np.isin(lab, [i for i, c in enumerate(sizes) if i and c > big * 0.15])
    a[:, :, 3] = np.where(keep, 255, 0); out = Image.fromarray(a); return out.crop(out.getbbox())
def save(im, name, maxd):
    s = maxd / max(im.size); im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    im.putalpha(im.getchannel('A').point(lambda v: 255 if v > 110 else 0)); im.save(f'public/costume/{name}.png', optimize=True)
W = Image.open(wings_t)
WINGS = {'angel': (10, 0, 182, 78), 'raven': (185, 0, 385, 78), 'bat': (390, 0, 547, 78), 'violet_moth': (550, 0, 692, 80),
         'frost_fairy': (15, 83, 117, 160), 'shade': (122, 83, 262, 160), 'dusk': (266, 83, 372, 160), 'azure_fairy': (375, 83, 462, 160), 'rose_fairy': (464, 83, 547, 160)}
AURAS = {'laurel_blue': (548, 83, 618, 160), 'laurel_pink': (622, 83, 694, 160), 'ring_violet': (696, 0, 768, 62), 'spring_blue': (696, 60, 768, 112)}
for k, r in WINGS.items(): save(clean(W.crop(r)), 'w_' + k, 160)
for k, r in AURAS.items(): save(clean(W.crop(r)), 'a_' + k, 110)
HATS = {'witch': 0, 'tiara': 1, 'witch_b': 2, 'headband': 3, 'cat_ears': 4, 'fedora': 5, 'bunny_ears': 6, 'gothic': 7, 'pirate': 8, 'flower_crown': 9, 'ribbon': 10, 'beret': 11, 'halo': 12, 'crown': 13}
for k, i in HATS.items(): save(clean(Image.open(f'{hats_dir}/hats_{i:02d}.png')), 'h_' + k, 100)
print(len(WINGS) + len(AURAS) + len(HATS))
