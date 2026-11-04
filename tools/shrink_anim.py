"""Shrink a slice_anim sheet cell by cell (keeps an integer cell size) and quantize to 256 colours.
Usage: python3 -I tools/shrink_anim.py SHEET.png JSON_IN JSON_OUT SCALE   (rewrites SHEET.png in place)"""
import sys, json
from PIL import Image
sheet, jin, jout, k = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
m = json.load(open(jin)); im = Image.open(sheet).convert('RGBA')
fw, fh = m['fw'], m['fh']; nw, nh = round(fw * k), round(fh * k)
rows = im.height // fh; cols = im.width // fw
out = Image.new('RGBA', (nw * cols, nh * rows))
for r in range(rows):
    for c in range(cols):
        cell = im.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh)).resize((nw, nh), Image.LANCZOS)
        cell.putalpha(cell.getchannel('A').point(lambda v: 255 if v > 110 else 0))
        out.paste(cell, (c * nw, r * nh))
out.quantize(256, method=Image.FASTOCTREE, dither=Image.NONE).save(sheet, optimize=True)
m.update(fw=nw, fh=nh, ax=round(m['ax'] * k), ay=round(m['ay'] * k))
json.dump(m, open(jout, 'w'))
