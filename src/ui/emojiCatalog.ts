// The emoji catalogue behind the note pad's picker.
//
// The data is a text file built by scripts/build-emoji-data.mjs from
// emojibase-data (CLDR). It is read once, the first time someone opens the
// picker, and kept for the life of the process -- 1906 entries is small in
// memory and nothing about it changes at runtime.
//
// Nothing here touches the DOM, so the same module serves the desktop plugin
// and the web port.

export interface EmojiEntry {
  char: string;
  /** emojibase group: 0 smileys, 1 people, 3 animals, 4 food, 5 travel,
   *  6 activities, 7 objects, 8 symbols, 9 flags. */
  group: number;
  /** The English name, used as the cell's tooltip. */
  label: string;
  /** Accent-folded English name. */
  foldedLabel: string;
  /** Accent-folded Vietnamese name, so "cuoi" finds "cười". Scored on its own:
   *  concatenated with the English one, "starts the name" could only ever be
   *  true of English, and "sách" would not beat 🤓 to 📕. */
  foldedViLabel: string;
  /** Accent-folded tags, which rank below a name match. */
  foldedTags: string;
  /** Position in the catalogue, which is Unicode's own order. Used to break
   *  ties: it puts the everyday emoji above the obscure ones. */
  index: number;
  /** The five single-modifier skin tone variants, or empty. */
  skins: string[];
}

/**
 * Strips Vietnamese (and any other) diacritics so a query typed without them
 * still matches. Done here rather than in the data file because it would add
 * a third to its size to store both forms.
 */
export function foldAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function parse(text: string): EmojiEntry[] {
  const entries: EmojiEntry[] = [];
  for (const line of text.split("\n")) {
    // A comment is a hash FOLLOWED BY A SPACE. Plain "#" would eat the keycap
    // number sign, whose line starts with the character itself.
    if (!line || line.startsWith("# ") || !line.includes("\t")) {
      continue;
    }
    const [char, group, label = "", viLabel = "", tags = "", skins = ""] =
      line.split("\t");
    const groupNumber = Number(group);
    if (!char || !Number.isFinite(groupNumber)) {
      continue;
    }
    entries.push({
      char,
      group: groupNumber,
      label,
      foldedLabel: foldAccents(label.toLowerCase()),
      foldedViLabel: foldAccents(viLabel.toLowerCase()),
      foldedTags: foldAccents(tags.toLowerCase()),
      index: entries.length,
      skins: skins ? skins.split("|") : [],
    });
  }
  return entries;
}

let pending: Promise<EmojiEntry[]> | null = null;

/** Reads the catalogue once. Resolves to [] rather than throwing. */
export function loadEmojiCatalog(
  url: string,
  log: (...args: unknown[]) => void,
): Promise<EmojiEntry[]> {
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          log(`emojiCatalog: ${url} returned ${response.status}`);
          return [];
        }
        return parse(await response.text());
      } catch (error) {
        log(`emojiCatalog: could not read ${url}:`, error);
        return [];
      }
    })();
  }
  return pending;
}

/** For tests and for the web port, which loads the text its own way. */
export function parseEmojiCatalog(text: string): EmojiEntry[] {
  return parse(text);
}

const MAX_RESULTS = 180;

/** Where in a field the query landed: 0 exact, 1 prefix, 2 word, 3 inside, -1 not at all. */
function matchQuality(haystack: string, needle: string): number {
  if (!haystack) {
    return -1;
  }
  if (haystack === needle) {
    return 0;
  }
  const at = haystack.indexOf(needle);
  if (at < 0) {
    return -1;
  }
  const startsField = at === 0;
  const startsWord = startsField || haystack[at - 1] === " ";
  const after = haystack[at + needle.length];
  const endsWord = after === undefined || after === " ";
  if (startsField && endsWord) {
    return 0;
  }
  if (startsWord && endsWord) {
    return 1;
  }
  return startsWord ? 2 : 3;
}

/**
 * Ranked search over the names first and the tags second.
 *
 * Two things decide the order, and both earn their place. A match in a NAME
 * beats a match in a tag: "sách" is the name of 📕 and only a tag of 🤓.
 * Ties go to catalogue position, which is Unicode's own order -- that matters
 * because folding accents makes Vietnamese deliberately ambiguous, so "cuoi"
 * matches "cười" (smile), "cưới" (wedding) and "cưỡi" (ride) equally well and
 * something has to put the smile first.
 */
export function searchEmoji(
  entries: EmojiEntry[],
  query: string,
): EmojiEntry[] {
  const needle = foldAccents(query.toLowerCase().trim());
  if (!needle) {
    return [];
  }
  const scored: { entry: EmojiEntry; score: number }[] = [];
  for (const entry of entries) {
    const inName = Math.min(
      ...[
        matchQuality(entry.foldedLabel, needle),
        matchQuality(entry.foldedViLabel, needle),
      ].map((quality) => (quality < 0 ? Number.POSITIVE_INFINITY : quality)),
    );
    const inTag = Number.isFinite(inName)
      ? -1
      : matchQuality(entry.foldedTags, needle);
    if (!Number.isFinite(inName) && inTag < 0) {
      continue;
    }
    // Names occupy 0-3, tags 4-7, so any name match outranks any tag match.
    scored.push({ entry, score: Number.isFinite(inName) ? inName : 4 + inTag });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.index - b.entry.index);
  return scored.slice(0, MAX_RESULTS).map((hit) => hit.entry);
}

/** The emoji as it should appear for the chosen skin tone. */
export function applySkinTone(entry: EmojiEntry, tone: number): string {
  if (tone <= 0 || !entry.skins.length) {
    return entry.char;
  }
  return entry.skins[tone - 1] || entry.char;
}
