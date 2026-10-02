import { describe, expect, it } from "vitest";
import { pageTheme } from "../src/widget/theme";

describe("widget host-page theme", () => {
	it("reads PaperMod's data-theme value", () => {
		expect(pageTheme("dark", false)).toBe("dark");
		expect(pageTheme("light", true)).toBe("light");
	});

	it("supports sites that put a dark class on body", () => {
		expect(pageTheme(undefined, true)).toBe("dark");
	});

	it("leaves unknown or absent themes to prefers-color-scheme", () => {
		expect(pageTheme(undefined, false)).toBeNull();
		expect(pageTheme("auto", false)).toBeNull();
	});
});
