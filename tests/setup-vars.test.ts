/**
 * setup.sh runs top to bottom, so it can't be sourced. These tests cut the
 * [vars] helpers out by name (every function in the file closes with `}` at
 * column 0) and run them in bash against a fixture wrangler.toml.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "setup.sh");
const FNS = ["get_var", "set_var", "var_is_placeholder", "prompt_var"];
const EXTRACT = FNS.map((f) => `/^${f}() {/,/^}/p`).join(";");

const EXAMPLE = `[vars]
ALLOWED_ORIGINS = "https://yourblog.example.com"
PUBLIC_BASE_URL = "https://comments.example.com"
OAUTH_CALLBACK_BASE = "https://comments.example.com"
`;

const TOML = `name = "garrul"
[vars]
ENV = "production"
# ALLOWED_ORIGINS = "https://commented.example"
ALLOWED_ORIGINS = "https://yourblog.example.com"
PUBLIC_BASE_URL = 'https://c.blog.test'
OAUTH_CALLBACK_BASE = "https://comments.example.com"

[env.staging.vars]
ALLOWED_ORIGINS = "https://staging.example.com"
`;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "garrul-setup-"));
	writeFileSync(join(dir, "wrangler.toml"), TOML);
	writeFileSync(join(dir, "wrangler.example.toml"), EXAMPLE);
});

const sh = (body: string, input = "") =>
	spawnSync(
		"bash",
		["-c", `set -euo pipefail\neval "$(sed -n '${EXTRACT}' "$SETUP")"\n${body}`],
		{ cwd: dir, input, encoding: "utf8", env: { ...process.env, SETUP } },
	);
const toml = () => readFileSync(join(dir, "wrangler.toml"), "utf8");

describe("setup.sh [vars] helpers", () => {
	it("extracts every helper", () => {
		const r = sh(FNS.map((f) => `declare -F ${f}`).join("\n"));
		expect(r.status, r.stderr).toBe(0);
	});

	it("reads either quote style from the top-level [vars] only", () => {
		const r = sh(
			"get_var ALLOWED_ORIGINS wrangler.toml; get_var PUBLIC_BASE_URL wrangler.toml; get_var MISSING wrangler.toml",
		);
		expect(r.stdout).toBe("https://yourblog.example.com\nhttps://c.blog.test\n");
	});

	it("rewrites one line and leaves the rest byte-identical", () => {
		const r = sh('set_var ALLOWED_ORIGINS "https://blog.test"');
		expect(r.status, r.stderr).toBe(0);
		expect(toml()).toBe(
			TOML.replace(
				'ALLOWED_ORIGINS = "https://yourblog.example.com"',
				'ALLOWED_ORIGINS = "https://blog.test"',
			),
		);
	});

	it("warns and leaves the file alone when the line is missing", () => {
		const r = sh('set_var CANONICAL_URL "https://x.test"');
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("no uncommented CANONICAL_URL");
		expect(toml()).toBe(TOML);
	});

	it("keeps a real value on Enter", () => {
		const r = sh('prompt_var PUBLIC_BASE_URL "hint"', "\n");
		expect(r.stdout).toContain("PUBLIC_BASE_URL unchanged");
		expect(toml()).toBe(TOML);
	});

	it("defaults OAUTH_CALLBACK_BASE to PUBLIC_BASE_URL", () => {
		sh('prompt_var OAUTH_CALLBACK_BASE "hint"', "\n");
		expect(toml()).toContain('OAUTH_CALLBACK_BASE = "https://c.blog.test"');
	});

	it("leaves a placeholder on an empty answer and flags it", () => {
		const r = sh('VARS_PENDING=0; prompt_var ALLOWED_ORIGINS "hint"; echo "pending=$VARS_PENDING"', "\n");
		expect(r.stdout).toContain("pending=1");
		expect(toml()).toBe(TOML);
	});

	it("re-asks on a value a TOML basic string can't hold as-is", () => {
		sh('prompt_var ALLOWED_ORIGINS "hint"', 'a"b\nhttps://ok.test\n');
		expect(toml()).toContain('ALLOWED_ORIGINS = "https://ok.test"');
	});
});

describe("setup.sh end-to-end steps", () => {
	it("migrates, deploys and verifies after the secrets, in that order", () => {
		const s = readFileSync(SETUP, "utf8");
		const at = [
			'echo "=== Production secrets ==="',
			"\tconfigure_vars\n",
			"\tnpm run migrate -- --remote\n",
			"\tdeploy_worker\n",
			"\t\tverify_health\n",
			'echo "=== Next steps ==="',
		].map((needle) => s.indexOf(needle));
		for (const i of at) expect(i).toBeGreaterThan(-1);
		expect(at).toEqual([...at].sort((a, b) => a - b));
	});
});
