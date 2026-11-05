"""Turn scripts/icon-source.png (white background) into transparent PNG icons.

Each pixel is modelled as  fg*a + white*(1-a)  where fg is the nearest of the
logo's two flat colours, so anti-aliased edges keep a smooth alpha.
"""
from PIL import Image
import numpy as np, sys, os

here = os.path.dirname(os.path.abspath(__file__))
src = Image.open(os.path.join(here, "icon-source.png")).convert("RGB")
px = np.asarray(src).astype(float)

fgs = np.array([[0xDC, 0x72, 0x4E], [0x3C, 0x45, 0x47]], float)
# sample real colours from the image so we match exactly
fgs[0] = px[100, 400]
fgs[1] = px[240, 160]

best_a = np.zeros(px.shape[:2]); best_fg = np.zeros_like(px); best_err = np.full(px.shape[:2], 1e9)
for fg in fgs:
    d = 255.0 - fg                       # per-channel distance from white
    a = ((255.0 - px) * d).sum(-1) / (d * d).sum()
    a = np.clip(a, 0, 1)
    recon = fg * a[..., None] + 255 * (1 - a[..., None])
    err = ((recon - px) ** 2).sum(-1)
    m = err < best_err
    best_err[m] = err[m]; best_a[m] = a[m]; best_fg[m] = fg
best_a[best_a < 0.02] = 0
rgba = np.dstack([best_fg, best_a * 255]).round().astype(np.uint8)
img = Image.fromarray(rgba, "RGBA")

out = os.path.join(here, "..", "public")
img.save(os.path.join(out, "icon.png"))
for s in (24, 32, 64, 96, 256):
    h = round(s * img.height / img.width)
    img.resize((s, h), Image.LANCZOS).save(os.path.join(out, f"icon-{s}.png"))
# square 512 canvas for the Onshape app-store icon
sq = Image.new("RGBA", (600, 600), (0, 0, 0, 0))
sq.paste(img, ((600 - img.width) // 2, (600 - img.height) // 2), img)
sq.resize((512, 512), Image.LANCZOS).save(os.path.join(out, "icon-512.png"))
print("alpha corners:", rgba[0, 0], rgba[300, 255], "ok")
