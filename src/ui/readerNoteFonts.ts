// The three note fonts, and the one way of getting them into the reader.
//
// Measured, not assumed: `@font-face { src: url("chrome://zotero-webai/...") }`
// fails inside the reader with "NetworkError: A network error occurred." The
// same URL in the same @font-face loads fine in the main window, so the file is
// good and the obstacle is the reader document's resource:// principal. Fonts
// go through a principal check that <img src="chrome://..."> does not -- which
// is why the plugin's toolbar icon has always worked there.
//
// Two ways around it were tried and rejected, both "Permission denied to access
// object": constructing a `FontFace` from the content window, and minting a
// `blob:` URL in the content window. Both cross a compartment boundary with a
// chrome-side ArrayBuffer.
//
// What works is a data: URI. The bytes are read once in chrome, where the
// chrome:// URL is legal, and inlined. Cached per family for the process, so
// the base64 is paid once no matter how many papers are open.
import { config } from "../../package.json";

export type ReaderNoteFontId = "inter" | "ibm-plex-sans" | "noto-sans";

export const DEFAULT_NOTE_FONT: ReaderNoteFontId = "inter";

interface NoteFont {
  id: ReaderNoteFontId;
  label: string;
  /** The family name the @font-face declares and the panel asks for. */
  family: string;
  /** Subset files, declared in this order. */
  files: { name: string; unicodeRange: string }[];
}

// Google's subset ranges, which is how these woff2 files were cut. Latin is
// declared last on purpose: it and the Vietnamese subset overlap on the
// combining marks, and the last matching face wins.
const VIETNAMESE_RANGE =
  "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB";
const LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

export const NOTE_FONTS: NoteFont[] = [
  {
    id: "inter",
    label: "Inter",
    family: "Inter",
    files: [
      { name: "inter-vietnamese.woff2", unicodeRange: VIETNAMESE_RANGE },
      { name: "inter-latin.woff2", unicodeRange: LATIN_RANGE },
    ],
  },
  {
    id: "ibm-plex-sans",
    label: "IBM Plex Sans",
    family: "IBM Plex Sans",
    files: [
      { name: "ibm-plex-sans-vietnamese.woff2", unicodeRange: VIETNAMESE_RANGE },
      { name: "ibm-plex-sans-latin.woff2", unicodeRange: LATIN_RANGE },
    ],
  },
  {
    id: "noto-sans",
    label: "Noto Sans",
    family: "Noto Sans",
    files: [
      { name: "noto-sans-vietnamese.woff2", unicodeRange: VIETNAMESE_RANGE },
      { name: "noto-sans-latin.woff2", unicodeRange: LATIN_RANGE },
    ],
  },
];

export function getNoteFont(id: string | null | undefined): NoteFont {
  return (
    NOTE_FONTS.find((font) => font.id === id) ||
    NOTE_FONTS.find((font) => font.id === DEFAULT_NOTE_FONT) ||
    NOTE_FONTS[0]
  );
}

// The bundled face first so it always wins, then the same name unprefixed for
// anyone who has the real font installed and a build where the inline copy
// failed, then the stack the reader itself inherits so the worst case still
// looks native rather than broken.
export function noteFontStack(id: string | null | undefined): string {
  const font = getNoteFont(id);
  return `"${font.family}", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return (globalThis as unknown as { btoa: (input: string) => string }).btoa(
    binary,
  );
}

const faceCache = new Map<ReaderNoteFontId, Promise<string | null>>();

async function buildFaceCSS(font: NoteFont): Promise<string | null> {
  const blocks: string[] = [];
  for (const file of font.files) {
    const url = `chrome://${config.addonRef}/content/fonts/${file.name}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        ztoolkit.log(`readerNoteFonts: ${url} returned ${response.status}`);
        return null;
      }
      const base64 = toBase64(await response.arrayBuffer());
      blocks.push(
        `@font-face{font-family:"${font.family}";` +
          `src:url("data:font/woff2;base64,${base64}") format("woff2-variations");` +
          `font-weight:100 900;font-style:normal;font-display:block;` +
          `unicode-range:${file.unicodeRange};}`,
      );
    } catch (error) {
      ztoolkit.log(`readerNoteFonts: could not read ${url}:`, error);
      return null;
    }
  }
  return blocks.join("\n");
}

function styleID(id: ReaderNoteFontId): string {
  return `paperly-note-font-${id}`;
}

/**
 * Make one family available in a reader document. Safe to call repeatedly; the
 * bytes are read once per family and the <style> once per document. Resolves
 * even on failure -- the panel's fallback stack covers it.
 */
export async function ensureNoteFontLoaded(
  doc: Document,
  id: ReaderNoteFontId,
): Promise<void> {
  if (doc.getElementById(styleID(id))) {
    return;
  }
  let pending = faceCache.get(id);
  if (!pending) {
    pending = buildFaceCSS(getNoteFont(id));
    faceCache.set(id, pending);
  }
  const css = await pending;
  // The document can be gone by the time the bytes are ready.
  if (!css || !doc.defaultView || doc.getElementById(styleID(id))) {
    return;
  }
  const style = doc.createElement("style");
  style.id = styleID(id);
  style.textContent = css;
  (doc.head || doc.documentElement)?.appendChild(style);
}
