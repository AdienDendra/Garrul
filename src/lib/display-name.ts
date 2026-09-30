/**
 * Display names: the one place that decides what a stored `users.name` may
 * contain and when two names count as "the same person".
 *
 * Both anonymous names (typed into the widget) and OAuth display names (read
 * from a provider profile) go through `sanitizeDisplayName`, so neither path
 * can store something the other would refuse.
 */

/** Longest stored display name, in UTF-16 code units (what `.length` counts). */
export const MAX_NAME = 40;

// C0 controls + DEL + C1 controls, matching sanitizePostTitle's range so a name
// and a title can't disagree about what's storable. The Atom feed cannot
// represent C0 at all — one occurrence is a fatal XML error for the document.
const CONTROL = "\\u0000-\\u001F\\u007F-\\u009F";

// Characters with no visible glyph that change how the text *around* them
// renders, or that render as nothing at all:
//   U+00AD soft hyphen, U+061C Arabic letter mark, U+180E Mongolian vowel sep,
//   U+200B zero-width space, U+200E/F LRM/RLM, U+202A–202E bidi embeddings and
//   overrides (U+202E can visually reverse a name and the badge beside it),
//   U+2060–2064 word joiner + invisible operators, U+2066–2069 bidi isolates,
//   U+FEFF BOM, and the Hangul / braille fillers used to post a "blank" name.
// ZWJ (U+200D) and ZWNJ (U+200C) are kept: emoji sequences and Persian/Indic
// spelling need them. `nameKey` drops them for comparison instead.
const INVISIBLE =
	"\\u00AD\\u061C\\u115F\\u1160\\u180E\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u2800\\u3164\\uFEFF\\uFFA0";

const STRIP = new RegExp(`[${CONTROL}${INVISIBLE}]`, "g");

// Something a reader can actually see. A name of only ZWJ/ZWNJ or combining
// marks survives STRIP but still renders blank.
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * Strip controls and invisible formatting, fold any whitespace run (tabs, NBSP,
 * ideographic space…) to one ASCII space, and trim. Returns "" when nothing
 * visible is left, so callers treat it exactly like an empty field.
 */
export const sanitizeDisplayName = (raw: string): string => {
	const name = raw.replace(STRIP, "").replace(/\s+/g, " ").trim();
	return VISIBLE.test(name) ? name : "";
};

/**
 * Cut to `max` UTF-16 units without splitting a surrogate pair. For provider
 * names, which arrive at any length and can't be bounced back to the user.
 */
export const truncateName = (name: string, max = MAX_NAME): string => {
	if (name.length <= max) return name;
	let out = "";
	for (const ch of name) {
		if (out.length + ch.length > max) break;
		out += ch;
	}
	return out.trimEnd();
};

/**
 * Comparison key: two names with the same key read as the same name to a
 * person skimming a thread. NFKC folds full-width and styled letters ("ＫｉｎｇＰｉｎ",
 * "𝐊𝐢𝐧𝐠𝐏𝐢𝐧") onto plain ones, then case, whitespace, format characters and the
 * separators people use to make a near-copy ("King.Pin", "king_pin") are dropped.
 *
 * Default-ignorables (ZWJ, variation selectors, U+034F…) go *before* NFKC, or
 * "Jose\u200D\u0301" keeps a loose accent that never composes into "josé";
 * the closing NFKC recomposes what dropping a separator split apart. Only the
 * key loses them — the stored name keeps its emoji presentation and joiners.
 *
 * ponytail: no cross-script confusables (Cyrillic "К" vs Latin "K"). That needs
 * the Unicode confusables table (~100 KB); add it if impersonation via
 * homoglyphs shows up in practice.
 */
export const nameKey = (name: string): string =>
	sanitizeDisplayName(name)
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{Cf}._\-·'’]/gu, "")
		.normalize("NFKC");

/**
 * Whether `name` is on the operator's reserved-names list: one name per line,
 * blank lines and `#` comments skipped, compared by `nameKey` so a respelling
 * of a listed name is caught too. Whole-name match only — reserving "admin"
 * does not refuse "admin fan".
 */
export const isReservedName = (list: string, name: string): boolean => {
	const key = nameKey(name);
	if (!key) return false;
	return list
		.split("\n")
		.some((line) => !line.trim().startsWith("#") && nameKey(line) === key);
};
