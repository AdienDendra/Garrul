/**
 * Migration 0028 backfills users.name_key for signed-in accounts only, with an
 * ASCII approximation of nameKey that the next login replaces.
 */
import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIR = join(__dirname, "../src/db/migrations");

it("keys OAuth names, and leaves ghosts and erased accounts unkeyed", () => {
	const db = new DatabaseSync(":memory:");
	const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
	for (const f of files.filter((f) => f < "0028")) db.exec(readFileSync(join(DIR, f), "utf8"));

	const add = db.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, avatar_url, is_admin, is_banned, created_at, erased_at)
		 VALUES (?, ?, ?, ?, NULL, NULL, 0, 0, 0, ?)`,
	);
	add.run("a", "github", "1", "Ada Love-lace_Jr.", null);
	add.run("b", "anon", "h", "Ada", null);
	add.run("c", "google", "2", "[deleted]", 1);

	for (const f of files.filter((f) => f.startsWith("0028"))) db.exec(readFileSync(join(DIR, f), "utf8"));

	const keys = Object.fromEntries(
		(db.prepare("SELECT id, name_key FROM users ORDER BY id").all() as { id: string; name_key: string | null }[]).map((r) => [
			r.id,
			r.name_key,
		]),
	);
	expect(keys).toEqual({ a: "adalovelacejr", b: null, c: null });
});
