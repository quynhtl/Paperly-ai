// The pixel work behind adding your own character: reading the picture,
// taking a plain background off it, cutting the face frame, and finding the
// picture's colour. Canvas only, so it runs in the editor's own window.
//
// The built-in faces are made at build time by assets/bot/portrait.html and
// matte.py, which can afford a segmentation model. A user's picture gets the
// cheaper half of that: a background is taken off only when it is plain, by
// flooding in from the picture's edge. The editor shows the result, so a
// picture where that fails is simply left framed.
import { DISC, FRAME } from "./botArt";

/** The face file's width: the frame at 2x. */
export const FACE_SIZE = FRAME * 2;
/** The disc's radius in the face file. */
export const FACE_DISC_RADIUS = (FACE_SIZE / 2) * (DISC / FRAME);
/** Pictures are worked on at most this big; nothing needs more for a 224px face. */
const WORK_SIDE = 1600;

const HTML_NS = "http://www.w3.org/1999/xhtml";

function canvas(doc: Document, width: number, height: number): HTMLCanvasElement {
  const c = doc.createElementNS(HTML_NS, "canvas") as HTMLCanvasElement;
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** The 2D context. Gecko's typings return nsISupports for getContext. */
function context(c: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  return c.getContext("2d", { willReadFrequently }) as unknown as CanvasRenderingContext2D;
}

/**
 * The picture at half, quarter, ... size, made once and kept with it. Canvas
 * scaling in Gecko is bilinear and has no "high" quality, so a 1600px picture
 * drawn straight down to a 224px face skips most of its pixels and shimmers;
 * drawn from the nearest level at no less than half, it does not.
 */
const levels = new WeakMap<HTMLCanvasElement, HTMLCanvasElement[]>();

function levelFor(picture: HTMLCanvasElement, scale: number): { level: HTMLCanvasElement; factor: number } {
  let chain = levels.get(picture);
  if (!chain) {
    chain = [picture];
    levels.set(picture, chain);
  }
  let factor = 1;
  let level = picture;
  for (let i = 1; scale * factor < 0.5 && level.width > 2 && level.height > 2; i++) {
    if (!chain[i]) {
      const prev = chain[i - 1];
      const half = canvas(prev.ownerDocument!, prev.width / 2, prev.height / 2);
      context(half).drawImage(prev, 0, 0, half.width, half.height);
      chain[i] = half;
    }
    level = chain[i];
    factor *= 2;
  }
  return { level, factor };
}

/** The picture, decoded and brought down to a working size. */
export function loadPicture(doc: Document, url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = doc.createElementNS(HTML_NS, "img") as HTMLImageElement;
    img.onload = () => {
      const scale = Math.min(1, WORK_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      // Brought down in halves for the same reason as levelFor.
      let source: HTMLCanvasElement | HTMLImageElement = img;
      let width = img.naturalWidth;
      let height = img.naturalHeight;
      while (width / 2 >= img.naturalWidth * scale) {
        const half = canvas(doc, width / 2, height / 2);
        context(half).drawImage(source, 0, 0, half.width, half.height);
        source = half;
        width = half.width;
        height = half.height;
      }
      const out = canvas(doc, img.naturalWidth * scale, img.naturalHeight * scale);
      context(out).drawImage(source, 0, 0, out.width, out.height);
      resolve(out);
    };
    img.onerror = () => reject(new Error("The picture could not be read"));
    img.src = url;
  });
}

/**
 * Takes a plain background off: the colour most common along the picture's
 * edge, flooded in from the edge, `tolerance` apart (RGB distance). The ring
 * of pixels next to what was taken is half background and half figure; it is
 * un-mixed from the background colour rather than kept or dropped, which is
 * what stops a halo of the old background around the head.
 *
 * Returns how much of the picture was taken, 0..1, so the editor can say when
 * nothing came off.
 */
export function cutPlainBackground(
  doc: Document,
  source: HTMLCanvasElement,
  tolerance = 40,
): { picture: HTMLCanvasElement; taken: number } {
  const W = source.width;
  const H = source.height;
  const out = canvas(doc, W, H);
  const g = context(out, true);
  g.drawImage(source, 0, 0);
  const image = g.getImageData(0, 0, W, H);
  const px = image.data;

  // The page colour: the median of the edge, channel by channel.
  const edge: number[][] = [[], [], []];
  const sample = (x: number, y: number) => {
    const o = (x + y * W) * 4;
    for (let c = 0; c < 3; c++) {
      edge[c].push(px[o + c]);
    }
  };
  for (let x = 0; x < W; x++) {
    sample(x, 0);
    sample(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    sample(0, y);
    sample(W - 1, y);
  }
  const page = edge.map((values) => {
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  });
  const distance = (i: number) => {
    const o = i * 4;
    return Math.hypot(px[o] - page[0], px[o + 1] - page[1], px[o + 2] - page[2]);
  };

  const field = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = x + y * W;
    if (!field[i] && px[i * 4 + 3] > 0 && distance(i) < tolerance) {
      field[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < W; x++) {
    push(x, 0);
    push(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    push(0, y);
    push(W - 1, y);
  }
  for (let s = 0; s < stack.length; s++) {
    const i = stack[s];
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  let taken = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (field[i]) {
      px[o + 3] = 0;
      taken++;
      continue;
    }
    const x = i % W;
    const y = (i - x) / W;
    const touches =
      (x > 0 && field[i - 1]) ||
      (x < W - 1 && field[i + 1]) ||
      (y > 0 && field[i - W]) ||
      (y < H - 1 && field[i + W]);
    if (!touches) {
      continue;
    }
    // How much of this pixel is figure: as far from the page as it is, out of
    // as far as it could be. Then the page that was mixed in is taken back out.
    let reach = 0;
    for (let c = 0; c < 3; c++) {
      reach = Math.max(reach, page[c] > 127 ? page[c] : 255 - page[c]);
    }
    const a = Math.min(1, (1.2 * distance(i)) / Math.max(reach, 1));
    if (a < 0.02) {
      px[o + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      px[o + c] = Math.max(0, Math.min(255, (px[o + c] - (1 - a) * page[c]) / a));
    }
    px[o + 3] = Math.round(px[o + 3] * a);
  }
  g.putImageData(image, 0, 0);
  return { picture: out, taken: taken / (W * H) };
}

/**
 * Where the picture sits in the face frame: the picture's own pixel that lands
 * on the frame's centre, and how many frame pixels (at FACE_SIZE) one picture
 * pixel covers.
 */
export interface FaceView {
  cx: number;
  cy: number;
  scale: number;
}

/** The view that just covers the disc with the picture, centred. */
export function coverView(picture: HTMLCanvasElement): FaceView {
  return {
    cx: picture.width / 2,
    cy: picture.height / 2,
    scale: (FACE_DISC_RADIUS * 2) / Math.min(picture.width, picture.height),
  };
}

/** Draws the picture into a frame `size` wide, the way `view` places it. */
export function drawInFrame(
  g: CanvasRenderingContext2D,
  picture: HTMLCanvasElement,
  view: FaceView,
  size: number,
): void {
  const k = (view.scale * size) / FACE_SIZE;
  const { level, factor } = levelFor(picture, k);
  const kk = k * factor;
  g.save();
  g.setTransform(kk, 0, 0, kk, size / 2 - view.cx * k, size / 2 - view.cy * k);
  g.drawImage(level, 0, 0);
  g.restore();
}

/**
 * The face file: the frame at FACE_SIZE. A framed picture is rounded to the
 * disc here; a cut-out is left whole, because the bot masks it itself.
 */
export function renderFace(
  doc: Document,
  picture: HTMLCanvasElement,
  view: FaceView,
  kind: "cutout" | "framed",
): HTMLCanvasElement {
  const out = canvas(doc, FACE_SIZE, FACE_SIZE);
  const g = context(out);
  drawInFrame(g, picture, view, FACE_SIZE);
  if (kind === "framed") {
    g.globalCompositeOperation = "destination-in";
    g.beginPath();
    g.arc(FACE_SIZE / 2, FACE_SIZE / 2, FACE_DISC_RADIUS, 0, Math.PI * 2);
    g.fill();
  }
  return out;
}

/**
 * The picture's colour, for its plate and its glow: the hue most of its
 * clearly coloured pixels share, at full strength. Grey pictures get null,
 * and so Anya's rose.
 */
export function dominantTint(face: HTMLCanvasElement): number[] | null {
  const { data } = context(face, true).getImageData(0, 0, face.width, face.height);
  const BINS = 24;
  // Per hue bin: how strongly coloured its pixels are in all, how many there
  // are, and their summed colour.
  const weight = new Array(BINS).fill(0);
  const count = new Array(BINS).fill(0);
  const sums = Array.from({ length: BINS }, () => [0, 0, 0]);
  // Every 4th pixel is plenty for a colour.
  for (let o = 0; o < data.length; o += 16) {
    if (data[o + 3] < 128) {
      continue;
    }
    const r = data[o] / 255;
    const gr = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    const max = Math.max(r, gr, b);
    const chroma = max - Math.min(r, gr, b);
    if (chroma < 0.25 || max < 0.3) {
      continue;
    }
    const sector =
      max === r ? (gr - b) / chroma : max === gr ? 2 + (b - r) / chroma : 4 + (r - gr) / chroma;
    const hue = (((sector * 60) % 360) + 360) % 360;
    const bin = Math.floor(hue / (360 / BINS)) % BINS;
    weight[bin] += chroma;
    count[bin] += 1;
    sums[bin][0] += data[o];
    sums[bin][1] += data[o + 1];
    sums[bin][2] += data[o + 2];
  }
  let best = -1;
  for (let i = 0; i < BINS; i++) {
    if (count[i] > 0 && (best < 0 || weight[i] > weight[best])) {
      best = i;
    }
  }
  if (best < 0) {
    return null;
  }
  // The average colour of that hue, pushed up so its brightest channel is near
  // full: a plate wants the colour, not the shading it was found in.
  const mean = sums[best].map((sum) => sum / count[best]);
  const top = Math.max(...mean, 1);
  return mean.map((c) => Math.round(Math.min(255, (c * 245) / top)));
}
