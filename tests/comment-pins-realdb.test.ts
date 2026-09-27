/**
 * Pinned comments (migration 0025) on REAL SQLite: the partial UNIQUE index is
 * the one-pin-per-post invariant, so it has to be exercised by an engine that
 * enforces it — a substring-routing stub never would. Also pins the read-time
 * filter: a pinned row that is not approved is not served as the pin, and a
 * re-approve serves it again (no writer outside setCommentPin clears it).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	getPinnedThreadRef,
	listThreadRefsForPost,
	setCommentPin,
	updateCommentStatus,
} from "../src/db/queries";
import { makeD1 } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

let sqlite: DatabaseSync;
let db: D1Database;

const pinOf = (id: string) =>
	(sqlite.prepare("SELECT pinned_at FROM comments WHERE id = ?").get(id) as {
		pinned_at: number | null;
	}).pinned_at;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	db = makeD1(sqlite) as D1Database;
	sqlite.exec(
		"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'u1', 1)",
	);
	sqlite.exec(
		"INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1), ('q', 'Q', NULL, 1)",
	);
	const ins = sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, status, created_at, depth)
		 VALUES (?, ?, ?, 'u1', 'x', '<p>x</p>', 'approved', ?, ?)`,
	);
	ins.run("a", "p", null, 1, 1);
	ins.run("b", "p", null, 2, 1);
	ins.run("r", "p", "a", 3, 2);
	ins.run("z", "q", null, 4, 1);
});

describe("migration 0025 — comments.pinned_at", () => {
	it("allows one pin per post and rejects a second", () => {
		sqlite.exec("UPDATE comments SET pinned_at = 1 WHERE id = 'a'");
		sqlite.exec("UPDATE comments SET pinned_at = 1 WHERE id = 'z'");
		expect(() => sqlite.exec("UPDATE comments SET pinned_at = 2 WHERE id = 'b'")).toThrow(
			/UNIQUE/,
		);
	});
});

describe("getPinnedThreadRef", () => {
	it("looks the pin up through comments_pinned_idx", () => {
		const plan = sqlite
			.prepare(
				`EXPLAIN QUERY PLAN SELECT id, (score_up - score_down) AS score, created_at
				   FROM comments
				  WHERE post_slug = ? AND pinned_at IS NOT NULL
				    AND parent_id IS NULL AND +status = 'approved'`,
			)
			.all("p") as { detail: string }[];
		expect(plan.map((r) => r.detail).join("\n")).toMatch(/comments_pinned_idx/);
	});
});

describe("setCommentPin", () => {
	it("swaps the post's pin in one batch, clearing the old one first", async () => {
		await setCommentPin(db, { id: "a", post_slug: "p" }, true);
		await setCommentPin(db, { id: "b", post_slug: "p" }, true);
		expect(pinOf("a")).toBeNull();
		expect(pinOf("b")).not.toBeNull();
		expect(await getPinnedThreadRef(db, "p")).toMatchObject({ id: "b", created_at: 2 });
	});

	it("never pins a reply, even when the caller skipped the check", async () => {
		await setCommentPin(db, { id: "r", post_slug: "p" }, true);
		expect(pinOf("r")).toBeNull();
	});

	it("unpins", async () => {
		await setCommentPin(db, { id: "a", post_slug: "p" }, true);
		await setCommentPin(db, { id: "a", post_slug: "p" }, false);
		expect(pinOf("a")).toBeNull();
		expect(await getPinnedThreadRef(db, "p")).toBeNull();
	});
});

describe("the pin is filtered at read time", () => {
	beforeEach(() => sqlite.exec("UPDATE comments SET pinned_at = 1 WHERE id = 'a'"));

	it("a spammed pin is not served, and a re-approve serves it again", async () => {
		await updateCommentStatus(db, "a", "spam");
		expect(pinOf("a")).not.toBeNull();
		expect(await getPinnedThreadRef(db, "p")).toBeNull();
		await updateCommentStatus(db, "a", "approved");
		expect(await getPinnedThreadRef(db, "p")).toMatchObject({ id: "a" });
	});

	it("a deleted pinned thread pages like any other thread", async () => {
		sqlite.exec("UPDATE comments SET status = 'deleted', deleted_at = 5 WHERE id = 'a'");
		expect(await getPinnedThreadRef(db, "p")).toBeNull();
		// Replies keep the tombstone visible, so the thread must still page.
		const refs = await listThreadRefsForPost(db, "p", { sort: "new", limit: 10 });
		expect(refs.map((r) => r.id)).toContain("a");
	});

	it("an approved pin is excluded from the paged refs", async () => {
		const refs = await listThreadRefsForPost(db, "p", { sort: "new", limit: 10 });
		expect(refs.map((r) => r.id)).not.toContain("a");
	});

	it("pinning another comment clears a dormant pin", async () => {
		sqlite.exec("UPDATE comments SET status = 'spam' WHERE id = 'a'");
		await setCommentPin(db, { id: "b", post_slug: "p" }, true);
		expect(pinOf("a")).toBeNull();
		expect(pinOf("b")).not.toBeNull();
	});
});
