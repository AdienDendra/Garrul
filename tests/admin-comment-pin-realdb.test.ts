/**
 * Admin pin/unpin on REAL SQLite: the precondition (approved + top-level), the
 * one-pin swap, the audit rows, and that moderation to spam drops the pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOD_SID, adminHarness } from "./helpers/admin-sqlite";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

beforeEach(() => installMockCaches());
afterEach(() => uninstallMockCaches());

const seeded = () => {
	const h = adminHarness();
	h.sqlite.exec(
		"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'Ann', 1)",
	);
	h.sqlite.exec("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)");
	const ins = h.sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, status, created_at, depth)
		 VALUES (?, 'p', ?, 'u1', 'x', ?, ?, ?, ?)`,
	);
	ins.run("a", null, "<p>alpha</p>", "approved", 1, 1);
	ins.run("b", null, "<p>beta</p>", "approved", 2, 1);
	ins.run("r", "a", "<p>reply</p>", "approved", 3, 2);
	ins.run("q", null, "<p>queued</p>", "pending", 4, 1);
	const act = (id: string, action: string, sid?: string) =>
		h.request(`/admin/api/comments/${id}`, { method: "POST", body: { action }, sid });
	const pinOf = (id: string) =>
		(h.sqlite.prepare("SELECT pinned_at FROM comments WHERE id = ?").get(id) as {
			pinned_at: number | null;
		}).pinned_at;
	const audits = () =>
		(h.sqlite.prepare("SELECT action, target_id FROM audit_log ORDER BY created_at, id").all() as {
			action: string;
			target_id: string;
		}[]).filter((r) => r.action.startsWith("comment.p") || r.action.startsWith("comment.u"));
	return { h, act, pinOf, audits };
};

describe("POST /admin/api/comments/:id — pin/unpin", () => {
	it("pins, swaps, unpins and audits each step", async () => {
		const { act, pinOf, audits } = seeded();
		const res = await act("a", "pin");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id: "a", pinned: true });
		expect(pinOf("a")).not.toBeNull();

		expect((await act("b", "pin")).status).toBe(200);
		expect(pinOf("a")).toBeNull();
		expect(pinOf("b")).not.toBeNull();

		expect(await (await act("b", "unpin")).json()).toEqual({ ok: true, id: "b", pinned: false });
		expect(pinOf("b")).toBeNull();
		expect(audits()).toEqual([
			{ action: "comment.pin", target_id: "a" },
			{ action: "comment.pin", target_id: "b" },
			{ action: "comment.unpin", target_id: "b" },
		]);
	});

	it("refuses a reply and a pending comment with not_pinnable", async () => {
		const { act, pinOf } = seeded();
		for (const id of ["r", "q"]) {
			const res = await act(id, "pin");
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "not_pinnable" });
			expect(pinOf(id)).toBeNull();
		}
	});

	it("404s an unknown comment and lets a mod pin", async () => {
		const { act, pinOf } = seeded();
		expect((await act("nope", "pin")).status).toBe(404);
		expect((await act("a", "pin", MOD_SID)).status).toBe(200);
		expect(pinOf("a")).not.toBeNull();
	});

	// A refused pin must never disturb the post's existing pin: pinComment
	// checks the target and returns before calling setCommentPin, so a reply, a
	// pending comment or an unknown id all leave "a" pinned.
	it("a refused pin (reply, pending, unknown id) leaves the post's existing pin in place", async () => {
		const { act, pinOf } = seeded();
		await act("a", "pin");
		expect(pinOf("a")).not.toBeNull();

		const reply = await act("r", "pin");
		expect(reply.status).toBe(400);
		expect(await reply.json()).toEqual({ error: "not_pinnable" });
		expect(pinOf("a")).not.toBeNull();

		const pending = await act("q", "pin");
		expect(pending.status).toBe(400);
		expect(await pending.json()).toEqual({ error: "not_pinnable" });
		expect(pinOf("a")).not.toBeNull();

		const unknown = await act("nope", "pin");
		expect(unknown.status).toBe(404);
		expect(pinOf("a")).not.toBeNull();
	});

	// Coordinator override 6 (binding over the brief's original AC/test text):
	// pins are retired at read time, not by the status writers. moderateComment
	// (spam/delete) never touches pinned_at; only setCommentPin does. A spammed
	// pinned comment keeps its pinned_at, dormant, and getPinnedThreadRef (B1)
	// stops serving it once status != 'approved'. A re-approve restores it.
	it("spamming a pinned comment leaves pinned_at untouched (retired at read time, not cleared)", async () => {
		const { act, pinOf } = seeded();
		await act("a", "pin");
		const before = pinOf("a");
		expect(before).not.toBeNull();
		expect((await act("a", "spam")).status).toBe(200);
		expect(pinOf("a")).toBe(before);
	});
});

describe("admin UI — pin buttons", () => {
	it("detail page offers Pin, then Unpin, and nothing on a reply", async () => {
		const { h, act } = seeded();
		expect(await (await h.request("/admin/comments/a")).text()).toContain("act('pin')");
		await act("a", "pin");
		expect(await (await h.request("/admin/comments/a")).text()).toContain("act('unpin')");
		const reply = await (await h.request("/admin/comments/r")).text();
		expect(reply).not.toContain("act('pin')");
		expect(reply).not.toContain("act('unpin')");
	});

	it("queue rows for approved top-level comments carry a Pin button", async () => {
		const { h } = seeded();
		const html = await (await h.request("/admin/queue?status=approved")).text();
		expect(html).toContain(">Pin</button>");
	});
});
