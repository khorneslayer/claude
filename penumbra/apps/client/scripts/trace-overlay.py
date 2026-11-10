"""Draw the traced geometry (red/green/blue) over the source chart. Needs Pillow."""
import json
import sys

from PIL import Image, ImageDraw

chart, trace_path, out = sys.argv[1:4]
t = json.load(open(trace_path))
im = Image.open(chart).convert("RGB")
d = ImageDraw.Draw(im)
for r in t["runways"]:
    d.line([tuple(r["w"]), tuple(r["e"])], fill=(230, 0, 0), width=3)
for pts in t["taxiways"].values():
    d.line([tuple(p) for p in pts], fill=(0, 120, 255), width=3)
for a in t["areas"]:
    pts = [tuple(p) for p in a["px"]]
    colour = (0, 170, 0) if a["kind"] == "apron" else (230, 0, 0)
    d.line(pts + [pts[0]], fill=colour, width=2)
im.save(out)
print(f"saved {out}")
