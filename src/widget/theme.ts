export type WidgetTheme = "light" | "dark";

/**
 * Resolve the host page's theme without consulting the reader's OS.
 *
 * The widget's CSS already handles prefers-color-scheme. This resolver is for
 * sites such as PaperMod that keep their own light/dark choice on <html>; that
 * choice can intentionally differ from the OS and cannot cross a Shadow DOM
 * boundary on its own.
 */
export const pageTheme = (
	documentTheme: string | undefined,
	bodyHasDarkClass: boolean,
): WidgetTheme | null => {
	if (documentTheme === "light" || documentTheme === "dark") {
		return documentTheme;
	}
	return bodyHasDarkClass ? "dark" : null;
};
