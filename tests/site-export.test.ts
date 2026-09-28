/**
 * Site-wide export: what goes in, what never goes in, and how it is encoded.
 *
 * Real SQLite with every migration applied (adminHarness), because the thing
 * worth pinning is the column allowlist against the *actual* schema — a new
 * sensitive column must stay out of the file until someone lists it here.
 */
import { describe, it, expect } from "vitest";
import { adminHarness } from "./helpers/admin-sqlite";
import {
	EXPORT_PAGE_SIZE,
	type ExportCounts,
	csvCell,
	csvRow,
	exportQueryCost,
	exportStream,
	siteExportCsv,
	siteExportJson,
} from "../src/lib/site-export";

const SLUG = "hello";
const T0 = 1_700_000_000_000;

const seed = (n: number) => {
	const h = adminHarness();
	const { sqlite } = h;
	sqlite
		.prepare(`INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)`)
		.run(SLUG, "Hello", "https://example.com/hello", T0);
	const addUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	addUser.run("01HUSER000000000000000000A", "github", "42", "Ada", "ada@example.com", T0);
	addUser.run("01HGHOST00000000000000000G", "anon", "deadbeefiphash", "Ghost", null, T0);
	const addComment = sqlite.prepare(
		`INSERT INTO comments
		   (id, post_slug, user_id, body_md, body_html, status, ip_hash, user_agent,
		    created_at, score_up, score_down)
		 VALUES (?, ?, ?, ?, ?, ?, 'SECRET_HASH', 'SECRET_UA', ?, ?, ?)`,
	);
	sqlite.exec("BEGIN");
	for (let i = 0; i < n; i++) {
		const status = i === 0 ? "spam" : i === 1 ? "deleted" : "approved";
		const body = i === 2 ? `=HYPERLINK("x")` : `body ${i}`;
		addComment.run(
			`01HC${String(i).padStart(22, "0")}`,
			SLUG,
			"01HUSER000000000000000000A",
			body,
			`<p>${body}</p>`,
			status,
			T0 + i,
			1,
			i === 3 ? 5 : 0,
		);
	}
	sqlite.exec("COMMIT");
	const cid = "01HC0000000000000000000000";
	sqlite
		.prepare(`INSERT INTO votes (comment_id, user_id, value, created_at) VALUES (?, ?, 1, ?)`)
		.run(cid, "01HUSER000000000000000000A", T0);
	sqlite
		.prepare(`INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES (?, ?, 'heart', ?)`)
		.run(cid, "01HUSER000000000000000000A", T0);
	const addSub = sqlite.prepare(
		`INSERT INTO subscriptions (id, post_slug, email, token, confirm_token, confirmed_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	addSub.run("s1", SLUG, "yes@example.com", "TOKEN_A", null, T0, T0);
	addSub.run("s2", SLUG, "no@example.com", "TOKEN_B", "CONFIRM_B", null, T0);
	return h;
};

const drain = async (it: AsyncGenerator<string>) => {
	let out = "";
	for await (const chunk of it) out += chunk;
	return out;
};

describe("csvCell / csvRow", () => {
	it("quotes every field and doubles inner quotes", () => {
		expect(csvCell("plain")).toBe(`"plain"`);
		expect(csvCell(`a"b`)).toBe(`"a""b"`);
		expect(csvCell("two\r\nlines")).toBe(`"two\r\nlines"`);
		expect(csvCell(null)).toBe(`""`);
		expect(csvCell(7)).toBe(`"7"`);
	});

	it("prefixes a quote on string cells a spreadsheet would evaluate", () => {
		for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
			expect(csvCell(`${lead}x`)).toBe(`"'${lead}x"`);
		}
	});

	it("leaves negative numbers alone", () => {
		expect(csvCell(-3)).toBe(`"-3"`);
	});

	it("ends a row with CRLF", () => {
		expect(csvRow(["a", 1])).toBe(`"a","1"\r\n`);
	});
});

describe("siteExportJson", () => {
	it("emits the envelope with allowlisted columns only, paging past 500 rows", async () => {
		const n = EXPORT_PAGE_SIZE * 2 + 201;
		const { env } = seed(n);
		let commentPages = 0;
		const db = {
			prepare(sql: string) {
				if (/FROM comments/.test(sql)) commentPages++;
				return env.DB.prepare(sql);
			},
		} as unknown as D1Database;
		const counts: ExportCounts = {};
		const doc = JSON.parse(await drain(siteExportJson(db, counts, T0)));

		expect(doc.site_export_version).toBe(1);
		expect(doc.exported_at).toBe(new Date(T0).toISOString());
		expect(Object.keys(doc.tables)).toEqual([
			"posts", "comments", "users", "votes", "reactions",
			"page_votes", "page_reactions", "subscriptions",
		]);

		const comments = doc.tables.comments as Record<string, unknown>[];
		expect(comments).toHaveLength(n);
		expect(new Set(comments.map((c) => c.id)).size).toBe(n);
		expect(commentPages).toBe(3);
		expect(counts.comments).toBe(n);
		for (const c of comments) {
			expect(c).not.toHaveProperty("ip_hash");
			expect(c).not.toHaveProperty("user_agent");
			expect(c).not.toHaveProperty("body_html");
			expect(c).not.toHaveProperty("_rk");
			expect(c).toHaveProperty("pinned_at");
			expect(c).toHaveProperty("as_staff");
		}
		// A backup keeps moderation decisions.
		expect(comments.map((c) => c.status)).toEqual(
			expect.arrayContaining(["spam", "deleted", "approved"]),
		);

		const raw = JSON.stringify(doc);
		expect(raw).not.toContain("SECRET_HASH");
		expect(raw).not.toContain("SECRET_UA");
		expect(raw).not.toContain("TOKEN_");
		expect(raw).not.toContain("CONFIRM_");
		expect(raw).not.toContain("deadbeefiphash");

		const users = doc.tables.users as Record<string, unknown>[];
		expect(users.find((u) => u.id === "01HUSER000000000000000000A")).toMatchObject({
			email: "ada@example.com",
			provider_id: "42",
		});
		expect(users.find((u) => u.provider === "anon")?.provider_id).toBeNull();

		const subs = doc.tables.subscriptions as Record<string, unknown>[];
		expect(subs.map((s) => s.email)).toEqual(["yes@example.com"]);
		expect(doc.tables.votes).toHaveLength(1);
		expect(doc.tables.reactions).toHaveLength(1);
		expect(counts).toMatchObject({ posts: 1, votes: 1, subscriptions: 1 });
	});
});

describe("exportQueryCost", () => {
	// The route refuses an export against this estimate, so it must never
	// undercount what the pager really issues.
	it.each(["json", "csv"] as const)("%s: matches the pager's real query count", async (format) => {
		const { env } = seed(EXPORT_PAGE_SIZE * 2 + 201);
		let issued = 0;
		const db = {
			prepare(sql: string) {
				issued++;
				return env.DB.prepare(sql);
			},
		} as unknown as D1Database;
		const cost = await exportQueryCost(env.DB, format);
		await drain(format === "json" ? siteExportJson(db, {}) : siteExportCsv(db, {}));
		expect(cost).toBe(issued);
		expect(cost).toBe(format === "json" ? 3 + 7 : 3);
	});
});

describe("siteExportCsv", () => {
	it("writes the comments sheet with ISO dates, net score and the formula guard", async () => {
		const { env } = seed(4);
		const counts: ExportCounts = {};
		const csv = await drain(siteExportCsv(env.DB, counts));
		const lines = csv.split("\r\n");
		expect(lines[0]).toBe(
			`"id","post_slug","parent_id","author_name","status","created_at","score","body_md"`,
		);
		expect(lines).toHaveLength(4 + 2); // header + 4 rows + trailing ""
		expect(lines[1]).toBe(
			`"01HC0000000000000000000000","hello","","Ada","spam","${new Date(T0).toISOString()}","1","body 0"`,
		);
		expect(lines[3]).toContain(`"'=HYPERLINK(""x"")"`);
		expect(lines[4]).toContain(`,"-4",`);
		expect(counts).toEqual({ comments: 4 });
	});
});

describe("exportStream", () => {
	async function* chunks() {
		yield "a";
		yield "b";
	}

	it("closes once with complete=true after the last chunk", async () => {
		const calls: boolean[] = [];
		const body = exportStream(chunks(), async (c) => {
			calls.push(c);
		});
		expect(await new Response(body).text()).toBe("ab");
		expect(calls).toEqual([true]);
	});

	it("reports complete=false when the reader cancels", async () => {
		const calls: boolean[] = [];
		const reader = exportStream(chunks(), async (c) => {
			calls.push(c);
		}).getReader();
		await reader.read();
		await reader.cancel();
		expect(calls).toEqual([false]);
	});

	it("closes once with complete=false and errors the stream when a page read throws", async () => {
		async function* throwing() {
			yield "a";
			throw new Error("page query failed");
		}
		const calls: boolean[] = [];
		const body = exportStream(throwing(), async (c) => {
			calls.push(c);
		});
		await expect(new Response(body).text()).rejects.toThrow();
		expect(calls).toEqual([false]);
	});

	it("still closes with complete=false when the generator's return() throws on cancel", async () => {
		// A hand-rolled AsyncGenerator rather than `try {} finally { throw }` in a
		// generator function body, which biome's noUnsafeFinally rejects.
		const values = ["a", "b"];
		let i = 0;
		const chunksThatRefuseToStop: AsyncGenerator<string> = {
			async next(): Promise<IteratorResult<string>> {
				if (i < values.length) {
					const value = values[i]!;
					i++;
					return { done: false, value };
				}
				return { done: true, value: undefined };
			},
			async return(): Promise<IteratorResult<string>> {
				throw new Error("return() blew up");
			},
			async throw(err) {
				throw err;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
			async [Symbol.asyncDispose]() {
				await this.return(undefined);
			},
		};
		const calls: boolean[] = [];
		const reader = exportStream(chunksThatRefuseToStop, async (c) => {
			calls.push(c);
		}).getReader();
		await reader.read();
		await expect(reader.cancel()).rejects.toThrow();
		expect(calls).toEqual([false]);
	});
});
