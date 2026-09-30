/**
 * Display-name sanitizer and comparison key (src/lib/display-name.ts).
 *
 * The sanitizer is the only thing between a typed or provider-supplied name and
 * every surface that prints it (widget, feed, emails, admin), so it is pinned
 * character by character. The key is what reserved-name matching and per-name
 * ghost identity compare on.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_NAME,
	nameKey,
	sanitizeDisplayName,
	truncateName,
} from "../src/lib/display-name";

const cp = (n: number) => String.fromCodePoint(n);

describe("sanitizeDisplayName", () => {
	it("strips C0/C1 controls", () => {
		expect(sanitizeDisplayName(`Bob${cp(1)}${cp(0x85)}`)).toBe("Bob");
	});

	it("strips bidi overrides, embeddings and isolates", () => {
		for (const n of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f]) {
			expect(sanitizeDisplayName(`Ki${cp(n)}ngPin`)).toBe("KingPin");
		}
	});

	it("strips zero-width and invisible characters", () => {
		for (const n of [0x200b, 0x2060, 0xfeff, 0x00ad, 0x180e]) {
			expect(sanitizeDisplayName(`King${cp(n)}Pin`)).toBe("KingPin");
		}
	});

	it("keeps ZWJ and ZWNJ, which emoji and Persian spelling need", () => {
		const family = "👨‍👩‍👧";
		expect(sanitizeDisplayName(family)).toBe(family);
		expect(sanitizeDisplayName("می‌خواهم")).toBe("می‌خواهم");
	});

	it("refuses a name that renders blank", () => {
		for (const blank of [cp(0x3164), cp(0x2800).repeat(3), "‍‌", `${cp(0x115f)}${cp(0x1160)}`, "   "]) {
			expect(sanitizeDisplayName(blank)).toBe("");
		}
	});

	it("folds whitespace runs to one space and trims", () => {
		expect(sanitizeDisplayName(" Ada\t 　Lovelace ")).toBe("Ada Lovelace");
	});

	it("leaves ordinary names alone", () => {
		for (const n of ["Ada", "José Núñez", "李小龍", "O'Brien", "🦊 fox"]) {
			expect(sanitizeDisplayName(n)).toBe(n);
		}
	});
});

describe("truncateName", () => {
	it("caps at MAX_NAME without splitting a surrogate pair", () => {
		const long = `${"a".repeat(MAX_NAME - 1)}😀`;
		const out = truncateName(long);
		expect(out).toBe("a".repeat(MAX_NAME - 1));
		expect(out.length).toBeLessThanOrEqual(MAX_NAME);
	});

	it("returns a short name unchanged", () => {
		expect(truncateName("Ada")).toBe("Ada");
	});
});

describe("nameKey", () => {
	it("treats look-alike spellings as one name", () => {
		const k = nameKey("KingPin");
		for (const v of ["kingpin", "King Pin", "King.Pin", "king_pin", "KING-PIN", "ＫｉｎｇＰｉｎ", "𝐊𝐢𝐧𝐠𝐏𝐢𝐧", "King‍Pin", "King‮Pin"]) {
			expect(nameKey(v)).toBe(k);
		}
	});

	it("keeps different names different", () => {
		expect(nameKey("KingPin")).not.toBe(nameKey("KingPins"));
	});
});
