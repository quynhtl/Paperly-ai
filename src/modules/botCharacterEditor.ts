// Adding your own character to the floating bot.
//
// The (+) in the picker, in Settings and in the View menu all come here: a
// picture is chosen, then placed in the bot's circle in a small window --
// dragged, zoomed, with or without its background, named, coloured -- and on
// Add its face is written into the profile (botCharacters.customCharactersDir)
// and it joins the list as the chosen character.
//
// The window is addon/content/botCharacterEditor.xhtml; it calls back into
// registerBotCharacterEditor through hooks.onBotEditorEvent.
import { config } from "../../package.json";
import { artStyleSheet, buildCharacterArt } from "./botArt";
import {
  addCustomBotCharacter,
  customCharactersDir,
  type BotCharacter,
} from "./botCharacters";
import {
  FACE_DISC_RADIUS,
  FACE_SIZE,
  coverView,
  cutPlainBackground,
  dominantTint,
  drawInFrame,
  loadPicture,
  renderFace,
  type FaceView,
} from "./botImage";
import { setBotCharacter } from "./floatingBot";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const EDITOR_URL = `chrome://${config.addonRef}/content/botCharacterEditor.xhtml`;
/** The stage shows the whole face frame, this many CSS px wide. */
const STAGE = 300;
/** The preview: the character as the picker and Settings draw it. */
const PREVIEW = 128;
/** Below this much page taken, the background was not plain after all. */
const NOTHING_TAKEN = 0.03;

/** The colours on offer for the plate and the glow; null is "from the picture". */
const SWATCHES: Array<[string, number[] | null]> = [
  ["From the picture", null],
  ["Rose", [246, 176, 204]],
  ["Coral", [255, 140, 120]],
  ["Orange", [255, 172, 84]],
  ["Gold", [240, 196, 70]],
  ["Green", [110, 200, 120]],
  ["Teal", [80, 190, 200]],
  ["Blue", [110, 150, 255]],
  ["Violet", [170, 130, 255]],
  ["Crimson", [228, 76, 88]],
];

interface EditorArgs {
  path?: string;
}

/** Asks for a picture, then opens the editor on it. */
export async function addCustomCharacter(opener: Window): Promise<void> {
  const path = await pickPicture(opener);
  Zotero.debug(`Paperly bot editor: picture ${path ? "chosen" : "not chosen"}`);
  if (!path) {
    return;
  }
  const args: EditorArgs = { path };
  opener.openDialog(EDITOR_URL, "", "chrome,dialog,centerscreen,resizable=no", args);
}

function pickPicture(opener: Window): Promise<string | null> {
  const browsingContext = (opener as Window & { browsingContext?: BrowsingContext })
    .browsingContext;
  if (!browsingContext) {
    return Promise.resolve(null);
  }
  const picker = (
    Components.classes as Record<string, { createInstance: (i: unknown) => nsIFilePicker }>
  )["@mozilla.org/filepicker;1"].createInstance(Components.interfaces.nsIFilePicker);
  // The fallbacks are the interface's own values, for typings that lack them.
  const modeOpen = (picker.modeOpen ?? 0) as nsIFilePicker.Mode;
  const returnOK = (picker.returnOK ?? 0) as nsIFilePicker.ResultCode;
  picker.init(browsingContext, "Choose a picture of your character", modeOpen);
  picker.appendFilters(picker.filterImages ?? 0x08);
  return new Promise((resolve) => {
    picker.open({
      done(result: nsIFilePicker.ResultCode) {
        Zotero.debug(`Paperly bot editor: file picker returned ${result}`);
        resolve(result === returnOK && picker.file ? picker.file.path : null);
      },
    });
  });
}

function styleSheet(): string {
  return `
${artStyleSheet()}
window { display: flex; }
#paperly-bot-editor-root {
  --bg: #f6f6f8;
  --fg: #1d1d22;
  --muted: rgba(0, 0, 0, 0.55);
  --line: rgba(0, 0, 0, 0.14);
  --field: #ffffff;
  --accent: #4072e5;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  padding: 18px 20px;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  #paperly-bot-editor-root {
    --bg: #18181b;
    --fg: #ececf1;
    --muted: rgba(255, 255, 255, 0.55);
    --line: rgba(255, 255, 255, 0.14);
    --field: #232328;
  }
}
.ed-title { margin: 0; font-size: 16px; font-weight: 600; }
.ed-lead { margin: 2px 0 0; color: var(--muted); }
.ed-main { display: flex; gap: 20px; flex: 1; min-height: 0; }
.ed-stage-col { display: flex; flex-direction: column; gap: 8px; }
.ed-stage {
  width: ${STAGE}px;
  height: ${STAGE}px;
  border-radius: 12px;
  cursor: grab;
  touch-action: none;
}
.ed-stage.is-dragging { cursor: grabbing; }
.ed-zoom { display: flex; align-items: center; gap: 8px; }
.ed-zoom input { flex: 1; }
.ed-hint { color: var(--muted); font-size: 12px; }
.ed-side { display: flex; flex-direction: column; gap: 12px; flex: 1; min-width: 0; }
.ed-preview {
  display: grid;
  place-items: center;
  height: 150px;
  border-radius: 12px;
  border: 1px solid var(--line);
  --paperly-art-size: ${PREVIEW}px;
}
.ed-field { display: flex; flex-direction: column; gap: 4px; }
.ed-field input {
  font: inherit;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--field);
  color: inherit;
}
.ed-check { display: flex; gap: 8px; align-items: flex-start; }
.ed-check input { margin: 2px 0 0; }
.ed-check small { display: block; color: var(--muted); }
.ed-check.is-off { opacity: 0.5; }
.ed-swatches { display: flex; flex-wrap: wrap; gap: 7px; }
.ed-swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
  font: 600 9px/20px -apple-system, system-ui, sans-serif;
  color: #fff;
  cursor: default;
}
.ed-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
.ed-status { min-height: 18px; color: var(--muted); font-size: 12px; }
.ed-status.is-error { color: #d14b4b; }
.ed-footer { display: flex; justify-content: flex-end; gap: 8px; }
.ed-button {
  font: inherit;
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--field);
  color: inherit;
}
.ed-button.is-primary { border-color: transparent; background: var(--accent); color: #fff; font-weight: 600; }
.ed-button:disabled { opacity: 0.5; }
`;
}

/** The name the file suggests: "my_luffy-2.png" -> "My luffy 2". */
function nameFromPath(path: string): string {
  const base = (PathUtils.filename(path) || "").replace(/\.[^.]+$/, "");
  const words = base.replace(/[_\-.]+/g, " ").trim();
  const name = words ? words[0].toUpperCase() + words.slice(1) : "My character";
  return name.slice(0, 32);
}

export function registerBotCharacterEditor(win: Window): void {
  Zotero.debug("Paperly bot editor: window loaded");
  const doc = win.document;
  const root = doc.getElementById("paperly-bot-editor-root") as HTMLElement | null;
  if (!root) {
    return;
  }
  const args = ((win as Window & { arguments?: unknown[] }).arguments?.[0] ?? {}) as EditorArgs;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
    const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
    if (className) {
      node.className = className;
    }
    return node;
  };

  const style = el("style");
  style.textContent = styleSheet();
  doc.documentElement?.appendChild(style);

  // ------------------------------------------------------------- markup --
  const title = el("h1", "ed-title");
  title.textContent = "Add your own character";
  const lead = el("p", "ed-lead");
  lead.textContent =
    "Drag the picture to move it and scroll to zoom. The circle is what the bot shows.";

  const stage = el("canvas", "ed-stage");
  const zoomRow = el("label", "ed-zoom");
  const zoomLabel = el("span");
  zoomLabel.textContent = "Zoom";
  const zoom = el("input");
  zoom.type = "range";
  zoom.min = "0";
  zoom.max = "1000";
  zoomRow.append(zoomLabel, zoom);
  const hint = el("div", "ed-hint");
  hint.textContent = "Put the face in the middle of the circle.";
  const stageCol = el("div", "ed-stage-col");
  stageCol.append(stage, zoomRow, hint);

  const preview = el("div", "ed-preview");
  const nameField = el("label", "ed-field");
  const nameLabel = el("span");
  nameLabel.textContent = "Name";
  const name = el("input");
  name.type = "text";
  name.maxLength = 32;
  name.value = args.path ? nameFromPath(args.path) : "";
  nameField.append(nameLabel, name);

  const check = (label: string, note: string) => {
    const row = el("label", "ed-check");
    const box = el("input");
    box.type = "checkbox";
    const text = el("span");
    text.textContent = label;
    const small = el("small");
    small.textContent = note;
    text.appendChild(small);
    row.append(box, text);
    return { row, box };
  };
  const cut = check(
    "Take the background off",
    "For a picture on a plain background: the character then stands in front of the bot's sphere.",
  );
  const pop = check(
    "Let the head come out of the circle",
    "Above the circle's middle, the cut-out may reach past its edge.",
  );
  pop.box.checked = true;

  const swatchRow = el("div", "ed-swatches");
  const colourField = el("div", "ed-field");
  const colourLabel = el("span");
  colourLabel.textContent = "Colour";
  colourField.append(colourLabel, swatchRow);

  const status = el("div", "ed-status");
  const side = el("div", "ed-side");
  side.append(preview, nameField, cut.row, pop.row, colourField, status);

  const main = el("div", "ed-main");
  main.append(stageCol, side);

  const cancel = el("button", "ed-button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const add = el("button", "ed-button is-primary");
  add.type = "button";
  add.textContent = "Add character";
  add.disabled = true;
  const footer = el("div", "ed-footer");
  footer.append(cancel, add);

  const header = el("div");
  header.append(title, lead);
  root.append(header, main, footer);

  // -------------------------------------------------------------- state --
  let original: HTMLCanvasElement | null = null;
  let cutOut: HTMLCanvasElement | null = null;
  let view: FaceView = { cx: 0, cy: 0, scale: 1 };
  let cover = 1;
  let chosenTint: number[] | null = null;
  let detectedTint: number[] | null = null;
  let frame: number | null = null;

  const kind = (): "cutout" | "framed" => (cut.box.checked && cutOut ? "cutout" : "framed");
  const picture = () => (kind() === "cutout" ? cutOut! : original!);
  const setStatus = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  };

  // Zoom runs from a third of "just covers the circle" to six times it, on a
  // log scale so the slider feels even at both ends.
  const MIN = 1 / 3;
  const MAX = 6;
  const sliderFor = (scale: number) =>
    String(Math.round((Math.log(scale / cover / MIN) / Math.log(MAX / MIN)) * 1000));
  const scaleFor = (slider: number) => cover * MIN * Math.pow(MAX / MIN, slider / 1000);

  // ------------------------------------------------------------ drawing --
  const drawStage = () => {
    if (!original) {
      return;
    }
    const dpr = win.devicePixelRatio || 1;
    const size = Math.round(STAGE * dpr);
    if (stage.width !== size) {
      stage.width = stage.height = size;
    }
    const g = stage.getContext("2d") as unknown as CanvasRenderingContext2D;
    g.clearRect(0, 0, size, size);
    // A checkerboard, so what a cut takes away reads as taken.
    const cell = 10 * dpr;
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        g.fillStyle = ((x + y) / cell) % 2 ? "#2a2a30" : "#34343b";
        g.fillRect(x, y, cell, cell);
      }
    }
    drawInFrame(g, picture(), view, size);

    // Outside the circle is dimmed, less so above its middle when the head may
    // come out there -- the same split the bot's own mask makes.
    const c = size / 2;
    const r = (c * FACE_DISC_RADIUS) / (FACE_SIZE / 2);
    const outside = (y0: number, y1: number, alpha: number) => {
      g.save();
      g.beginPath();
      g.rect(0, y0, size, y1 - y0);
      g.clip();
      g.beginPath();
      g.rect(0, 0, size, size);
      g.arc(c, c, r, 0, Math.PI * 2, true);
      g.fillStyle = `rgba(10, 10, 14, ${alpha})`;
      g.fill("evenodd");
      g.restore();
    };
    const popping = kind() === "cutout" && pop.box.checked;
    outside(0, c, popping ? 0.3 : 0.65);
    outside(c, size, 0.65);
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.lineWidth = 2 * dpr;
    g.strokeStyle = "rgba(255, 255, 255, 0.9)";
    g.stroke();
  };

  const character = (url: string): BotCharacter => ({
    id: "preview",
    name: name.value.trim() || "My character",
    file: url,
    frames: 1,
    kind: kind(),
    popout: kind() === "cutout" && pop.box.checked,
    tint: (chosenTint ?? detectedTint) || undefined,
  });

  const drawPreview = () => {
    if (!original) {
      return;
    }
    const face = renderFace(doc, picture(), view, kind());
    detectedTint = dominantTint(face);
    const auto = swatchRow.firstElementChild as HTMLElement | null;
    if (auto) {
      auto.style.background = detectedTint ? `rgb(${detectedTint.join(", ")})` : "#999";
    }
    const url = face.toDataURL("image/png");
    preview.textContent = "";
    preview.appendChild(buildCharacterArt(doc, character(url), url));
  };

  const redraw = () => {
    if (frame !== null) {
      return;
    }
    frame = win.requestAnimationFrame(() => {
      frame = null;
      drawStage();
      drawPreview();
    });
  };

  // ------------------------------------------------------------ swatches --
  for (const [label, rgb] of SWATCHES) {
    const swatch = el("button", "ed-swatch");
    swatch.type = "button";
    swatch.title = label;
    swatch.setAttribute("aria-label", label);
    swatch.setAttribute("aria-pressed", String(rgb === null));
    if (rgb) {
      swatch.style.background = `rgb(${rgb.join(", ")})`;
    } else {
      swatch.textContent = "A";
    }
    swatch.addEventListener("click", () => {
      chosenTint = rgb;
      for (const other of Array.from(swatchRow.children)) {
        other.setAttribute("aria-pressed", String(other === swatch));
      }
      redraw();
    });
    swatchRow.appendChild(swatch);
  }

  // ------------------------------------------------------- interactions --
  const zoomAround = (scale: number, stageX: number, stageY: number) => {
    const next = Math.min(cover * MAX, Math.max(cover * MIN, scale));
    // Keep the picture's pixel under the point where it is.
    const k = (s: number) => (s * STAGE) / FACE_SIZE;
    const px = view.cx + (stageX - STAGE / 2) / k(view.scale);
    const py = view.cy + (stageY - STAGE / 2) / k(view.scale);
    view = {
      cx: px - (stageX - STAGE / 2) / k(next),
      cy: py - (stageY - STAGE / 2) / k(next),
      scale: next,
    };
    zoom.value = sliderFor(next);
    redraw();
  };

  let drag: { x: number; y: number; cx: number; cy: number } | null = null;
  stage.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!original || event.button !== 0) {
      return;
    }
    stage.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, cx: view.cx, cy: view.cy };
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event: PointerEvent) => {
    if (!drag) {
      return;
    }
    const k = (view.scale * STAGE) / FACE_SIZE;
    view = {
      ...view,
      cx: drag.cx - (event.clientX - drag.x) / k,
      cy: drag.cy - (event.clientY - drag.y) / k,
    };
    redraw();
  });
  const endDrag = () => {
    drag = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      if (!original) {
        return;
      }
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      zoomAround(
        view.scale * Math.exp(-event.deltaY * 0.0015),
        event.clientX - box.left,
        event.clientY - box.top,
      );
    },
    { passive: false },
  );
  zoom.addEventListener("input", () => {
    zoomAround(scaleFor(Number(zoom.value)), STAGE / 2, STAGE / 2);
  });

  const syncPopout = () => {
    const can = cut.box.checked && Boolean(cutOut);
    pop.box.disabled = !can;
    pop.row.classList.toggle("is-off", !can);
  };
  cut.box.addEventListener("change", () => {
    if (cut.box.checked && original && !cutOut) {
      const result = cutPlainBackground(doc, original);
      if (result.taken < NOTHING_TAKEN) {
        cut.box.checked = false;
        setStatus("No plain background to take off here, so the picture stays as it is.");
      } else {
        cutOut = result.picture;
        setStatus("");
      }
    }
    syncPopout();
    redraw();
  });
  pop.box.addEventListener("change", redraw);
  name.addEventListener("input", redraw);

  cancel.addEventListener("click", () => win.close());
  win.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      win.close();
    }
  });
  name.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !add.disabled) {
      void save();
    }
  });

  // ---------------------------------------------------------------- save --
  const save = async () => {
    if (!original) {
      return;
    }
    add.disabled = true;
    setStatus("Saving…");
    try {
      const face = renderFace(doc, picture(), view, kind());
      const blob = await new Promise<Blob | null>((resolve) => face.toBlob(resolve, "image/png"));
      if (!blob) {
        throw new Error("The face could not be drawn");
      }
      const dir = customCharactersDir();
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
      const id = `custom-${Date.now().toString(36)}`;
      const file = PathUtils.join(dir, `${id}.png`);
      await IOUtils.write(file, new Uint8Array(await blob.arrayBuffer()));
      const made = character(file);
      addCustomBotCharacter({ ...made, id, file });
      setBotCharacter(id);
      win.close();
    } catch (error) {
      ztoolkit.log("Adding a bot character failed:", error);
      setStatus(`Could not add it: ${(error as Error)?.message ?? error}`, true);
      add.disabled = false;
    }
  };
  add.addEventListener("click", () => void save());

  // ---------------------------------------------------------------- load --
  syncPopout();
  if (!args.path) {
    setStatus("No picture was chosen.", true);
    return;
  }
  setStatus("Reading the picture…");
  loadPicture(doc, PathUtils.toFileURI(args.path))
    .then((loaded) => {
      original = loaded;
      view = coverView(loaded);
      cover = view.scale;
      zoom.value = sliderFor(view.scale);
      add.disabled = false;
      setStatus("");
      syncPopout();
      redraw();
      name.focus();
      name.select();
    })
    .catch((error: Error) => setStatus(error.message, true));
}
