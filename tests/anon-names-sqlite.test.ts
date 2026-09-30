/**
 * Per-name anonymous ghosts against real SQLite, every migration applied: the
 * paths where the ghost a comment is attributed to and the identity a vote or
 * a ban check resolves must agree, which the in-memory stubs can't show.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateCommentGhost, setUserBanned } from "../src/db/queries";
import { hashIp } from "../src/lib/ip-hash";
import { comments } from "../src/routes/api.comments";
import { votes } from "../src/routes/api.votes";
import { makeD1, makeKv } from "./helpers/admin-sqlite";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const database = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	sqlite.exec("INSERT INTO posts (slug, title, created_at) VALUES ('p', 'P', 0)");
	const db = makeD1(sqlite);
	const env = {
		DB: db,
		TREE_CACHE: makeKv(),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
		TURNSTILE_SECRET: "test-secret",
	};
	const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
	const call = (route: Hono<any>, body: unknown, ip = IP) =>
		new Hono().route("/", route).request(
			"/",
			{
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": ip },
				body: JSON.stringify(body),
			},
			env,
			ctx,
		);
	const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
	return { sqlite, db, call, count };
};

const IP = "192.0.2.1";
const post = (name: string) => ({ slug: "p", name, body: "test comment", turnstile_token: "test-token" });

beforeEach(() => {
	installMockCaches();
	vi.stubGlobal("fetch", async () => Response.json({ success: true, hostname: "example.com" }));
});
afterEach(() => {
	uninstallMockCaches();
	vi.unstubAllGlobals();
});

describe("anonymous self-vote", () => {
	// Posts through the real route, then approves by hand (the first-comment
	// hold may park it) so the vote reaches the self-vote guard.
	const postApproved = async (h: ReturnType<typeof database>, name: string) => {
		const res = await h.call(comments, post(name));
		expect(res.status).toBe(201);
		h.sqlite.exec("UPDATE comments SET status = 'approved'");
		return (h.sqlite.prepare("SELECT id FROM comments").get() as { id: string }).id;
	};

	it("refuses a vote from the IP that posted under a per-name ghost", async () => {
		const h = database();
		const id = await postApproved(h, "Example Author");
		const res = await h.call(votes, { comment_id: id, value: 1 });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "vote_self_forbidden" });
	});

	it("refuses it for a legacy author whose bare ghost was adopted", async () => {
		const h = database();
		h.sqlite
			.prepare("INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('legacy', 'anon', ?, 'Example Author', 0)")
			.run(await hashIp(IP, "test-secret"));
		const id = await postApproved(h, "Example Author");
		expect((h.sqlite.prepare("SELECT user_id FROM comments").get() as { user_id: string }).user_id).toBe("legacy");
		expect((await h.call(votes, { comment_id: id, value: 1 })).status).toBe(403);
	});

	it("still counts a vote from another IP", async () => {
		const h = database();
		const id = await postApproved(h, "Example Author");
		const res = await h.call(votes, { comment_id: id, value: 1 }, "192.0.2.2");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ score_up: 1 });
	});
});

describe("anonymous POST from a banned IP", () => {
	it("is refused before a new-name ghost row is written", async () => {
		const { db, call, count } = database();
		const ghost = await getOrCreateCommentGhost(db, await hashIp(IP, "test-secret"), "Example Author");
		await setUserBanned(db, ghost.id, true);
		const before = count("SELECT count(*) AS n FROM users");
		const res = await call(comments, post("Example Changed"));
		expect(res.status).toBe(403);
		expect(count("SELECT count(*) AS n FROM users")).toBe(before);
	});
});

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
