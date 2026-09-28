/**
 * Site-wide export: every table an operator needs to rebuild the comment
 * layer elsewhere, streamed so a large instance never builds the file in
 * memory. Admin-only; see GET /admin/api/export in routes/admin.ts.
 *
 * Columns are an explicit allowlist per table, never `SELECT *`: a future
 * migration that adds a sensitive column must stay out of this file until
 * someone lists it here on purpose. Deliberately absent: `comments.ip_hash`,
 * `comments.user_agent`, `subscriptions.token` / `confirm_token`, and the
 * ip-hash-derived `users.provider_id` of anonymous ghost rows. Whole tables
 * absent: sessions (KV), audit log, spam verdicts, settings, webhooks,
 * telegram links, saved replies, moderator notes, reports.
 *
 * Paging is keyset on `rowid` (no table here is WITHOUT ROWID), so one pager
 * serves text and composite primary keys alike. Pages are separate reads, so
 * the file is not a point-in-time snapshot — `npm run db:export` is.
 */
import { log } from "./log";

export const SITE_EXPORT_VERSION = 1;
export const EXPORT_PAGE_SIZE = 500;

/** Rows emitted per table. Mutated as pages stream, so a cancelled export can still report what left. */
export type ExportCounts = Record<string, number>;

type Row = Record<string, unknown> & { _rk: number };

// Each query binds (cursor, limit). Order is the order of `tables` in the envelope.
const JSON_TABLES: ReadonlyArray<readonly [string, string]> = [
	[
		"posts",
		`SELECT rowid AS _rk, slug, title, url, created_at, closed, published_at
		   FROM posts WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"comments",
		// Every status: this is a backup, and a moderation decision is data.
		`SELECT rowid AS _rk, id, post_slug, parent_id, user_id, body_md, status,
		        created_at, edited_at, deleted_at, deleted_by, score_up, score_down,
		        depth, pinned_at, as_staff, import_source, import_id
		   FROM comments WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"users",
		// An anon ghost's provider_id IS its hashed IP — null it, or the
		// ip_hash exclusion above is undone under another column name.
		`SELECT rowid AS _rk, id, provider,
		        CASE WHEN provider = 'anon' THEN NULL ELSE provider_id END AS provider_id,
		        name, email, avatar_url, role, is_admin, is_banned, created_at,
		        import_source, erased_at
		   FROM users WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"votes",
		`SELECT rowid AS _rk, comment_id, user_id, value, created_at
		   FROM votes WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"reactions",
		`SELECT rowid AS _rk, comment_id, user_id, kind, created_at
		   FROM reactions WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"page_votes",
		`SELECT rowid AS _rk, post_slug, user_id, value, created_at
		   FROM page_votes WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"page_reactions",
		`SELECT rowid AS _rk, post_slug, user_id, kind, created_at
		   FROM page_reactions WHERE rowid > ? ORDER BY rowid LIMIT ?`,
	],
	[
		"subscriptions",
		// Confirmed only; the capability tokens never leave the database.
		`SELECT rowid AS _rk, id, post_slug, email, locale, created_at,
		        confirmed_at, unsubscribed_at, last_notified_at
		   FROM subscriptions
		  WHERE rowid > ? AND confirmed_at IS NOT NULL
		  ORDER BY rowid LIMIT ?`,
	],
];

export const CSV_COLUMNS = [
	"id",
	"post_slug",
	"parent_id",
	"author_name",
	"status",
	"created_at",
	"score",
	"body_md",
] as const;

const CSV_SQL = `SELECT c.rowid AS _rk, c.id, c.post_slug, c.parent_id,
                        u.name AS author_name, c.status, c.created_at,
                        c.score_up - c.score_down AS score, c.body_md
                   FROM comments c LEFT JOIN users u ON u.id = c.user_id
                  WHERE c.rowid > ? ORDER BY c.rowid LIMIT ?`;

async function* pages(
	db: D1Database,
	sql: string,
): AsyncGenerator<Record<string, unknown>[]> {
	let cursor = 0;
	for (;;) {
		const { results } = await db
			.prepare(sql)
			.bind(cursor, EXPORT_PAGE_SIZE)
			.all<Row>();
		const rows = results ?? [];
		const last = rows[rows.length - 1];
		if (!last) return;
		cursor = last._rk;
		yield rows.map(({ _rk, ...rest }) => rest);
		if (rows.length < EXPORT_PAGE_SIZE) return;
	}
}

export async function* siteExportJson(
	db: D1Database,
	counts: ExportCounts,
	now: number = Date.now(),
): AsyncGenerator<string> {
	yield `{"site_export_version":${SITE_EXPORT_VERSION},"exported_at":${JSON.stringify(new Date(now).toISOString())},"tables":{`;
	for (const [i, [name, sql]] of JSON_TABLES.entries()) {
		yield `${i === 0 ? "" : ","}${JSON.stringify(name)}:[`;
		counts[name] = 0;
		for await (const rows of pages(db, sql)) {
			const lead = counts[name] === 0 ? "" : ",";
			counts[name] += rows.length;
			yield lead + rows.map((r) => JSON.stringify(r)).join(",");
		}
		yield "]";
	}
	yield "}}\n";
}

// A spreadsheet evaluates a cell that opens with one of these as a formula
// (OWASP "CSV injection"). Strings only — `score` is legitimately negative.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** RFC 4180 field: always quoted, inner quotes doubled. */
export const csvCell = (v: unknown): string => {
	if (v === null || v === undefined) return `""`;
	let s = String(v);
	if (typeof v === "string" && FORMULA_LEAD.test(s)) s = `'${s}`;
	return `"${s.replace(/"/g, `""`)}"`;
};

export const csvRow = (cells: readonly unknown[]): string =>
	`${cells.map(csvCell).join(",")}\r\n`;

export async function* siteExportCsv(
	db: D1Database,
	counts: ExportCounts,
): AsyncGenerator<string> {
	yield csvRow(CSV_COLUMNS);
	counts.comments = 0;
	for await (const rows of pages(db, CSV_SQL)) {
		counts.comments += rows.length;
		yield rows
			.map((r) =>
				csvRow(
					CSV_COLUMNS.map((k) =>
						k === "created_at"
							? new Date(r.created_at as number).toISOString()
							: r[k],
					),
				),
			)
			.join("");
	}
}

/**
 * Pull-driven byte stream over a chunk generator. `onClose` runs exactly
 * once: `true` after the last chunk, `false` if the reader cancels or a page
 * read throws — so a download dropped at 99% is still on record.
 */
export const exportStream = (
	chunks: AsyncGenerator<string>,
	onClose: (complete: boolean) => Promise<void>,
): ReadableStream<Uint8Array> => {
	const encoder = new TextEncoder();
	let closed = false;
	const close = async (complete: boolean) => {
		if (closed) return;
		closed = true;
		await onClose(complete);
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await chunks.next();
				if (done) {
					await close(true);
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(value));
			} catch (err) {
				log.error("site_export.failed", {
					error: err instanceof Error ? err.message : "unknown",
				});
				await close(false).catch(() => {});
				controller.error(err);
			}
		},
		async cancel() {
			await chunks.return(undefined);
			await close(false);
		},
	});
};
