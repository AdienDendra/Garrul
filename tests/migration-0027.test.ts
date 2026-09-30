/**
 * Migration 0027 clears display names that the old OAuth fallback set to the
 * account's email address — and only those.
 */
import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIR = join(__dirname, "../src/db/migrations");

it("renames email-shaped Google/Facebook names to 'user' and leaves the rest", () => {
	const db = new DatabaseSync(":memory:");
	const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
	for (const f of files.filter((f) => f < "0027")) db.exec(readFileSync(join(DIR, f), "utf8"));

	const add = db.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, avatar_url, is_admin, is_banned, created_at)
		 VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0)`,
	);
	add.run("a", "google", "1", "a@example.com", "a@example.com");
	add.run("b", "google", "2", "b@example.com", null); // unverified: never stored
	add.run("c", "facebook", "3", "c@example.com", "c@example.com");
	add.run("d", "google", "4", "Dee", "d@example.com");
	add.run("e", "github", "5", "e@example.com", "e@example.com"); // a login, not the fallback
	add.run("f", "anon", "h", "me@home", null);

	for (const f of files.filter((f) => f.startsWith("0027"))) db.exec(readFileSync(join(DIR, f), "utf8"));

	const names = Object.fromEntries(
		(db.prepare("SELECT id, name FROM users ORDER BY id").all() as { id: string; name: string }[]).map((r) => [r.id, r.name]),
	);
	expect(names).toEqual({ a: "user", b: "user", c: "user", d: "Dee", e: "e@example.com", f: "me@home" });
});
