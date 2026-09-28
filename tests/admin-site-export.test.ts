/**
 * GET /admin/api/export — the route around lib/site-export: who may call it,
 * the response headers, and the audit row written when the stream closes.
 * Contents are pinned in tests/site-export.test.ts.
 */
import { describe, it, expect } from "vitest";
import { MOD_SID, adminHarness } from "./helpers/admin-sqlite";

const auditRows = (sqlite: ReturnType<typeof adminHarness>["sqlite"]) =>
	sqlite
		.prepare(
			`SELECT action, target_kind, meta FROM audit_log WHERE action = 'site.export'`,
		)
		.all() as { action: string; target_kind: string; meta: string }[];

const seedOne = (sqlite: ReturnType<typeof adminHarness>["sqlite"]) => {
	sqlite
		.prepare(`INSERT INTO posts (slug, created_at) VALUES ('p', 1)`)
		.run();
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, created_at)
			 VALUES ('01HC00000000000000000000C1', 'p', '01HADMIN0000000000000000AB',
			         'private words', '<p>private words</p>', 1)`,
		)
		.run();
};

describe("GET /admin/api/export", () => {
	it("streams JSON with download headers and audits counts on close", async () => {
		const { sqlite, request } = adminHarness();
		seedOne(sqlite);
		const res = await request("/admin/api/export?format=json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename="garrul-export-\d{4}-\d{2}-\d{2}\.json"$/,
		);
		const doc = JSON.parse(await res.text());
		expect(doc.site_export_version).toBe(1);
		expect(doc.tables.comments).toHaveLength(1);

		const rows = auditRows(sqlite);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target_kind).toBe("system");
		const meta = JSON.parse(rows[0]?.meta ?? "null");
		expect(meta).toEqual({
			format: "json",
			complete: true,
			counts: {
				posts: 1,
				comments: 1,
				users: 2,
				votes: 0,
				reactions: 0,
				page_votes: 0,
				page_reactions: 0,
				subscriptions: 0,
			},
		});
		expect(rows[0]?.meta).not.toContain("private words");
	});

	it("defaults to JSON when format is omitted", async () => {
		const { request } = adminHarness();
		const res = await request("/admin/api/export");
		expect(res.headers.get("content-disposition")).toMatch(/\.json"$/);
		await res.text();
	});

	it("serves CSV of comments", async () => {
		const { sqlite, request } = adminHarness();
		seedOne(sqlite);
		const res = await request("/admin/api/export?format=csv");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
		expect(res.headers.get("content-disposition")).toMatch(/\.csv"$/);
		const csv = await res.text();
		expect(csv.split("\r\n")).toHaveLength(3);
		expect(JSON.parse(auditRows(sqlite)[0]?.meta ?? "null")).toEqual({
			format: "csv",
			complete: true,
			counts: { comments: 1 },
		});
	});

	it("rejects an unknown format", async () => {
		const { request } = adminHarness();
		const res = await request("/admin/api/export?format=xml");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_format" });
	});

	it.each(["json", "csv"])(
		"%s: refuses up front when paging would exceed the D1 query budget",
		async (format) => {
			const { sqlite, request } = adminHarness();
			seedOne(sqlite);
			// The estimate reads MAX(rowid), so one high rowid stands in for
			// ~25k comments: 51 pages on its own, past the 50-per-invocation cap.
			sqlite.prepare("UPDATE comments SET rowid = 25000").run();
			const res = await request(`/admin/api/export?format=${format}`);
			expect(res.status).toBe(413);
			expect(await res.json()).toMatchObject({ error: "export_too_large" });
			expect(res.headers.get("content-disposition")).toBeNull();
			expect(auditRows(sqlite)).toHaveLength(0);
		},
	);

	it("is admin-only: a mod gets 403 and nothing is audited", async () => {
		const { sqlite, request } = adminHarness();
		const res = await request("/admin/api/export", { sid: MOD_SID });
		expect(res.status).toBe(403);
		expect(auditRows(sqlite)).toHaveLength(0);
	});

	it("refuses a cross-site request before touching the database", async () => {
		const { sqlite, request } = adminHarness();
		const res = await request("/admin/api/export", {
			headers: { "sec-fetch-site": "cross-site" },
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "cross_site_forbidden" });
		expect(auditRows(sqlite)).toHaveLength(0);
	});
});
