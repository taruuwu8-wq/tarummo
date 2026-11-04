"""Cut an animation sheet (rows of frames on transparency) into a uniform-cell sprite sheet.
Frames in each row band are found as blobs, the baked-in lavender ground shadow is removed, and every frame is
aligned on its feet (bottom-centre of the lowest 25% of opaque pixels) so the character doesn't jitter.
Usage: python3 -I tools/slice_anim.py SHEET OUT_PREFIX 'name:y0:y1:i.j.k:fps,...' [min_x]
(i.j.k = which blobs of the row, left to right; min_x skips the portrait/labels on the left)
Writes OUT_PREFIX_sheet.png (one row per animation), OUT_PREFIX.png (first idle frame) and prints the JSON for classes.json."""
import sys, json
from collections import deque
import numpy as np
from PIL import Image

src, outp, spec = sys.argv[1], sys.argv[2], sys.argv[3]
a = np.array(Image.open(src).convert('RGBA')); H, W = a.shape[:2]
r, g, b = (a[:, :, i].astype(int) for i in range(3))
lav = (b - g > 16) & (r > 115) & (b > 145) & (b > r)            # baked ground shadow (light lavender)
MINX = int(sys.argv[4]) if len(sys.argv) > 4 else 0
rows = []
for part in spec.split(','):
    name, y0, y1, pick, fps = part.split(':'); rows.append((name, int(y0), int(y1), [int(i) for i in pick.split('.')], int(fps)))

def blobs(mask):
    h, w = mask.shape; lab = np.zeros((h, w), int); n = 0; out = []
    for y in range(h):
        for x in range(w):
            if mask[y, x] and not lab[y, x]:
                n += 1; q = deque([(y, x)]); lab[y, x] = n; ys = [y]; xs = [x]
                while q:
                    cy, cx = q.popleft()
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]: lab[ny, nx] = n; q.append((ny, nx)); ys.append(ny); xs.append(nx)
                out.append((n, min(ys), min(xs), max(ys), max(xs)))
    return lab, out

anims = {}
frames = {}
for name, y0, y1, pick, fps in rows:
    band = a[y0:y1].copy(); m = band[:, :, 3] > 40
    # no dilation: frames sit close together and must stay separate; drop label pills/underlines (flat) and sparkles
    lab, bl = blobs(m)
    bl = [x for x in bl if x[2] >= MINX and x[3] - x[1] > 30 and x[4] - x[2] > 25]   # frames sit right of the row labels
    print(name, [(x[2], x[4] - x[2], x[3] - x[1]) for x in bl], file=sys.stderr)
    bl.sort(key=lambda x: x[2])
    bl = [bl[i] for i in pick]
    fl = []
    for k, by0, bx0, by1, bx1 in bl:
        c = band[by0:by1 + 1, bx0:bx1 + 1].copy()
        keep = (lab[by0:by1 + 1, bx0:bx1 + 1] == k) & (c[:, :, 3] > 40)
        sh = lav[y0 + by0:y0 + by1 + 1, bx0:bx1 + 1]; hh = c.shape[0]
        sh[: int(hh * 0.75)] = False                             # shadow is only under the feet
        keep &= ~sh
        c[:, :, 3] = np.where(keep, c[:, :, 3], 0)
        ys, xs = np.nonzero(c[:, :, 3] > 40)
        bot = ys.max(); low = ys > bot - (ys.max() - ys.min()) * 0.25
        fl.append((c, int(round(xs[low].mean())), int(bot)))
    frames[name] = fl
    anims[name] = {'row': len(anims), 'n': len(fl), 'fps': fps}

left = max(cx for fl in frames.values() for _, cx, _ in fl); right = max(c.shape[1] - cx for fl in frames.values() for c, cx, _ in fl)
up = max(bot for fl in frames.values() for _, _, bot in fl) + 2
fw, fh = left + right, up + 2
cols = max(len(f) for f in frames.values())
sheet = Image.new('RGBA', (fw * cols, fh * len(frames)), (0, 0, 0, 0))
for ri, (name, fl) in enumerate(frames.items()):
    for ci, (c, cx, bot) in enumerate(fl):
        sheet.alpha_composite(Image.fromarray(c), (ci * fw + left - cx, ri * fh + up - bot))
sheet.save(f'{outp}_sheet.png', optimize=True)
first_row = list(frames)[0]
still = sheet.crop((0, 0, fw, fh)); bb = still.getbbox(); still.crop(bb).save(f'{outp}.png', optimize=True)
print(json.dumps({'fw': fw, 'fh': fh, 'ax': left, 'ay': up, 'cols': cols, 'anims': anims}))   # ax/ay = feet inside a cell
