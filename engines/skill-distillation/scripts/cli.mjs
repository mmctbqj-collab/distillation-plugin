#!/usr/bin/env node
/**
 * dsh-distillation CLI — the same engine as the DSH host plugin, callable
 * directly from a shell / skill without restarting DSH.
 *
 *   node scripts/cli.mjs comfy  <workflow.json> [--out f.md] [--title T] [--print]
 *   node scripts/cli.mjs source <url|file>...  --out f.md  [--title T] [--print]
 *   node scripts/cli.mjs skill  --name kebab --description D [--body-file F]
 *                           [--when-to-use T] [--target user|project]
 *                           [--extra rel/path=localfile]...  [--print]
 *   node scripts/cli.mjs list   [--cwd DIR] [--json] [--generated]
 *   node scripts/cli.mjs route  --request "..." [--cwd DIR] [--json]
 *   node scripts/cli.mjs cangjie --bundle <verified dir> [--variant single|pack|auto]
 *                            [--purpose learning|reference|workflow|distribution]
 *                            [--out DIR] [--target user|project] [--no-install] [--overwrite]
 *   node scripts/cli.mjs evolve --skill <id|dir> (--from doc.md | --text md) [--slug S] [--dry-run]
 *   node scripts/cli.mjs engines list | export --target user|project [--overwrite] [--json]
 *   node scripts/cli.mjs doctor [--cwd DIR] [--json]
 *
 * Exit codes: 0 ok, 1 usage error, 2 runtime error.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	analyzeComfyWorkflow,
	artifactIndexPath,
	ARTIFACT_SIDECAR,
	buildSkillMarkdown,
	enhanceSkill,
	evolveSkill,
	finalizeEvolution,
	ingestSource,
	inspectRoots,
	installCompiledSkills,
	isComfyWorkflow,
	listGeneratedSkills,
	recordArtifact,
	renderComfyMd,
	renderSourcesMd,
	resolveCangjieCli,
	resolveSkillDir,
	resolveSkillRoot,
	routeRequest,
	runCangjieCompile,
	analyzeRepository,
	renderRepoMd,
	planDocsPages,
	filterDocPages,
	distillDocs,
	writeSkillBundle,
	bundledEnginesDir,
	exportBundledEngines,
	listBundledEngines,
	runDoctor,
	writeDoctorReport
} from "./core.mjs";

const DEFAULT_CONFIG = {
	maxSourceBytes: 4_000_000,
	userAgent: "dsh-distillation/0.1 (+dsh skill cli)",
	extraSkillDirs: []
};

function fail(code, message) {
	process.stderr.write(message + "\n");
	process.exit(code);
}

/**
 * Runner for the shared cangjie pipeline: `{ command, args, cwd, timeoutMs }` → exit facts.
 * The host plugin passes the same contract but executes through `ctx.subprocess`.
 */
function execFileRunner({ command, args, cwd, timeoutMs }) {
	return new Promise((settle) => {
		execFile(
			command,
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
			(error, stdout, stderr) => {
				const timedOut = Boolean(error && (error.killed === true || typeof error.signal === "string"));
				settle({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					signal: error?.signal ?? null,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					timedOut
				});
			}
		);
	});
}

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
			if (key === "print" || key === "json" || key === "dry-run" || key === "generated" || key === "no-install" || key === "overwrite" || key === "git-init" || key === "finalize" || key === "list" || key === "per-page") { flags[key] = true; continue; }
			if (key === "extra") {
				const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
				(flags.extra ??= []).push(val);
				continue;
			}
			const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
			if (val === undefined) fail(1, `missing value for --${key}`);
			// A value that looks like the next flag means the value was never typed;
			// swallowing it would silently shift every later argument.
			if (eq === -1 && typeof val === "string" && val.startsWith("--")) fail(1, `missing value for --${key} (found "${val}")`);
			flags[key] = val;
		} else {
			positional.push(a);
		}
	}
	return { flags, positional };
}

async function emit(md, out, print) {
	if (print) process.stdout.write(md.endsWith("\n") ? md : md + "\n");
	if (out) {
		const abs = resolve(out);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, md, "utf8");
	}
	return md;
}

function report(out, md, extra = "") {
	const target = out ? resolve(out) : "(stdout)";
	process.stdout.write(`OK ${target}  ${md.length} bytes${extra}\n`);
}

const USAGE = `dsh-distillation CLI

  comfy  <workflow.json> [--out f.md] [--title T] [--print]
         Parse a ComfyUI workflow (UI or API format) into an 8-section Markdown analysis.

  source <url|file>...   --out f.md [--title T] [--follow N] [--print]
         Normalize websites / html / markdown / txt / json / ComfyUI workflows
         into one combined Markdown document. HTML is reduced to main content;
         --follow N also follows N same-origin links (cap: maxFollowPages).

  skill  --name <kebab> --description <text> [--body-file F] [--when-to-use T]
         [--target user|project] [--extra rel/path=<localfile>]... [--print]
         Create a DSH skill under the user (~/.dsh/skills) or project root.

  evolve --skill <id|dir> (--from <doc.md> | --text <markdown>)
         [--slug S] [--dry-run] [--git-init] [--judges N] [--cwd DIR]
         Deterministic pre-flight (valid frontmatter, git repo, test-prompts skeleton,
         auto-optimize/<stamp> branch) + material merge + evaluation ticket.
         The 9-dimension rewrite and judging stay with the agent (darwin).

  evolve --skill <id|dir> --finalize --decision keep|revert [--note "..."] [--run-id R]
         Archive one evaluation round into evolution/<run-id>/result.json.

  git    <url|dir> --out f.md [--branch B] [--title T] [--max-files N] [--print]
         Analyse a repository into 8 sections (overview / tree / languages /
         entrypoints / docs / examples / conventions / appendix). Remotes are
         cloned with --depth 1 into a temp dir; local paths are read in place.

  docs   <url> [--list] [--filter S|/regex/] [--limit N] [--out f.md]
         [--per-page] [--target user|project] [--title T] [--json] [--print]
         Probe https://<site>/llms.txt, list the pages it offers (preferring
         .md mirrors), then merge them into one document or install one skill
         per page. --list reports the candidates without fetching pages.

  route  --request "<自然语言需求>" [--cwd DIR] [--json]
         Match the orchestrator index (skill-orchestrator/skills.index.json)
         and print a STRUCTURED PLAN. Does not execute anything.

  cangjie --bundle <verified bundle dir> [--variant single|pack|auto]
         [--purpose learning|reference|workflow|distribution]
         [--out DIR] [--target user|project] [--cli PATH] [--uv NAME]
         [--no-install] [--overwrite] [--cwd DIR]
         Compile a verified cangjie Capability Bundle into a real DSH skill
         and install it (copies into the skill root + records provenance).

  list   [--cwd DIR] [--json] [--generated]
         Show every known skill root and which skills it exposes.
         With --generated, list the skills this plugin produced or changed.
`;

async function cmdComfy({ flags, positional }) {
	const input = positional[0];
	if (!input) fail(1, "comfy: missing <workflow.json>\n\n" + USAGE);
	const raw = await readFile(resolve(input), "utf8");
	let json;
	try { json = JSON.parse(raw); } catch (e) { fail(2, `not valid JSON: ${e.message}`); }
	if (!isComfyWorkflow(json)) fail(2, `not a ComfyUI workflow (expected UI "nodes" or API "class_type" shape): ${input}`);
	const analysis = analyzeComfyWorkflow(json, resolve(input));
	const md = renderComfyMd(analysis, flags.title ?? `${basename(resolve(input))} 解析`);
	await emit(md, flags.out, flags.print);
	report(flags.out, md, `  format=${analysis.format} nodes=${analysis.nodeCount} edges=${analysis.edgeCount}`);
}

async function cmdSource({ flags, positional }) {
	if (positional.length === 0) fail(1, "source: need at least one <url|file>\n\n" + USAGE);
	if (!flags.out) fail(1, "source: --out is required");
	const follow = Number(flags.follow ?? 0);
	if (Number.isFinite(follow) && follow < 0) fail(1, "source: --follow must be 0 or a positive integer");
	const config = follow > 0 ? { ...DEFAULT_CONFIG, followPages: follow } : DEFAULT_CONFIG;
	const results = [];
	for (const source of positional) {
		try {
			results.push(await ingestSource(source, config));
		} catch (error) {
			process.stderr.write(`WARN source failed: ${source}: ${error.message}\n`);
			results.push({ label: source, kind: "error", text: `> failed: ${error.message}`, meta: {} });
		}
	}
	const md = renderSourcesMd(flags.title ?? "蒸馏文档", results);
	await emit(md, flags.out, flags.print);
	const followed = results.reduce((sum, r) => sum + (r.extraPages?.length ?? 0), 0);
	report(flags.out, md, `  sources=${results.length}${followed > 0 ? ` followed=${followed}` : ""}`);
}

async function cmdSkill({ flags, positional }) {
	if (!flags.name) fail(1, "skill: --name is required\n\n" + USAGE);
	if (!flags.description) fail(1, "skill: --description is required");
	const body = flags["body-file"] ? await readFile(resolve(flags["body-file"]), "utf8") : flags.body ?? "";
	const root = resolveSkillRoot(flags.target ?? "user", process.cwd(), DEFAULT_CONFIG);
	const extraFiles = [];
	for (const spec of flags.extra ?? []) {
		const eq = spec.indexOf("=");
		if (eq === -1) fail(1, `--extra must be <rel/path>=<localfile>, got "${spec}"`);
		const rel = spec.slice(0, eq);
		const src = resolve(spec.slice(eq + 1));
		extraFiles.push({ path: rel, content: await readFile(src, "utf8") });
	}
	const result = await writeSkillBundle({
		root,
		skillName: flags.name,
		description: flags.description,
		body,
		whenToUse: flags["when-to-use"],
		extraFiles
	});
	await recordArtifact({
		skillDir: result.dir,
		origin: "distill_skill",
		tool: "cli skill",
		source: { kind: "cli", label: flags["body-file"] ?? "(inline body)" },
		note: `${result.written.length} file(s) written`
	});
	if (flags.print) process.stdout.write(buildSkillMarkdown({
		name: flags.name, description: flags.description, body, whenToUse: flags["when-to-use"]
	}));
	process.stdout.write(`OK ${result.dir}\n`);
	for (const f of result.written) process.stdout.write(`  wrote ${f}\n`);
	process.stdout.write("The skill-filesystem provider picks this up live (no restart).\n");
	process.stdout.write("Provenance recorded: .distillation.json (listed by `list --generated`).\n");
	positional.length = 0;
}

async function cmdRoute({ flags }) {
	const request = flags.request;
	if (!request) fail(1, "route: --request \"<自然语言需求>\" is required\n\n" + USAGE);
	const route = await routeRequest({
		request,
		cwd: flags.cwd ? resolve(flags.cwd) : process.cwd(),
		config: DEFAULT_CONFIG
	});
	if (flags.json) {
		process.stdout.write(JSON.stringify(route, null, 2) + "\n");
		return;
	}
	process.stdout.write(`request: ${request}\n`);
	process.stdout.write(`index:   ${route.indexFile ?? "(not found)"}\n`);
	process.stdout.write(`confidence: ${route.confidence}${route.needsClarification ? "  (needs clarification)" : ""}\n`);
	if (route.plan.length === 0) {
		process.stdout.write("plan: (empty)\n");
	} else {
		process.stdout.write("plan:\n");
		for (const s of route.plan) {
			process.stdout.write(`  ${s.step}. ${s.skill} [${s.execution}] — ${s.why}\n`);
			for (const g of s.gates) process.stdout.write(`       gate: ${g}\n`);
		}
	}
	for (const c of route.clarify) {
		process.stdout.write(`? ${c.question}\n`);
		if (c.options?.length) process.stdout.write(`    options: ${c.options.join(" / ")}\n`);
	}
}

async function cmdList({ flags }) {
	const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
	if (flags.generated) {
		const roots = await inspectRoots(cwd, DEFAULT_CONFIG);
		const artifacts = await listGeneratedSkills(roots.map((r) => ({ dir: r.dir, source: r.kind, rank: r.rank })));
		if (flags.json) {
			process.stdout.write(JSON.stringify(artifacts, null, 2) + "\n");
			return;
		}
		process.stdout.write(`Skills this plugin generated or changed (${artifacts.length}):\n`);
		for (const a of artifacts) {
			process.stdout.write(`  ${a.name}  [${a.origin}${a.tool ? ` · ${a.tool}` : ""}]  ${a.updatedAt}  ${a.dir}\n`);
		}
		process.stdout.write(`index: ${artifactIndexPath()} (derived cache; ${ARTIFACT_SIDECAR} is the source of truth)\n`);
		return;
	}
	const roots = await inspectRoots(cwd, DEFAULT_CONFIG);
	if (flags.json) {
		process.stdout.write(JSON.stringify(roots, null, 2) + "\n");
		return;
	}
	for (const r of roots) {
		const mark = r.exists ? (r.skills.length ? "ok " : "empty") : "missing";
		process.stdout.write(`[${mark}] rank=${String(r.rank).padStart(3)} ${r.kind.padEnd(15)} ${r.dir}\n`);
		if (r.skills.length) process.stdout.write(`        skills: ${r.skills.join(", ")}\n`);
		if (r.error) process.stdout.write(`        error: ${r.error}\n`);
	}
}

async function cmdEvolve({ flags }) {
	const skill = flags.skill;
	if (!skill) fail(1, "evolve: --skill <id|dir> is required\n\n" + USAGE);
	const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
	const skillDir = resolveSkillDir(skill, cwd, DEFAULT_CONFIG);
	if (!skillDir) fail(2, `skill "${skill}" not found in any DSH skill root (or it has no SKILL.md); run: list`);

	if (flags.finalize === true) {
		const decision = flags.decision ?? "keep";
		const result = await finalizeEvolution({ skillDir, runId: flags["run-id"], decision, note: flags.note });
		process.stdout.write(`finalized ${result.runId}: ${result.decision} (${result.judgedRows} judged rows)\n`);
		process.stdout.write(`  result: ${result.resultPath}\n`);
		if (result.gitCommand) process.stdout.write(`  to revert, run in the skill's repo: ${result.gitCommand}\n`);
		return;
	}

	if (!flags.from && !flags.text) fail(1, "evolve: provide --from <doc.md> or --text <markdown>");
	const sourceLabel = flags.from ? resolve(flags.from) : "(inline)";
	const referenceContent = flags.from ? await readFile(sourceLabel, "utf8") : flags.text;
	const result = await evolveSkill({
		skillDir,
		referenceContent,
		sourceLabel,
		slug: flags.slug,
		dryRun: flags["dry-run"] === true,
		runner: execFileRunner,
		gitInit: flags["git-init"] === true,
		judges: flags.judges ? Number(flags.judges) : 3
	});
	if (result.dryRun) {
		process.stdout.write(`DRY RUN ${result.skillName}  ${result.skillDir}\n`);
		process.stdout.write(`  reference: ${result.referenceRel} (${result.referenceBytes} bytes)\n`);
		process.stdout.write("  nothing written; pass without --dry-run to apply\n");
		if (flags.print) process.stdout.write("\n" + result.preview + "\n");
		return;
	}
	process.stdout.write(`OK ${result.skillName}  ${result.skillDir}\n`);
	process.stdout.write(`  branch:    ${result.branch} (baseline ${result.baseRev})\n`);
	process.stdout.write(`  reference: ${result.referenceRel} (${result.referenceBytes} bytes)\n`);
	process.stdout.write(`  backup:    ${result.backupPath}\n`);
	process.stdout.write(`  marker:    ${result.replacedBlock ? "updated in place" : "added"}\n`);
	if (result.testPrompts) process.stdout.write(`  test-prompts skeleton: ${result.testPrompts}  ← 必须先改写成真实用例\n`);
	process.stdout.write(`  ticket:    ${result.planPath}\n`);
	process.stdout.write(`  log:       ${result.resultsPath}  (${result.judgeCount} judges, odd)\n`);
	process.stdout.write(`  finalize:  node cli.mjs evolve --skill ${skill} --finalize --decision keep|revert --run-id ${result.runId}\n`);
}

async function cmdCangjie({ flags }) {
	const bundle = flags.bundle;
	if (!bundle) fail(1, "cangjie: --bundle <verified bundle dir> is required\n\n" + USAGE);
	const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
	const cli = flags.cli ? resolve(flags.cli) : resolveCangjieCli(cwd, DEFAULT_CONFIG);
	if (!cli) fail(2, "cangjie CLI not found (scripts/cangjie.py); pass --cli or set $CANGJIE_CLI");
	const bundleDir = resolve(bundle);
	const outDir = flags.out ? resolve(flags.out) : join(tmpdir(), `dsh-distill-${Date.now()}`);
	const variant = flags.variant ?? "single";
	const result = await runCangjieCompile({
		runner: execFileRunner,
		cli,
		bundleDir,
		outDir,
		variant,
		purpose: flags.purpose ?? "learning",
		cwd,
		timeoutMs: 600_000,
		command: flags.uv ?? "uv"
	});
	process.stdout.write(`cangjie compile (${variant}) -> exit ${result.code} in ${result.elapsedMs}ms\n`);
	for (const line of String(result.stdout ?? "").split("\n").filter((l) => l.trim().length > 0).slice(-3)) {
		process.stdout.write("  " + line + "\n");
	}
	if (result.code !== 0) {
		process.stderr.write(String(result.stderr ?? "").split("\n").slice(-8).join("\n") + "\n");
		fail(2, "cangjie compile failed");
	}
	if (flags["no-install"] === true) {
		process.stdout.write(`  compiled only -> ${outDir}\n`);
		return;
	}
	const outcome = await installCompiledSkills({
		outDir,
		target: flags.target ?? "user",
		cwd,
		config: DEFAULT_CONFIG,
		overwrite: flags.overwrite === true,
		sourceLabel: bundleDir,
		variant
	});
	for (const skill of outcome.installed) process.stdout.write(`  installed ${skill.name} -> ${skill.dir}\n`);
	for (const bad of outcome.rejected) process.stdout.write(`  rejected ${bad.name}: ${bad.reason}\n`);
	process.stdout.write(`The skill provider picks these up live (no restart).\n`);
}

/**
 * `engines list | export` — the engines that ship inside the plugin package.
 *
 * `list` answers "is everything here?"; `export` copies them into a skill root so
 * DSH's own inventory sees them too. The plugin's provider already exposes the
 * bundled directory, so export is opt-in.
 */
async function cmdEngines({ flags, positional }) {
	const sub = positional[0] ?? "list";
	const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
	const dir = bundledEnginesDir();

	if (sub === "list") {
		const engines = await listBundledEngines();
		if (flags.json) {
			process.stdout.write(JSON.stringify({ dir: dir ?? null, engines }, null, 2) + "\n");
			return;
		}
		if (engines.length === 0) fail(2, "this package ships no engines/ directory");
		process.stdout.write(`bundled engines: ${dir}\n`);
		for (const engine of engines) {
			process.stdout.write(`  ${engine.id.padEnd(20)} SKILL.md:${engine.skillFile ? "yes" : "no "}  upstream:${engine.upstream ? "pinned" : "-"}\n`);
		}
		return;
	}

	if (sub === "export") {
		const result = await exportBundledEngines({
			target: flags.target ?? "user",
			cwd,
			config: DEFAULT_CONFIG,
			overwrite: flags.overwrite === true
		});
		for (const item of result.shipped) process.stdout.write(`  exported ${item.id} -> ${item.dir}\n`);
		for (const item of result.skipped) process.stdout.write(`  skipped  ${item.id}: ${item.reason}\n`);
		process.stdout.write(`root: ${result.root}\n`);
		return;
	}

	fail(1, `unknown engines subcommand "${sub}" (use: list | export)\n\n${USAGE}`);
}

/**
 * `doctor` — the same self-check the host tool runs, available without a restart.
 * Exit code 2 when a check FAILED (warnings do not fail the command).
 */
async function cmdDoctor({ flags }) {
	const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();
	const report = await runDoctor({ cwd, config: DEFAULT_CONFIG, runner: execFileRunner });
	const file = await writeDoctorReport(report);
	if (flags.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else {
		process.stdout.write(report.summary + "\n" + `report: ${file}\n`);
	}
	if (!report.ok) process.exitCode = 2;
}

/**
 * `git` — analyse a repository (remote, cloned depth 1, or a local checkout).
 */
async function cmdGit({ flags, positional }) {
	const source = positional[0];
	if (!source) fail(1, "git: need <url|dir>\n\n" + USAGE);
	if (!flags.out) fail(1, "git: --out is required");
	const analysis = await analyzeRepository({
		source,
		cwd: process.cwd(),
		config: DEFAULT_CONFIG,
		runner: execFileRunner,
		branch: flags.branch,
		maxFiles: flags["max-files"] ? Number(flags["max-files"]) : 4000
	});
	try {
		const md = renderRepoMd(analysis, flags.title);
		await emit(md, flags.out, flags.print);
		report(flags.out, md, `  files=${analysis.scan.fileCount}  cloned=${analysis.cloned}`);
	} finally {
		if (analysis.cleanup) await analysis.cleanup();
	}
}

/**
 * `docs` — a docs site → llms.txt → selected pages → one document or one skill/page.
 */
async function cmdDocs({ flags, positional }) {
	const url = positional[0];
	if (!url) fail(1, "docs: need a docs site <url>\n\n" + USAGE);
	const limit = flags.limit ? Number(flags.limit) : 20;
	if (flags.list === true) {
		const plan = await planDocsPages({ url, config: DEFAULT_CONFIG, limit });
		const shown = filterDocPages(plan.pages, flags.filter).slice(0, limit);
		if (flags.json) {
			process.stdout.write(JSON.stringify({ strategy: plan.strategy, indexUrl: plan.indexUrl, total: plan.total, pages: shown }, null, 2) + "\n");
			return;
		}
		process.stdout.write(plan.strategy === "llms.txt" ? `index: ${plan.indexUrl} (${plan.total} pages, ${plan.llms.markdownCount} as .md)\n` : `no llms.txt (tried ${plan.llms.tried.join(", ")}); same-origin links: ${plan.total}\n`);
		for (const page of shown) process.stdout.write(`  ${page.markdown ? "[md]  " : "[html]"} ${page.title} — ${page.url}\n`);
		return;
	}
	const result = await distillDocs({
		url,
		config: DEFAULT_CONFIG,
		filter: flags.filter,
		limit,
		perPage: flags["per-page"] === true,
		target: flags.target ?? "user",
		cwd: process.cwd()
	});
	if (flags.out) await emit(result.document, flags.out, flags.print);
	else if (flags.print) process.stdout.write(result.document + "\n");
	for (const skill of result.skills) process.stdout.write(`  installed ${skill.name} -> ${skill.dir}\n`);
	if (flags.json) {
		process.stdout.write(JSON.stringify({ ...result, document: undefined }, null, 2) + "\n");
		return;
	}
	const where = flags.out ? resolve(flags.out) : flags.print ? "(stdout)" : "(memory only — pass --out)";
	report(where, result.document, `  discovery=${result.strategy} pages=${result.fetched}/${result.selected} skills=${result.skills.length} failed=${result.failed.length}`);
}

const COMMANDS = { comfy: cmdComfy, source: cmdSource, skill: cmdSkill, evolve: cmdEvolve, route: cmdRoute, cangjie: cmdCangjie, list: cmdList, engines: cmdEngines, doctor: cmdDoctor, git: cmdGit, docs: cmdDocs };

const parsed = parseArgs(process.argv.slice(2));
const cmd = parsed.positional.shift();
const runner = COMMANDS[cmd];
if (!runner) fail(1, cmd ? `unknown command "${cmd}"\n\n${USAGE}` : USAGE);

try {
	await runner(parsed);
} catch (error) {
	fail(2, `error: ${error?.message ?? error}`);
}
