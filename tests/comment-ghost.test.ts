/**
 * Per-name comment ghosts and the IP-wide ban (getOrCreateCommentGhost,
 * isIpHashBarred), against real SQLite with every migration applied.
 *
 * One ghost per ip_hash meant everyone behind a shared IP posted under the first
 * name typed there. A ghost per ip_hash + name fixes that, but only stays safe
 * if a ban on any of those ghosts still bars the IP.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	getOrCreateCommentGhost,
	getOrCreateGhost,
	isIpHashBarred,
	isNameClaimed,
	setUserBanned,
	upsertOauthUser,
} from "../src/db/queries";
import { nameKey } from "../src/lib/display-name";
import { makeD1 } from "./helpers/admin-sqlite";

const DIR = join(__dirname, "../src/db/migrations");
const IP = "ab12";
const OTHER_IP = "ab123";

let db: D1Database;
let sqlite: DatabaseSync;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(DIR, f), "utf8"));
	}
	db = makeD1(sqlite);
});

describe("getOrCreateCommentGhost", () => {
	it("gives two names on one IP two ghosts, each keeping its own name", async () => {
		const ada = await getOrCreateCommentGhost(db, IP, "Ada");
		const bob = await getOrCreateCommentGhost(db, IP, "Bob");
		expect(ada.id).not.toBe(bob.id);
		expect(ada.name).toBe("Ada");
		expect(bob.name).toBe("Bob");
		expect((await getOrCreateCommentGhost(db, IP, "Ada")).id).toBe(ada.id);
	});

	it("treats a respelling of the same name as the same ghost", async () => {
		const a = await getOrCreateCommentGhost(db, IP, "Ada Lovelace");
		expect((await getOrCreateCommentGhost(db, IP, "ada lovelace")).id).toBe(a.id);
	});

	it("keeps the same name on another IP separate", async () => {
		const a = await getOrCreateCommentGhost(db, IP, "Ada");
		expect((await getOrCreateCommentGhost(db, OTHER_IP, "Ada")).id).not.toBe(a.id);
	});

	it("adopts a pre-upgrade bare ghost with the same name", async () => {
		const legacy = await getOrCreateGhost(db, IP, "Ada");
		expect((await getOrCreateCommentGhost(db, IP, "ADA")).id).toBe(legacy.id);
		expect((await getOrCreateCommentGhost(db, IP, "Bob")).id).not.toBe(legacy.id);
	});

	it("never adopts the bare vote ghost, whose name is the placeholder 'anon'", async () => {
		const voter = await getOrCreateGhost(db, IP, "anon");
		const c = await getOrCreateCommentGhost(db, IP, "Ada");
		expect(c.id).not.toBe(voter.id);
		expect(c.name).toBe("Ada");
	});
});

describe("isIpHashBarred", () => {
	it("is false for an IP with no banned ghost, or none at all", async () => {
		expect(await isIpHashBarred(db, IP)).toBe(false);
		await getOrCreateCommentGhost(db, IP, "Ada");
		expect(await isIpHashBarred(db, IP)).toBe(false);
	});

	it("bars the whole IP when one per-name ghost is banned", async () => {
		const ada = await getOrCreateCommentGhost(db, IP, "Ada");
		await setUserBanned(db, ada.id, true);
		expect(await isIpHashBarred(db, IP)).toBe(true);
	});

	it("bars the IP when the bare ghost is banned", async () => {
		const bare = await getOrCreateGhost(db, IP, "anon");
		await setUserBanned(db, bare.id, true);
		expect(await isIpHashBarred(db, IP)).toBe(true);
	});

	it("does not leak onto an ip_hash that merely shares a prefix", async () => {
		const other = await getOrCreateCommentGhost(db, OTHER_IP, "Ada");
		await setUserBanned(db, other.id, true);
		expect(await isIpHashBarred(db, IP)).toBe(false);
	});
});

describe("isNameClaimed", () => {
	it("claims a login's name once it has an approved comment, and follows a rename", async () => {
		const u = await upsertOauthUser(db, "github", "7", "𝐀𝐝𝐚", null, null, new Set());
		expect(await isNameClaimed(db, nameKey("ada"))).toBe(false);
		sqlite.exec("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 0)");
		sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, renderer_version, status, created_at, depth)
				 VALUES ('c1', 'p', NULL, ?, 'hi', '<p>hi</p>', 1, 'approved', 0, 1)`,
			)
			.run(u.id);
		expect(await isNameClaimed(db, nameKey("ada"))).toBe(true);
		await upsertOauthUser(db, "github", "7", "Grace", null, null, new Set());
		expect(await isNameClaimed(db, nameKey("ada"))).toBe(false);
		expect(await isNameClaimed(db, nameKey("GRACE"))).toBe(true);
	});

	it("never claims a ghost's name", async () => {
		await getOrCreateCommentGhost(db, IP, "Ada");
		expect(await isNameClaimed(db, nameKey("Ada"))).toBe(false);
	});
});
