/**
 * Opt-in staff marker on POST/PATCH /api/v1/comments, against REAL SQLite.
 *
 * The badge reveals a role, so the claim is checked against the author row and
 * never trusted from the body; an edit can neither add nor strip it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/index";
import { hashIp } from "../src/lib/ip-hash";
import { comments } from "../src/routes/api.comments";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import { makeD1, makeKv } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const SLUG = "staff";
const MOD_ID = "01HU0000000000000000MOD0";
const BANNED_ID = "01HU00000000000000BANNED";
const READER_ID = "01HU00000000000000READER";
const MOD_SID = "a".repeat(64);
const READER_SID = "b".repeat(64);
const BANNED_SID = "c".repeat(64);
const ANON_IP = "203.0.113.7";
const session = (user_id: string) =>
	JSON.stringify({ user_id, expires_at: 4_102_444_800_000 });

let sqlite: DatabaseSync;
let env: Bindings;

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	const user = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'github', ?, ?, 0, ?, 1)`,
	);
	user.run(MOD_ID, "1", "Mod", "mod");
	user.run(READER_ID, "2", "Reader", "user");
	user.run(BANNED_ID, "3", "Banned", "mod");
	sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(BANNED_ID);
	sqlite.prepare("INSERT INTO posts (slug, created_at) VALUES (?, 1)").run(SLUG);
	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeKv([
			[`sess:${MOD_SID}`, session(MOD_ID)],
			[`sess:${READER_SID}`, session(READER_ID)],
			[`sess:${BANNED_SID}`, session(BANNED_ID)],
		]),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		EDIT_WINDOW_MINUTES: "15",
		IP_HASH_SECRET: "test-secret",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (method: string, path: string, sid: string, payload: Record<string, unknown>) =>
	new Hono<{ Bindings: Bindings }>().route("/", comments).request(
		path,
		{
			method,
			headers: { "content-type": "application/json", cookie: `garrul_sess=${sid}` },
			body: JSON.stringify(payload),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);
const post = (sid: string, extra: Record<string, unknown> = {}) =>
	call("POST", "/", sid, { slug: SLUG, body: "hello", ...extra });
const flag = (id: string): number =>
	(sqlite.prepare("SELECT as_staff FROM comments WHERE id = ?").get(id) as { as_staff: number })
		.as_staff;
const count = (): number =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
// No cookie: the anonymous path, from a fixed client IP.
const anonPost = (extra: Record<string, unknown>) =>
	new Hono<{ Bindings: Bindings }>().route("/", comments).request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": ANON_IP },
			body: JSON.stringify({ slug: SLUG, body: "hello", name: "Anon", ...extra }),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);
type Echo = { comment: { id: string; staff?: boolean; author: Record<string, unknown> } };

describe("POST /comments — as_staff", () => {
	it("refuses as_staff from a non-staff session with 403 and writes nothing", async () => {
		const res = await post(READER_SID, { as_staff: true });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Only signed-in staff can mark a comment as staff.",
		});
		expect(count()).toBe(0);
	});

	it("stores and echoes the marker for a mod who opts in", async () => {
		const res = await post(MOD_SID, { as_staff: true });
		expect(res.status).toBe(201);
		const { comment } = (await res.json()) as Echo;
		expect(flag(comment.id)).toBe(1);
		expect(comment.staff).toBe(true);
		expect(comment.author).not.toHaveProperty("role");
	});

	// One case per test: beforeEach resets the Cache API mock, and four posts in
	// one test would trip the write budget.
	it.each([{}, { as_staff: false }, { as_staff: "true" }, { as_staff: 1 }])(
		"leaves it off when absent, false, or not a real boolean: %j",
		async (extra) => {
			const res = await post(MOD_SID, extra);
			expect(res.status).toBe(201);
			const { comment } = (await res.json()) as Echo;
			expect(flag(comment.id)).toBe(0);
			expect(comment).not.toHaveProperty("staff");
		},
	);
});

describe("POST /comments — as_staff needs a session", () => {
	it("refuses an anonymous caller with 403 and writes nothing", async () => {
		const res = await anonPost({ as_staff: true, turnstile_token: "x" });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Only signed-in staff can mark a comment as staff.",
		});
		expect(count()).toBe(0);
	});

	// A ghost is keyed on the IP hash alone. If an admin ever promoted one, every
	// anonymous poster behind that address would otherwise inherit its role.
	it("still refuses when the ghost row for this IP has been promoted", async () => {
		const ipHash = await hashIp(ANON_IP, "test-secret");
		sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
				 VALUES ('01HU0000000000000000GHOST', 'anon', ?, 'Anon', 0, 'mod', 1)`,
			)
			.run(ipHash);
		const res = await anonPost({ as_staff: true, turnstile_token: "x" });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Only signed-in staff can mark a comment as staff.",
		});
		expect(count()).toBe(0);
	});

	it("refuses a banned mod's session and writes nothing", async () => {
		const res = await post(BANNED_SID, { as_staff: true });
		expect(res.status).toBe(403);
		// The ban gate answers first; the staff check never gets a say.
		expect(await res.json()).toEqual({ error: "Your account is banned." });
		expect(count()).toBe(0);
	});
});

describe("PATCH /comments/:id — never changes as_staff", () => {
	it("keeps a staff mark through an edit that says false", async () => {
		const { comment } = (await (await post(MOD_SID, { as_staff: true })).json()) as Echo;
		const res = await call("PATCH", `/${comment.id}`, MOD_SID, { body: "edited", as_staff: false });
		expect(res.status).toBe(200);
		expect(flag(comment.id)).toBe(1);
		expect(((await res.json()) as Echo).comment.staff).toBe(true);
	});

	it("does not add a mark through an edit that says true", async () => {
		const { comment } = (await (await post(MOD_SID)).json()) as Echo;
		const res = await call("PATCH", `/${comment.id}`, MOD_SID, { body: "edited", as_staff: true });
		expect(res.status).toBe(200);
		expect(flag(comment.id)).toBe(0);
	});
});
