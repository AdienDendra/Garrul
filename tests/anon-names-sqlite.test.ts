/**
 * Per-name anonymous ghosts against real SQLite, every migration applied: the
 * paths where the ghost a comment is attributed to and the identity a vote or
 * a ban check resolves must agree, which the in-memory stubs can't show.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getOrCreateCommentGhost } from "../src/db/queries";
import { makeD1 } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const database = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	return { sqlite, db: makeD1(sqlite) };
};

describe("getOrCreateCommentGhost", () => {
	it("returns the winner's row to both of two concurrent first posts", async () => {
		const { sqlite, db } = database();
		const [a, b] = await Promise.all([
			getOrCreateCommentGhost(db, "iphash-race", "Example Race"),
			getOrCreateCommentGhost(db, "iphash-race", "Example Race"),
		]);
		expect(a.id).toBe(b.id);
		const n = sqlite.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
		expect(n.n).toBe(1);
	});
});
