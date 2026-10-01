#!/usr/bin/env python3
"""Cuts a character out of its drawing, for the bot's faces.

    python3 matte.py <source> <out.cut.png> [--key]

Writes the drawing as RGBA with its background gone, for a characters.json
entry to name as its `cutout`. Run once per drawing; the result is committed,
so building the plugin never needs any of this.

The matte comes from isnet-anime, the anime model rembg ships as
"isnet-anime" (github.com/danielgatis/rembg), run directly through
onnxruntime. It is 176 MB and is downloaded on first use into
~/.cache/paperly/, or read from $PAPERLY_MATTE_MODEL if that is set.

Needs numpy, Pillow, scipy and onnxruntime.

Two things are done after the model, and both matter on a coloured page:

1. Specks are dropped. The model leaves faint islands in busy backgrounds;
   anything not touching the main figure is cleared.

2. With --key, page that shows between strands of hair is cleared too. The
   model reads a gap in the hair as hair, and the gap is often closed in by
   strands on every side, so it cannot be reached from the page outside.
   Anything that close to the colour along the drawing's border goes,
   wherever it is -- which is why this is only for a page whose colour the
   character does not wear: Nezuko on hot pink, not Anya, whose hair is the
   colour of hers.

3. The fringe is un-mixed. A pixel on the outline of dark hair drawn on a hot
   pink page is part hair, part pink, and kept as it is it puts a pink halo
   around the head on any other background. The page colour behind each such
   pixel is estimated from the page pixels near it, and taken back out.
"""
import os
import sys
import urllib.request

import numpy as np
import onnxruntime as ort
from PIL import Image
from scipy import ndimage

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx"
SIDE = 1024
# Below this the model is guessing; above the other, it is sure.
CLEAR = 0.04
SOLID = 0.96


def model_path():
    path = os.environ.get("PAPERLY_MATTE_MODEL")
    if path:
        return path
    path = os.path.expanduser("~/.cache/paperly/isnet-anime.onnx")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print(f"downloading {MODEL_URL}\n  -> {path}", file=sys.stderr)
        urllib.request.urlretrieve(MODEL_URL, path + ".part")
        os.replace(path + ".part", path)
    return path


def matte(img):
    """The figure's alpha in 0..1, at the drawing's own size."""
    session = ort.InferenceSession(model_path(), providers=["CPUExecutionProvider"])
    x = np.asarray(img.resize((SIDE, SIDE), Image.LANCZOS)).astype(np.float32)
    x = x / max(float(x.max()), 1e-6)
    # rembg's normalisation for this model: mean subtracted, no std division.
    x = x - np.array([0.485, 0.456, 0.406], np.float32)
    pred = session.run(None, {"img": x.transpose(2, 0, 1)[None]})[0][0, 0]
    pred = (pred - pred.min()) / max(float(pred.max() - pred.min()), 1e-6)
    alpha = Image.fromarray((pred * 255).astype(np.uint8), "L").resize(img.size, Image.LANCZOS)
    return np.asarray(alpha).astype(np.float32) / 255


def drop_specks(alpha):
    """Keeps the figure: every solid region touching the largest one, with its soft edge."""
    solid = alpha > 0.5
    labels, count = ndimage.label(solid)
    if count <= 1:
        return alpha
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    keep = np.isin(labels, 1 + np.flatnonzero(sizes >= 0.02 * sizes.max()))
    # Grown a little, so the anti-aliased edge around what is kept survives.
    keep = ndimage.binary_dilation(keep, iterations=6)
    return np.where(keep, alpha, 0)


# How close to the page colour a pixel must be for --key to clear it.
KEY_TOLERANCE = 48


def key_out(rgb, alpha):
    """Clears every page-coloured pixel, inside the figure as well as out."""
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    page = np.median(border, axis=0)
    near = np.linalg.norm(rgb - page, axis=-1) < KEY_TOLERANCE
    # The pixel either side of a cleared gap is half page; let unmix have it.
    edge = ndimage.binary_dilation(near, iterations=1) & ~near
    alpha = np.where(near, 0, alpha)
    return np.where(edge, np.minimum(alpha, 0.5), alpha)


def unmix(rgb, alpha):
    """Takes the page colour back out of the half-covered pixels at the edge."""
    a = alpha[..., None]
    page = 1 - a
    # The page colour around each pixel: an average over the page pixels near
    # it, weighted by how much page each one is.
    sigma = max(2.0, min(rgb.shape[:2]) / 160)
    num = np.stack([ndimage.gaussian_filter(rgb[..., c] * page[..., 0], sigma) for c in range(3)], -1)
    den = ndimage.gaussian_filter(page[..., 0], sigma)[..., None]
    behind = num / np.maximum(den, 1e-4)
    fore = (rgb - page * behind) / np.maximum(a, 1e-4)
    edge = (alpha > CLEAR) & (alpha < SOLID)
    out = rgb.copy()
    out[edge] = np.clip(fore[edge], 0, 255)
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        sys.exit(__doc__)
    src, dst = args
    img = Image.open(src).convert("RGB")
    rgb = np.asarray(img).astype(np.float32)
    alpha = drop_specks(matte(img))
    if "--key" in sys.argv:
        alpha = key_out(rgb, alpha)
    alpha = np.where(alpha < CLEAR, 0, np.where(alpha > SOLID, 1, alpha))
    rgb = unmix(rgb, alpha)
    rgba = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(dst, optimize=True)
    print(f"{dst}  {img.size[0]}x{img.size[1]}  covered {100 * float(alpha.mean()):.0f}%")


if __name__ == "__main__":
    main()
