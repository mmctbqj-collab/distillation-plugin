/**
 * Vendor the upstream distillation engines into ./engines, adapted for DSH.
 *
 * Why a script and not a copy: the upstream engines were written for the
 * Claude Code / Cherry Studio ecosystem, whose skill root is `~/.claude/skills`.
 * DSH does not read that root, so the files must be rewritten — and every
 * rewrite must be reproducible and auditable when upstream releases a new
 * version. This script is that record: it copies a curated subset, applies a
 * deterministic rewrite table, and writes `UPSTREAM.json` (repo, commit, source
 * directory, per-file SHA-256, and which files were rewritten).
 *
 * Usage:
 *   node build/vendor-engines.mjs                    # vendor from the default source
 *   node build/vendor-engines.mjs --source <dir>     # vendor from another checkout
 *   node build/vendor-engines.mjs --out <dir>        # write elsewhere (verification)
 *   node build/vendor-engines.mjs --check            # verify ./engines matches the record
 *
 * Nothing here needs network access: it reads a local checkout. Point --source
 * at fresh clones of the upstream repositories to pick up a new release, then
 * review the rewrite list this script prints.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
// One hash implementation for the tool and the plugin: the drift check in
// `distill_doctor` must agree with whatever this script recorded.
import { contentHash } from "../core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const argv = process.argv.slice(2);
const flag = (name) => {
	const at = argv.indexOf(name);
	return at === -1 ? undefined : argv[at + 1];
};
const CHECK_ONLY = argv.includes("--check");
const SOURCE_ROOT = flag("--source") ?? process.env.ENGINE_SOURCE ?? "E:\\Skills调度组";
const OUT_ROOT = flag("--out");
const enginesDir = OUT_ROOT === undefined ? join(repoRoot, "engines") : join(OUT_ROOT, "engines");
const noticesPath = OUT_ROOT === undefined ? join(repoRoot, "THIRD_PARTY_LICENSES.md") : join(OUT_ROOT, "THIRD_PARTY_LICENSES.md");

/**
 * The DSH adaptation table. Order matters: the `~/` form must be handled before
 * the bare form, otherwise `~/.claude/skills` becomes `~/.dsh/skills`.
 */
const REWRITES = [
	{ name: "tilde-claude-root", find: /~[\\/]\.claude[\\/]skills/g, replace: "$DSH_HOME/skills" },
	{ name: "absolute-home-claude-root", find: /\/Users\/[^/\s`"']+\/\.claude\/skills/g, replace: "$DSH_HOME/skills" },
	{ name: "relative-claude-root", find: /\.claude[\\/]skills/g, replace: ".dsh/skills" },
	{
		name: "python-home-claude-root",
		find: /Path\.home\(\)\s*\/\s*"\.claude"\s*\/\s*"skills"/g,
		replace: 'Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "skills"'
	},
	{ name: "claude-agents-dir", find: /\.claude[\\/]agents/g, replace: ".dsh/agents" }
];

/**
 * Per-engine curation: what ships, what is deliberately left behind.
 *
 * `engines/skill-orchestrator/` is NOT vendored: it is authored by this project
 * (the routing index is ours), so re-vendoring must never overwrite it.
 */
const ENGINES = [
	{
		id: "nuwa-skill",
		from: "nuwa-skill",
		repo: "https://github.com/alchaincyf/nuwa-skill",
		note: "Person/topic distillation (prompt-only engine).",
		include: ["SKILL.md", "README.md", "LICENSE", "scripts", "references"],
		rewrite: true,
		dropNote: "examples/ (2.0 MB of generated showcase skills), promo/ and cover art (26 MB) left upstream."
	},
	{
		id: "cangjie-skill",
		from: "cangjie-skill",
		repo: "https://github.com/kangarooking/cangjie-skill",
		note: "Book/document → capability bundle → skill pack; the only engine with a real CLI.",
		include: [
			"SKILL.md", "README.md", "README.zh-CN.md", "CHANGELOG.md", "LICENSE",
			"scripts", "schemas", "templates", "methodology", "registry", "extractors", "tests"
		],
		rewrite: true,
		dropNote: "books/ (third-party book digests — not ours to redistribute), dist/ (generated output), assets/, website/, benchmarks/, docs/plans (maintainer plans) left upstream."
	},
	{
		id: "darwin-skill",
		from: "darwin-skill",
		repo: "https://github.com/alchaincyf/darwin-skill",
		note: "Skill evolution / ratchet evaluation (prompt-only engine).",
		include: ["SKILL.md", "README.md", "LICENSE", "scripts", "references", "templates", "test-prompts.json", "docs"],
		rewrite: true,
		dropNote: "assets/ (4.1 MB of screenshots), showcase.html left upstream."
	}
];

/**
 * Files whose upstream text deliberately *documents* hard-coded Claude paths
 * (the anti-pattern catalogue) would lose their meaning if rewritten, but every
 * stale path in an *instruction* is worse than a shifted example. The rule is
 * therefore: rewrite everywhere else, and record every rewritten file in
 * UPSTREAM.json so a reviewer can see exactly what changed.
 */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".DS_Store"]);

/** This file *is* the anti-pattern catalogue, so it ships verbatim. */
const SKIP_REWRITE_FILES = new Set(["darwin-skill/references/runtime-neutrality.md"]);

const TEXT_EXT = new Set([".md", ".markdown", ".template", ".py", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml", ".sh", ".ps1", ".txt", ".tsv", ".html", ".css"]);

const sha256 = (buf) => contentHash(buf);
const isBinary = (buf) => buf.includes(0);
const extOf = (p) => {
	const i = p.lastIndexOf(".");
	return i === -1 ? "" : p.slice(i).toLowerCase();
};

async function copyTree(from, to, list) {
	const info = await stat(from);
	if (info.isFile()) {
		await mkdir(dirname(to), { recursive: true });
		await cp(from, to);
		list.push(to);
		return;
	}
	await mkdir(to, { recursive: true });
	for (const entry of await readdir(from, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name) || entry.name.endsWith(".pyc")) continue;
		await copyTree(join(from, entry.name), join(to, entry.name), list);
	}
}

function upstreamCommit(dir) {
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

async function vendorOne(engine) {
	const source = join(SOURCE_ROOT, engine.from);
	if (!existsSync(source)) throw new Error(`missing upstream checkout: ${source} (pass --source <dir>)`);
	const target = join(enginesDir, engine.id);
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });

	const copied = [];
	for (const rel of engine.include) {
		const from = join(source, rel);
		if (!existsSync(from)) continue;
		await copyTree(from, join(target, rel), copied);
	}

	const files = [];
	let rewritten = 0;
	for (const abs of copied) {
		const rel = relative(target, abs).split(sep).join("/");
		const raw = await readFile(abs);
		const record = { path: rel, bytes: raw.length, sha256: sha256(raw) };
		const rewritable = engine.rewrite && TEXT_EXT.has(extOf(rel)) && !isBinary(raw) && !SKIP_REWRITE_FILES.has(`${engine.id}/${rel}`);
		if (rewritable) {
			let text = raw.toString("utf8");
			const applied = [];
			for (const rule of REWRITES) {
				const matches = text.match(rule.find);
				if (!matches || matches.length === 0) continue;
				text = text.replace(rule.find, rule.replace);
				applied.push(`${rule.name}×${matches.length}`);
			}
			if (applied.length > 0) {
				record.rewritten = applied;
				record.sha256Source = record.sha256;
				const next = Buffer.from(text, "utf8");
				await writeFile(abs, next);
				record.sha256 = sha256(next);
				record.bytes = next.length;
				rewritten++;
			}
		}
		files.push(record);
	}

	const manifest = {
		engine: engine.id,
		upstreamRepo: engine.repo,
		upstreamSourceDir: engine.from,
		upstreamCommit: upstreamCommit(source),
		vendoredAt: new Date().toISOString().slice(0, 10),
		note: engine.note,
		droppedUpstream: engine.dropNote,
		adaptation: {
			hashMode: "lf-normalized",
			table: REWRITES.map((r) => `${r.name}: ${String(r.find)} -> ${r.replace}`),
			rewrittenFiles: files.filter((f) => f.rewritten).map((f) => ({ path: f.path, rewrites: f.rewritten, sha256Source: f.sha256Source })),
			shippedVerbatim: [...SKIP_REWRITE_FILES].filter((k) => k.startsWith(engine.id + "/"))
		},
		files
	};
	await writeFile(join(target, "UPSTREAM.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	return { id: engine.id, files: files.length, rewritten, manifest, target };
}

async function checkOne(engine) {
	const target = join(enginesDir, engine.id);
	const manifestPath = join(target, "UPSTREAM.json");
	if (!existsSync(manifestPath)) return { id: engine.id, ok: false, reason: "no UPSTREAM.json" };
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const drift = [];
	for (const rec of manifest.files) {
		const abs = join(target, rec.path);
		if (!existsSync(abs)) {
			drift.push(`missing: ${rec.path}`);
			continue;
		}
		const buf = await readFile(abs);
		if (sha256(buf) !== rec.sha256) drift.push(`modified: ${rec.path}`);
	}
	return { id: engine.id, ok: drift.length === 0, reason: drift.join("; ") };
}

if (CHECK_ONLY) {
	let bad = 0;
	for (const engine of ENGINES) {
		const result = await checkOne(engine);
		console.log(`${result.ok ? "ok  " : "DRIFT"}  ${engine.id}${result.reason ? " — " + result.reason : ""}`);
		if (!result.ok) bad++;
	}
	process.exit(bad === 0 ? 0 : 1);
}

const results = [];
for (const engine of ENGINES) results.push(await vendorOne(engine));

/** The marker core.mjs uses to recognise the bundled engines directory. */
await writeFile(
	join(enginesDir, ".dsh-engines.json"),
	JSON.stringify(
		{
			schema: "dsh-distillation/engines/v1",
			vendoredAt: new Date().toISOString().slice(0, 10),
			engines: results.map((r) => ({ id: r.id, commit: r.manifest.upstreamCommit, repo: r.manifest.upstreamRepo }))
		},
		null,
		2
	) + "\n",
	"utf8"
);

/**
 * Assemble the third-party notice file from the licenses actually vendored.
 *
 * Generated rather than hand-written so it can never drift from what ships: it
 * names each upstream repo, the pinned commit, and reproduces the upstream
 * license text verbatim. MIT is one-way compatible with our GPL-3.0-or-later
 * project — the MIT notice must survive the combination, and this file is it.
 */
const notices = [];
for (const result of results) {
	const licensePath = join(result.target, "LICENSE");
	const text = existsSync(licensePath) ? (await readFile(licensePath, "utf8")).trim() : "(upstream shipped no LICENSE file)";
	notices.push({
		id: result.id,
		repo: result.manifest.upstreamRepo,
		commit: result.manifest.upstreamCommit,
		license: text.split("\n")[0],
		text
	});
}
await writeFile(
	noticesPath,
	[
		"# 第三方组件许可声明（THIRD_PARTY_LICENSES）",
		"",
		"本插件 **dsh-distillation** 以 **GPL-3.0-or-later** 发布（见 [LICENSE](./LICENSE)）。",
		"",
		"下列组件随包分发，**各自保留其上游许可证**。上游均为 MIT；MIT 与 GPLv3 单向兼容——MIT 代码可以并入",
		"GPL 作品再分发，但必须保留原作者的版权与许可声明，本文件即该声明。",
		"",
		"本文件由 `build/vendor-engines.mjs` 生成，请勿手工编辑。",
		"",
		...notices.flatMap((notice) => [
			`## ${notice.id}`,
			"",
			`- 上游仓库：${notice.repo}`,
			`- 内置提交：\`${notice.commit}\``,
			`- 许可证：${notice.license}`,
			`- 内置位置：\`engines/${notice.id}/\`（含上游 LICENSE 原文与 UPSTREAM.json 改写记录）`,
			"",
			"```",
			notice.text,
			"```",
			""
		]),
		"## engines/skill-orchestrator 与 engines/skill-distillation",
		"",
		"这两个目录由本项目自行编写（非第三方），随本插件按 **GPL-3.0-or-later** 授权。",
		""
	].join("\n"),
	"utf8"
);

let bytes = 0;
const walk = async (dir) => {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) await walk(abs);
		else bytes += (await stat(abs)).size;
	}
};
await walk(enginesDir);

console.log("== vendored engines ==");
for (const r of results) {
	console.log(`  ${r.id.padEnd(20)} files=${String(r.files).padStart(4)}  rewritten=${String(r.rewritten).padStart(3)}  commit=${(r.manifest.upstreamCommit ?? "unknown").slice(0, 10)}`);
}
console.log(`  total ${(bytes / 1024 / 1024).toFixed(2)} MB in ${enginesDir}`);
