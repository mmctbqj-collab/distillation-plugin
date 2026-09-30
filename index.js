/**
 * dsh-distillation — DSH host plugin: distill websites / documents / books / Git / ComfyUI
 * workflows into DSH skills, and inject them into the DSH skill catalog.
 *
 * Dependency-free ESM host plugin: it imports only `node:*` builtins and its own ./core.mjs.
 * A workspace package linked into the profile resolves from its real path, where the dsh
 * installation's bundled `@deepseek-ai/*` packages are NOT reachable, so this file carries
 * its own `defineTool` and compiles the author schema into the raw JSON Schema that the
 * tools registry requires (see the ToolDefinition contract).
 * Verified integration facts this plugin relies on:
 *  - `~/.dsh/skills/<name>/SKILL.md` (rank 400) and `<cwd>/.dsh/skills/<name>/SKILL.md` (rank 100)
 *    are discovered by @deepseek-ai/dsh-skill-filesystem.
 *  - The provider watches those roots; a SKILL.md written directly to disk is picked up live
 *    (verified: no `fs/observed` event and no restart required).
 *  - frontmatter needs `name` (matching /^[a-z0-9]+(?:-[a-z0-9]+)*$/) and a non-empty `description`.
 *
 * @module dsh-distillation
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";

export const name = "distillation";
export const inject = ["tools", "skills"];

/** Package version the host half reports (kept in step with package.json). */
export const PLUGIN_VERSION = "1.0.0";
/** Read-only JSON snapshot consumed by the client page. */
export const STATUS_ROUTE = "/dsh-distillation/status";

/**
 * Config defaults. Declared as plain data instead of a `Config` schema so the bundle
 * needs no schema package; the patch row's `config` still overrides any of them.
 */
const CONFIG_DEFAULTS = Object.freeze({
	skillsDir: undefined,
	extraSkillDirs: [],
	maxSourceBytes: 4_000_000,
	userAgent: "dsh-distillation/1.0.0 (+dsh host plugin)",
	/** Transport retries for URL sources (exponential backoff, 5xx/429 only). */
	fetchRetries: 3,
	/** Extra same-origin pages `distill_sources` may follow (hard cap). */
	maxFollowPages: 5,
	/** Extra pages to follow by default; 0 keeps a call to exactly what was asked. */
	followPages: 0,
	/** Explicit path to `cangjie.py`; otherwise discovered through the skill roots. */
	cangjieCli: undefined,
	/** The `uv` executable used to run the cangjie CLI. */
	cangjieUv: "uv",
	cangjieTimeoutMs: 600_000
});

/**
 * Compile the author schema used by the tool definitions below into the raw JSON Schema
 * that `ToolDefinition.parameters` / `ToolOutputDefinition.schema` require: a per-property
 * `required: true` is lifted into the parent's `required: string[]`.
 */
function compileSchema(node) {
	if (node === null || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map(compileSchema);
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "required") continue; // lifted by the enclosing property map
		if (key === "properties") {
			const map = compilePropertyMap(value);
			out.properties = map.properties;
			if (map.required.length > 0) out.required = map.required;
			continue;
		}
		if (key === "items") {
			out.items = compileSchema(value);
			continue;
		}
		if (key === "oneOf") {
			out.oneOf = Array.isArray(value) ? value.map(compileSchema) : value;
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * Compile one property map. The author form is a bare `{ prop: spec }` map; the caller
 * roots it as an object schema (parameters) or folds it into an object node.
 */
function compilePropertyMap(spec) {
	const properties = {};
	const required = [];
	for (const [prop, node] of Object.entries(spec ?? {})) {
		if (node && typeof node === "object" && node.required === true) required.push(prop);
		properties[prop] = compileSchema(node);
	}
	return { properties, required };
}

/** Root a property map as the tool's parameter schema. */
function compileParameters(spec) {
	const { properties, required } = compilePropertyMap(spec);
	const out = { type: "object", properties };
	if (required.length > 0) out.required = required;
	return out;
}

/** Assemble a ToolDefinition from a tool author object; the shipped `defineTool` equivalent. */
function defineTool(options) {
	if (!options || typeof options.name !== "string" || options.name.length === 0) {
		throw new Error("defineTool requires a non-empty name");
	}
	if (typeof options.description !== "string" || options.description.length === 0) {
		throw new Error(`defineTool(${options.name}) requires a non-empty description`);
	}
	const parameters = compileParameters(options.parameters);
	const required = Array.isArray(parameters.required) ? parameters.required : [];
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: compileSchema(options.output?.schema ?? { type: "object" }),
			render: options.output?.render ?? (() => [{ type: "text", text: "" }])
		},
		async execute(args, exec) {
			if (required.length > 0) {
				if (args === null || typeof args !== "object") throw new Error("invalid arguments: expected an object");
				for (const key of required) {
					if (args[key] === undefined) throw new Error(`invalid arguments: missing required "${key}"`);
				}
			}
			return await options.execute(args, exec);
		}
	};
	if (typeof options.presentCall === "function") {
		tool.presentCall = (args) => options.presentCall(args);
	}
	return tool;
}

import {
	SKILL_NAME,
	dshHome,
	userSkillsDir,
	projectSkillsDir,
	expandTilde,
	resolveSkillRoot,
	slugify,
	HTML_ENTITIES,
	htmlToText,
	htmlTitle,
	isComfyWorkflow,
	PARAM_KEYS,
	NODE_ROLES,
	nodeRole,
	widgetString,
	nodeParams,
	analyzeComfyWorkflow,
	renderComfyMd,
	ingestSource,
	renderSourcesMd,
	buildSkillMarkdown,
	writeSkillBundle,
	inspectRoots,
	parseSkillFrontmatter,
	defaultSkillRoots,
	readSkillCandidates,
	resolveSkillDir,
	enhanceSkill,
	evolveSkill,
	finalizeEvolution,
	recordArtifact,
	listGeneratedSkills,
	artifactIndexPath,
	ARTIFACT_SIDECAR,
	routeRequest,
	analyzeRepository,
	renderRepoMd,
	planDocsPages,
	filterDocPages,
	distillDocs,
	resolveCangjieCli,
	runCangjieCompile,
	installCompiledSkills,
	findCompiledSkills,
	lines,
	cwdOf,
	bundledEnginesDir,
	listBundledEngines,
	exportBundledEngines,
	runDoctor,
	readDoctorReport,
	writeDoctorReport
} from "./core.mjs";

export * from "./core.mjs";

/** Provider name for the Node-fs skill provider this plugin registers. */
const PROVIDER_NAME = "distillation-filesystem";

/** Load one candidate into the full definition the skills registry validates. */
async function loadSkillDefinition(candidate) {
	let text;
	try {
		text = await readFile(candidate.locator.path, "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseSkillFrontmatter(text);
	if (!parsed) return undefined;
	// `candidate.name` is the routing key (directory name when valid); the frontmatter name
	// must still match what discovery saw, so a stale candidate cannot load a different skill.
	if (candidate.frontmatterName !== undefined && parsed.name !== candidate.frontmatterName) return undefined;
	return {
		name: candidate.name,
		description: parsed.description,
		...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
		invocation: parsed.invocation,
		source: candidate.source,
		provider: PROVIDER_NAME,
		resourceBase: candidate.resourceBase,
		path: candidate.locator.path,
		content: parsed.body.trim()
	};
}

/**
 * Run one local command through the platform subprocess seam.
 *
 * The spec shape is taken from the shipped `dsh-bash-local` consumer rather than guessed:
 * `{ argv, cwd, stdio, graceMs, signal }` with collect-mode streams, and a handle exposing
 * `done` (`{ exitCode, signal }`) plus `collected.{stdout,stderr}.readFrom(offset)`.
 * Using the seam (instead of `node:child_process`) keeps the child inside the platform's
 * managed range, so service disposal terminates it.
 */
function createSubprocessRunner(ctx) {
	const service = ctx.get("subprocess");
	if (!service || typeof service.spawn !== "function") return undefined;
	return async ({ command, args, cwd, timeoutMs = 600_000 }) => {
		const executable = await service.resolveExecutable(command);
		const controller = new AbortController();
		let timer;
		try {
			const handle = service.spawn({
				argv: [executable, ...args],
				cwd: cwd ?? process.cwd(),
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: 8 * 1024 * 1024, spill: { maxBytes: 32 * 1024 * 1024 } },
					stderr: { maxBytes: 8 * 1024 * 1024, spill: { maxBytes: 32 * 1024 * 1024 } }
				},
				graceMs: 5000,
				signal: controller.signal
			});
			timer = setTimeout(() => controller.abort(), timeoutMs);
			let outcome;
			let failure;
			try {
				outcome = await handle.done;
			} catch (error) {
				failure = error;
			}
			const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? "";
			const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? "";
			const timedOut = controller.signal.aborted;
			if (failure !== undefined && !timedOut) throw failure;
			return {
				code: typeof outcome?.exitCode === "number" ? outcome.exitCode : null,
				signal: outcome?.signal ?? null,
				stdout,
				stderr: timedOut && stderr.length === 0 ? `timed out after ${timeoutMs}ms` : stderr,
				timedOut
			};
		} finally {
			clearTimeout(timer);
		}
	};
}

export function apply(ctx, config = {}) {
	/** Effective config: defaults overridden by the patch row's `config`. */
	const cfg = { ...CONFIG_DEFAULTS, ...(config ?? {}) };

	/**
	 * Expose local skill roots through `node:fs`.
	 *
	 * The dsh filesystem provider reads local roots through `ctx.fs`, which resolves
	 * nothing for user/project roots in the active preset (only its Node-fs "bundled"
	 * root reaches the catalog), so skills in `~/.dsh/skills` or `<cwd>/.dsh/skills`
	 * were invisible. Reading the same roots with `node:fs` here fixes that, which is
	 * what `ctx.skills.registerProvider` exists for.
	 *
	 * Wrapped so a provider failure can never take the tools down with it.
	 */
	try {
		ctx.effect(() =>
			ctx.skills.registerProvider(() => ({
				name: PROVIDER_NAME,
				async list(options) {
					const roots = defaultSkillRoots(options?.cwd, cfg);
					return await readSkillCandidates(roots, PROVIDER_NAME);
				},
				get(candidate) {
					return loadSkillDefinition(candidate);
				}
			}))
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof console !== "undefined" && typeof console.warn === "function") {
			console.warn(`dsh-distillation: skill provider registration failed: ${message}`);
		}
	}

	/* ---------------- read-only status route for the client page ---------------- */
	// The page runs in the browser and cannot read the disk, so the host serves one
	// read-only JSON snapshot over the same origin the page was loaded from. This is
	// the pattern the shipped hub uses (ctx.webServer.register); nothing here mutates
	// anything, so the route is safe to expose on the loopback server.
	//
	// Registration must be *visible*: an earlier version swallowed every failure, so a
	// lost route (which happens when an activation is replaced while the web surface
	// is still coming up) showed up only as an unexplained "HTTP 404" on the page.
	const statusRoute = { registered: false, reason: "not attempted" };
	const statusHandler = async (req, res) => {
		const send = (code, body) => {
			try {
				res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(JSON.stringify(body));
			} catch {
				/* the client went away */
			}
		};
		try {
			const url = new URL(req?.url ?? "/", "http://localhost");
			const cwd = url.searchParams.get("cwd") || process.cwd();
			const roots = await inspectRoots(cwd, cfg);
			const generated = await listGeneratedSkills(roots.map((root) => ({ dir: root.dir, source: root.kind, rank: root.rank })));
			const engines = (await listBundledEngines()).map((engine) => ({
				id: engine.id,
				hasSkill: Boolean(engine.skillFile),
				pinned: Boolean(engine.upstream)
			}));
			const doctor = url.searchParams.get("doctor") === "1"
				? await runDoctor({ cwd, config: cfg, runner: createSubprocessRunner(ctx), probe: false, runtime: { statusRoute } })
				: await readDoctorReport();
			send(200, {
				schema: "dsh-distillation/status/v1",
				version: PLUGIN_VERSION,
				cwd,
				statusRoute: { registered: statusRoute.registered, reason: statusRoute.reason },
				roots: roots.map((root) => ({ kind: root.kind, rank: root.rank, dir: root.dir, exists: root.exists, skills: root.skills })),
				generated: generated.map((artifact) => ({
					name: artifact.name,
					origin: artifact.origin,
					tool: artifact.tool ?? "",
					updatedAt: artifact.updatedAt ?? "",
					dir: artifact.dir,
					rootSource: artifact.rootSource,
					description: artifact.description ?? "",
					runCount: artifact.runs?.length ?? 0
				})),
				engines,
				doctor: doctor
					? {
							ok: doctor.ok,
							counts: doctor.counts,
							checkedAt: doctor.checkedAt,
							checks: doctor.checks.map((check) => ({
								id: check.id,
								label: check.label,
								status: check.status,
								detail: check.detail,
								fix: check.fix ?? ""
							}))
						}
					: undefined
			});
		} catch (error) {
			send(500, { error: String(error?.message ?? error) });
		}
	};

	/**
	 * Own the status route, or explain why not.
	 *
	 * Three cases matter and they are NOT the same: a late `webServer` (retry), a
	 * duplicate path (an earlier activation still serves it — that is success), and
	 * anything else (recorded, so `distill_doctor` can say what happened).
	 */
	const tryRegisterStatusRoute = () => {
		const web = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
		if (!web || typeof web.register !== "function") {
			statusRoute.reason = "webServer service is not available yet";
			return false;
		}
		try {
			ctx.effect(() => web.register({ kind: "exact", path: STATUS_ROUTE, handler: statusHandler }));
			statusRoute.registered = true;
			statusRoute.reason = "";
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/duplicate|already|conflict|exists/i.test(message)) {
				statusRoute.registered = true;
				statusRoute.reason = `served by an earlier activation (${message})`;
				return true;
			}
			statusRoute.reason = message;
			return false;
		}
	};
	if (!tryRegisterStatusRoute()) {
		// The web surface can mount after this row, so retry briefly rather than ending
		// up with a page that can only say "HTTP 404".
		for (const delay of [250, 1000, 3000]) {
			try {
				ctx.setTimeout?.(() => {
					if (!statusRoute.registered) tryRegisterStatusRoute();
				}, delay);
			} catch {
				/* no timer service in this composition */
			}
		}
		if (typeof console !== "undefined" && typeof console.warn === "function") {
			console.warn(`dsh-distillation: ${STATUS_ROUTE} not registered yet (${statusRoute.reason}); the page reports it and distill_doctor shows it.`);
		}
	}

	/* ---------------- distill_sources ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_sources",
		description: lines([
			"Ingest local files (markdown, text, HTML, JSON) and http(s) URLs into a single normalized Markdown analysis document.",
			"HTML is reduced to its MAIN content by a readability-style scorer (text density beats link density, chrome tags are dropped),",
			"transport failures are retried with exponential backoff, and the page charset is honoured with a UTF-8 fallback.",
			"ComfyUI workflow JSON is detected automatically and expanded into a structured analysis instead of a raw JSON dump.",
			"Use this as the first step of turning a website, manual, book chapter, or workflow into a DSH skill."
		]),
		parameters: {
			sources: {
				type: "array",
				required: true,
				description: "Local file paths and/or http(s) URLs to ingest.",
				items: { type: "string", description: "A path or URL." }
			},
			out: { type: "string", required: true, description: "Absolute path of the Markdown document to write." },
			title: { type: "string", description: "Document title. Defaults to '蒸馏来源分析'." },
			follow: {
				type: "integer",
				description: `How many extra same-origin pages to follow for each URL source (a tutorial index page, for example). Defaults to 0; capped by config.maxFollowPages (currently ${5}).`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					sourceCount: { type: "integer", required: true },
					kinds: { type: "array", required: true, items: { type: "string" } },
					bytes: { type: "integer", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args) {
			const results = [];
			const failures = [];
			const followPages = Number.isFinite(Number(args.follow)) && Number(args.follow) > 0 ? Number(args.follow) : undefined;
			const config = followPages === undefined ? cfg : { ...cfg, followPages };
			for (const source of args.sources) {
				try {
					results.push(await ingestSource(source, config));
				} catch (error) {
					failures.push(`${source}: ${error.message}`);
				}
			}
			if (results.length === 0) throw new Error(`all sources failed:\n${failures.join("\n")}`);
			const md = renderSourcesMd(args.title ?? "蒸馏来源分析", results);
			const out = resolvePath(expandTilde(args.out));
			await mkdir(dirname(out), { recursive: true });
			await writeFile(out, md, "utf8");
			const kinds = [...new Set(results.map((r) => r.kind))];
			return {
				path: out,
				sourceCount: results.length,
				kinds,
				bytes: Buffer.byteLength(md, "utf8"),
				summary: lines([
					`Wrote ${out} (${results.length} source(s), ${Buffer.byteLength(md, "utf8")} bytes).`,
					`Kinds: ${kinds.join(", ")}.`,
					failures.length > 0 ? `Failed sources:\n${failures.join("\n")}` : "",
					"Next: call distill_skill to turn this document into a loadable DSH skill."
				])
			};
		},
		presentCall: (args) => ({ card: "generic", title: "Distill sources", kind: "other", rawInput: args.sources })
	}));

	/* ---------------- distill_comfyui ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_comfyui",
		description: lines([
			"Parse a ComfyUI workflow JSON (UI format with `nodes`/`links`, or API format with `class_type`) into a Markdown document",
			"explaining what the workflow does: models, sampling parameters, prompts, module groups, data flow, and the design concepts it implements.",
			"Use when the user wants to understand a workflow they downloaded or built."
		]),
		parameters: {
			path: { type: "string", required: true, description: "Absolute path of the ComfyUI workflow JSON." },
			out: { type: "string", description: "Optional absolute path for the Markdown output. Omit to return the document inline." },
			title: { type: "string", description: "Document title." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					format: { type: "string", required: true },
					nodeCount: { type: "integer", required: true },
					edgeCount: { type: "integer", required: true },
					concepts: { type: "array", required: true, items: { type: "string" } },
					path: { type: "string" },
					markdown: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.markdown.length > 20000 ? value.markdown.slice(0, 20000) + "\n…(truncated)" : value.markdown }]
		},
		async execute(args) {
			const abs = resolvePath(expandTilde(args.path));
			const raw = await readFile(abs, "utf8");
			let json;
			try { json = JSON.parse(raw); } catch (error) { throw new Error(`${abs} is not valid JSON: ${error.message}`); }
			if (!isComfyWorkflow(json)) throw new Error(`${abs} does not look like a ComfyUI workflow (no \`nodes\` array and no \`class_type\` entries)`);
			const analysis = analyzeComfyWorkflow(json, abs);
			const markdown = renderComfyMd(analysis, args.title);
			let out;
			if (typeof args.out === "string" && args.out.length > 0) {
				out = resolvePath(expandTilde(args.out));
				await mkdir(dirname(out), { recursive: true });
				await writeFile(out, markdown, "utf8");
			}
			return { format: analysis.format, nodeCount: analysis.nodeCount, edgeCount: analysis.edgeCount, concepts: analysis.concepts, path: out, markdown };
		},
		presentCall: (args) => ({ card: "generic", title: "Analyze ComfyUI workflow", kind: "other", rawInput: args.path })
	}));

	/* ---------------- distill_docs ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_docs",
		description: lines([
			"Distill a whole documentation site, not one page: probe the site's `llms.txt` index (llmstxt.org convention), list the pages it offers",
			"(preferring `.md` mirrors, which need no HTML extraction), then fetch them and either merge everything into ONE Markdown document",
			"or install ONE skill per page.",
			"Start here for any docs site — it is how you discover what is worth reading instead of guessing URLs.",
			"With `list: true` it only reports the candidates, fetching nothing but the index."
		]),
		parameters: {
			url: { type: "string", required: true, description: "Docs site URL, e.g. https://docs.comfy.org/zh." },
			list: { type: "boolean", description: "Only report the discoverable pages (no page fetching, no writing). Defaults to false." },
			out: { type: "string", description: "Where to write the merged Markdown document. Omit to return it as a summary only." },
			filter: { type: "string", description: 'Keep only pages whose title/url/description contains this text, or matches it as /regex/.' },
			limit: { type: "integer", description: "Maximum number of pages to select (default 20)." },
			perPage: { type: "boolean", description: "Install one DSH skill per page instead of merging them into one document. Defaults to false." },
			target: { type: "string", enum: ["user", "project"], description: "Where `perPage` skills are installed. Defaults to user." },
			title: { type: "string", description: "Document title. Defaults to the site host." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					strategy: { type: "string", required: true },
					indexUrl: { type: "string", required: true },
					total: { type: "integer", required: true },
					selected: { type: "integer", required: true },
					fetched: { type: "integer", required: true },
					failed: { type: "array", required: true, items: { type: "string" } },
					pages: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string", required: true },
								url: { type: "string", required: true },
								kind: { type: "string", required: true },
								bytes: { type: "integer", required: true }
							}
						}
					},
					skills: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								dir: { type: "string", required: true },
								url: { type: "string", required: true }
							}
						}
					},
					outPath: { type: "string", required: true },
					documentBytes: { type: "integer", required: true },
					preview: { type: "string", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 20;

			if (args.list === true) {
				const plan = await planDocsPages({ url: args.url, config: cfg, limit });
				const pages = filterDocPages(plan.pages, args.filter).slice(0, limit);
				return {
					strategy: plan.strategy,
					indexUrl: plan.indexUrl ?? "",
					total: plan.total,
					selected: pages.length,
					fetched: 0,
					failed: [],
					pages: pages.map((page) => ({ title: page.title, url: page.url, kind: page.markdown ? "markdown" : "html", bytes: 0 })),
					skills: [],
					outPath: "",
					documentBytes: 0,
					preview: "",
					summary: lines([
						plan.strategy === "llms.txt"
							? `Found the site index: ${plan.indexUrl} (${plan.total} page(s), ${plan.llms?.markdownCount ?? 0} as .md).`
							: `No llms.txt on this site (tried ${plan.llms?.tried?.join(", ")}); fell back to same-origin links (${plan.total}).`,
						...pages.slice(0, 25).map((page) => `- ${page.title} — ${page.url}`),
						pages.length > 25 ? `… and ${pages.length - 25} more` : "",
						"Next: call distill_docs again without `list` to fetch and merge them, or with `perPage: true` for one skill per page."
					])
				};
			}

			const result = await distillDocs({
				url: args.url,
				config: cfg,
				filter: args.filter,
				limit,
				perPage: args.perPage === true,
				skillName: args.title,
				target: args.target ?? "user",
				cwd
			});
			let outPath = "";
			if (typeof args.out === "string" && args.out.length > 0) {
				outPath = resolvePath(expandTilde(args.out));
				await mkdir(dirname(outPath), { recursive: true });
				await writeFile(outPath, result.document, "utf8");
			}
			const documentBytes = Buffer.byteLength(result.document, "utf8");
			const previewLines = result.document.split(/\r?\n/).slice(0, 12).join("\n");
			return {
				strategy: result.strategy,
				indexUrl: result.indexUrl ?? "",
				total: result.total,
				selected: result.selected,
				fetched: result.fetched,
				failed: result.failed,
				pages: result.pages.map((page) => ({ title: page.title, url: page.url, kind: page.kind, bytes: page.bytes })),
				skills: result.skills.map((skill) => ({ name: skill.name, dir: skill.dir, url: skill.url })),
				outPath,
				documentBytes,
				preview: previewLines,
				summary: lines([
					result.strategy === "llms.txt"
						? `Distilled ${result.fetched}/${result.selected} page(s) from ${result.indexUrl} (${result.total} offered).`
						: `This site has no llms.txt; distilled ${result.fetched}/${result.selected} same-origin link(s) found on ${args.url}.`,
					outPath ? `Merged document: ${outPath} (${documentBytes} bytes).` : `Merged document built in memory (${documentBytes} bytes); pass \`out\` to save it.`,
					result.failed.length > 0 ? `Failed pages: ${result.failed.join(", ")}` : "",
					result.skills.length > 0
						? `Installed ${result.skills.length} skill(s): ${result.skills.map((s) => s.name).join(", ")} → load with skill("<name>")`
						: "Pass `perPage: true` to install one skill per page instead of one document.",
					"Next: read the document, then distill_skill it into a skill (or use perPage)."
				])
			};
		},
		presentCall: (args) => ({ card: "generic", title: args?.list === true ? "List docs pages" : "Distill documentation site", kind: "other", rawInput: args.url })
	}));

	/* ---------------- distill_git ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_git",
		description: lines([
			"Analyse a Git repository (remote URL or a local checkout) into a fixed 8-section Markdown document: overview, directory tree, language mix,",
			"entrypoints/build, documentation, examples, conventions/CI, and an appendix with the largest files plus a README excerpt.",
			"A remote URL is cloned with `git clone --depth 1` into a temporary directory that is removed afterwards; a local path is read in place.",
			"Use it to turn a project into a skill, or to give the agent the lay of the land before reading any file."
		]),
		parameters: {
			source: {
				type: "string",
				required: true,
				description: "Remote repository URL (https/git/ssh) or an absolute local path to a checkout."
			},
			out: { type: "string", required: true, description: "Absolute path of the Markdown document to write." },
			branch: { type: "string", description: "Branch or tag to clone. Defaults to the repository default branch." },
			title: { type: "string", description: "Document title. Defaults to the repository directory name." },
			maxFiles: { type: "integer", description: "Stop counting after this many files (default 4000) so a monorepo stays analysable." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					source: { type: "string", required: true },
					cloned: { type: "boolean", required: true },
					fileCount: { type: "integer", required: true },
					totalBytes: { type: "integer", required: true },
					languages: { type: "array", required: true, items: { type: "string" } },
					readme: { type: "string", required: true },
					sections: { type: "array", required: true, items: { type: "string" } },
					bytes: { type: "integer", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const remote = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(args.source);
			const runner = remote ? createSubprocessRunner(ctx) : undefined;
			if (remote && runner === undefined) {
				throw new Error("the subprocess service is unavailable in this profile, so a remote repository cannot be cloned; pass a local checkout path instead");
			}
			const analysis = await analyzeRepository({
				source: args.source,
				cwd,
				config: cfg,
				runner,
				branch: args.branch,
				maxFiles: Number.isFinite(Number(args.maxFiles)) && Number(args.maxFiles) > 0 ? Number(args.maxFiles) : 4000
			});
			try {
				const md = renderRepoMd(analysis, args.title);
				const out = resolvePath(expandTilde(args.out));
				await mkdir(dirname(out), { recursive: true });
				await writeFile(out, md, "utf8");
				const sections = md.split(/\r?\n/).filter((line) => /^## \d\./.test(line)).map((line) => line.replace(/^## /, ""));
				const topLanguages = analysis.scan.languages.slice(0, 5).map((l) => `${l.lang} ${l.share}%`);
				return {
					path: out,
					source: analysis.source,
					cloned: analysis.cloned,
					fileCount: analysis.scan.fileCount,
					totalBytes: analysis.scan.totalBytes,
					languages: topLanguages,
					readme: analysis.readme?.path ?? "",
					sections,
					bytes: Buffer.byteLength(md, "utf8"),
					summary: lines([
						`${analysis.cloned ? "Cloned and analysed" : "Analysed"} ${analysis.source} → ${out} (${analysis.scan.fileCount} files, ${(analysis.scan.totalBytes / 1024).toFixed(1)} KB).`,
						topLanguages.length > 0 ? `Languages: ${topLanguages.join(", ")}.` : "Languages: none counted.",
						analysis.readme ? `README: ${analysis.readme.path}` : "No README found — the overview is inferred from structure.",
						`Sections: ${sections.length}.`,
						"Next: call distill_skill to turn this document into a loadable DSH skill."
					])
				};
			} finally {
				if (analysis.cleanup) await analysis.cleanup();
			}
		},
		presentCall: (args) => ({ card: "generic", title: "Analyse Git repository", kind: "other", rawInput: args.source })
	}));

	/* ---------------- distill_skill ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_skill",
		description: lines([
			"Write a DSH skill bundle (SKILL.md + optional extra files) into a discovered skill root so the skill becomes loadable in this session.",
			"The user root ($DSH_HOME/skills) is watched by the DSH skill provider, so a newly written skill is discovered live without restarting the app.",
			"Provide `body` = the full Markdown instructions of the skill, and a `description` that states WHEN to use it.",
			"Use `extraFiles` to bundle reference documents, manifests, or scripts alongside SKILL.md."
		]),
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Skill id: lowercase kebab-case, matching /^[a-z0-9]+(?:-[a-z0-9]+)*$/. Becomes the directory name."
			},
			description: {
				type: "string",
				required: true,
				description: "One-paragraph description telling the model when to load this skill. Required by the DSH skill frontmatter contract."
			},
			body: { type: "string", description: "Full Markdown body of SKILL.md (the instructions)." },
			whenToUse: { type: "string", description: "Optional `when-to-use` frontmatter value." },
			target: {
				type: "string",
				enum: ["user", "project"],
				description: "Which root to install into: `user` = $DSH_HOME/skills (all projects), `project` = <cwd>/.dsh/skills (this project only). Defaults to user."
			},
			extraFiles: {
				type: "array",
				description: "Extra files to write inside the skill directory.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true, description: "Path relative to the skill directory, e.g. 'references/notes.md'." },
						content: { type: "string", required: true, description: "File content." }
					}
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					skillName: { type: "string", required: true },
					directory: { type: "string", required: true },
					files: { type: "array", required: true, items: { type: "string" } },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const root = resolveSkillRoot(args.target ?? "user", cwd, cfg);
			const { dir, written } = await writeSkillBundle({
				root,
				skillName: args.name,
				description: args.description,
				body: args.body,
				whenToUse: args.whenToUse,
				extraFiles: args.extraFiles
			});
			// Provenance: without this sidecar the skill is indistinguishable from a hand-written one.
			await recordArtifact({
				skillDir: dir,
				origin: "distill_skill",
				tool: "distill_skill",
				source: { kind: "tool" },
				note: `${written.length} file(s) written to ${root}`
			});
			return {
				skillName: args.name,
				directory: dir,
				files: written,
				summary: lines([
					`Installed skill "${args.name}" at ${dir} (${written.length} file(s)).`,
					`Load it with the skill tool: skill("${args.name}").`,
					"Registry note: the DSH filesystem skill provider watches this root, so the skill is discoverable live; if a lookup misses, re-run distill_list to confirm the root, then retry."
				])
			};
		},
		presentCall: (args) => ({ card: "generic", title: "Install distilled skill", kind: "other", rawInput: args.name })
	}));

	/* ---------------- distill_list ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_list",
		description: lines([
			"Report the DSH skill roots on this machine, whether each exists, and which skills it currently exposes.",
			"Use to diagnose why a distilled or existing skill is not discoverable.",
			"With `generated: true`, instead list the skills THIS plugin produced or modified (provenance sidecars),"
			+ " which is the only way to tell plugin-generated skills apart from hand-written ones."
		]),
		parameters: {
			generated: {
				type: "boolean",
				description: "List the skills this plugin generated or changed, with origin/tool/timestamps, instead of the roots."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					roots: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								kind: { type: "string", required: true },
								rank: { type: "integer", required: true },
								dir: { type: "string", required: true },
								exists: { type: "boolean", required: true },
								skills: { type: "array", required: true, items: { type: "string" } },
								error: { type: "string" }
							}
						}
					},
					generated: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								origin: { type: "string", required: true },
								tool: { type: "string" },
								updatedAt: { type: "string", required: true },
								createdAt: { type: "string", required: true },
								dir: { type: "string", required: true },
								rootSource: { type: "string", required: true },
								description: { type: "string", required: true },
								runCount: { type: "integer", required: true }
							}
						}
					},
					indexPath: { type: "string", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const rootsRaw = await inspectRoots(cwd, cfg);
			if (args.generated === true) {
				const artifacts = await listGeneratedSkills(
					rootsRaw.map((r) => ({ dir: r.dir, source: r.kind, rank: r.rank }))
				);
				const table = artifacts.length === 0
					? "  (none yet — generate or evolve a skill first)"
					: artifacts.map((a) => `- ${a.name}  [${a.origin}${a.tool ? ` · ${a.tool}` : ""}]  ${a.updatedAt}  → ${a.dir}`).join("\n");
				return {
					roots: rootsRaw,
					generated: artifacts.map((a) => ({
						name: a.name,
						origin: a.origin,
						...(a.tool !== undefined ? { tool: a.tool } : {}),
						updatedAt: a.updatedAt ?? "",
						createdAt: a.createdAt ?? "",
						dir: a.dir,
						rootSource: a.rootSource,
						description: a.description ?? "",
						runCount: a.runs.length
					})),
					indexPath: artifactIndexPath(),
					summary: lines([
						`Skills this plugin generated or changed (${artifacts.length}):`,
						table,
						`Index: ${artifactIndexPath()} (derived cache; per-skill sidecar ${ARTIFACT_SIDECAR} is the source of truth)`
					])
				};
			}
			const report = rootsRaw.map((r) => lines([
				`- [${r.kind}] rank=${r.rank} ${r.exists ? "OK" : "MISSING"} ${r.dir}`,
				r.error ? `    error: ${r.error}` : "",
				r.skills.length > 0 ? `    skills(${r.skills.length}): ${r.skills.join(", ")}` : "    skills: (none)"
			])).join("\n");
			return {
				roots: rootsRaw,
				generated: [],
				indexPath: artifactIndexPath(),
				summary: `DSH skill roots (nearest wins; lower rank = higher priority):\n${report}`
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: args?.generated === true ? "List generated skills" : "List DSH skill roots",
			kind: "other"
		})
	}));

	/* ---------------- distill_engines ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_engines",
		description: lines([
			"List the distillation engines bundled inside this plugin (nuwa / cangjie / darwin / skill-orchestrator / skill-distillation) with their pinned upstream commits,",
			"or export them into a DSH skill root.",
			"The bundled engines are already served by this plugin's skill provider, so `skill(\"cangjie-skill\")` works with no setup at all;",
			"use `action: \"export\"` only when another tool needs them on disk under $DSH_HOME/skills."
		]),
		parameters: {
			action: {
				type: "string",
				enum: ["list", "export"],
				description: "`list` (default) reports every bundled engine; `export` copies them into a skill root."
			},
			target: {
				type: "string",
				enum: ["user", "project"],
				description: "Export destination: user = $DSH_HOME/skills (all projects), project = <cwd>/.dsh/skills (this project). Defaults to user."
			},
			overwrite: {
				type: "boolean",
				description: "Replace an engine directory that already exists. Defaults to false, in which case existing copies are skipped and reported."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string", required: true },
					dir: { type: "string", required: true },
					root: { type: "string", required: true },
					engines: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								dir: { type: "string", required: true },
								hasSkill: { type: "boolean", required: true },
								upstream: { type: "string" }
							}
						}
					},
					exported: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								dir: { type: "string", required: true }
							}
						}
					},
					skipped: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								dir: { type: "string", required: true },
								reason: { type: "string", required: true }
							}
						}
					},
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const bundled = await listBundledEngines();
			const engines = [];
			for (const engine of bundled) {
				let upstream;
				if (engine.upstream) {
					try {
						upstream = JSON.parse(await readFile(engine.upstream, "utf8"))?.upstreamCommit ?? undefined;
					} catch {
						upstream = undefined;
					}
				}
				engines.push({
					id: engine.id,
					dir: engine.dir,
					hasSkill: Boolean(engine.skillFile),
					...(upstream ? { upstream } : {})
				});
			}
			const dir = bundledEnginesDir() ?? "";

			if (args.action === "export") {
				const result = await exportBundledEngines({
					target: args.target ?? "user",
					cwd,
					config: cfg,
					overwrite: args.overwrite === true
				});
				const linesOut = [
					`Exported ${result.shipped.length} engine(s) into ${result.root}`,
					...result.shipped.map((item) => `- ${item.id} → ${item.dir}`),
					...result.skipped.map((item) => `- skipped ${item.id}: ${item.reason}`)
				];
				return { action: "export", dir, root: result.root, engines, exported: result.shipped, skipped: result.skipped, summary: lines(linesOut) };
			}

			const summaryLines = [
				`Bundled engines: ${dir || "(none — this package ships no engines/ directory)"}`,
				...engines.map((engine) => `- ${engine.id}  SKILL.md:${engine.hasSkill ? "yes" : "no"}  upstream:${engine.upstream ? engine.upstream.slice(0, 10) : "-"}`),
				"These are served automatically at skill-root rank 150; `skill(\"<id>\")` loads them with no export step."
			];
			return { action: "list", dir, root: "", engines, exported: [], skipped: [], summary: lines(summaryLines) };
		},
		presentCall: (args) => ({
			card: "generic",
			title: args?.action === "export" ? "Export bundled engines" : "List bundled engines",
			kind: "other"
		})
	}));

	/* ---------------- distill_doctor ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_doctor",
		description: lines([
			"Self-check the distillation environment before blaming a distillation step:",
			"Node version, the bundled engines (completeness + per-file drift against the vendoring record), uv, the Python/PyYAML that uv provides, git,",
			"cangjie.py discovery, skill-root writability and visibility, and the router index.",
			"Run this FIRST when a distillation path fails; every non-ok check carries the exact command that fixes it.",
			`The report is also cached at $DSH_HOME/distillation/doctor.json.`
		]),
		parameters: {
			probe: {
				type: "boolean",
				description: "Write (and remove) a probe file in the user skill root to test writability. Defaults to true; set false to inspect without touching disk."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					checkedAt: { type: "string", required: true },
					counts: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							ok: { type: "integer", required: true },
							warn: { type: "integer", required: true },
							fail: { type: "integer", required: true },
							skip: { type: "integer", required: true }
						}
					},
					checks: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								label: { type: "string", required: true },
								status: { type: "string", required: true },
								detail: { type: "string", required: true },
								fix: { type: "string" }
							}
						}
					},
					reportPath: { type: "string", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const runner = createSubprocessRunner(ctx);
			const report = await runDoctor({ cwd, config: cfg, runner, probe: args.probe !== false, runtime: { statusRoute: { ...statusRoute, path: STATUS_ROUTE } } });
			let reportPath = "";
			try {
				reportPath = await writeDoctorReport(report);
			} catch {
				/* the cache is a convenience, never a failure */
			}
			return {
				ok: report.ok,
				checkedAt: report.checkedAt,
				counts: report.counts,
				checks: report.checks.map((check) => ({
					id: check.id,
					label: check.label,
					status: check.status,
					detail: check.detail,
					...(check.fix ? { fix: check.fix } : {})
				})),
				reportPath,
				summary: report.summary
			};
		},
		presentCall: () => ({ card: "generic", title: "Distillation environment self-check", kind: "other" })
	}));

	/* ---------------- distill_route ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_route",
		description: lines([
			"Turn a natural-language request into a STRUCTURED ROUTING PLAN over the installed distillation skills.",
			"Reads the orchestrator index (skill-orchestrator/skills.index.json), matches its deterministic triggers, and returns",
			"which skill(s) to use, in what order, with each step's inputs / hard gates / known gaps / execution mode.",
			"This tool does NOT execute anything: `execution: cli` steps are run through the matching CLI, `plugin` steps through this",
			"plugin's own tools, and `agent` steps by following that skill's SKILL.md (sub-agents allowed).",
			"When `needsClarification` is true the plan is incomplete on purpose — ask the user the returned `clarify` questions first."
		]),
		parameters: {
			request: {
				type: "string",
				required: true,
				description: "What the user wants, in their own words (Chinese or English; matching is on the index's trigger keywords)."
			},
			cwd: {
				type: "string",
				description: "Working directory used to locate the project skill root. Defaults to the session's working directory."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					confidence: { type: "number", required: true },
					needsClarification: { type: "boolean", required: true },
					clarify: { type: "array", required: true, items: { type: "string" } },
					matched: { type: "array", required: true, items: { type: "string" } },
					plan: { type: "string", required: true },
					indexFile: { type: "string", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const route = await routeRequest({
				request: args.request,
				cwd: args.cwd !== undefined ? resolvePath(expandTilde(args.cwd)) : cwdOf(exec),
				config: cfg
			});
			const planJson = JSON.stringify(
				{ confidence: route.confidence, needsClarification: route.needsClarification, clarify: route.clarify, plan: route.plan, matched: route.matched, note: route.note },
				null,
				2
			);
			const planLines = route.plan.length === 0
				? "  (no step — resolve the questions first)"
				: route.plan.map((s) => `  ${s.step}. ${s.skill}  [${s.execution}]  ${s.why}`).join("\n");
			const clarifyLines = route.clarify.map((c) => `  ? ${c.question}${c.options?.length ? `\n      options: ${c.options.join(" / ")}` : ""}`).join("\n");
			return {
				confidence: route.confidence,
				needsClarification: route.needsClarification,
				clarify: route.clarify.map((c) => `${c.question}${c.options?.length ? ` [${c.options.join(" / ")}]` : ""}`),
				matched: route.matched.map((m) => `${m.id}(${m.kind},${m.score})`),
				plan: planJson,
				indexFile: route.indexFile ?? "(not found)",
				summary: lines([
					route.ok ? `Routing "${args.request}" — confidence ${route.confidence}` : `Routing failed: ${route.reason}`,
					`Index: ${route.indexFile ?? "(skill-orchestrator/skills.index.json not found)"}`,
					"Plan:",
					planLines,
					clarifyLines ? "Needs clarification (ask the user):" : "",
					clarifyLines,
					route.note ?? ""
				])
			};
		},
		presentCall: (args) => ({ card: "generic", title: "Route request", kind: "other", rawInput: args.request })
	}));

	/* ---------------- distill_evolve ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_evolve",
		description: lines([
			"Evolve an EXISTING skill with a Markdown document instead of creating a new skill.",
			"This is the DETERMINISTIC half of an evolution round: it validates the skill, refuses to run outside a git repository",
			"(unless `gitInit`), derives a `test-prompts.json` skeleton when none exists, creates the `auto-optimize/<stamp>` branch with a",
			"baseline commit, merges the material (archive + `references/` + one idempotent marker entry), and writes the evaluation ticket",
			"(`evolution/<run-id>/plan.md` + `results.tsv`) the agent runs darwin against.",
			"The judgement stays with the agent: use `finalize: true` with `runId` and `decision` to archive the round afterwards.",
			"Use `dryRun: true` to preview the rewritten SKILL.md without writing a branch, skeleton, or ticket."
		]),
		parameters: {
			skill: {
				type: "string",
				required: true,
				description: "Skill id as it appears in the catalog (searched across the DSH skill roots), or an explicit skill directory path."
			},
			from: {
				type: "string",
				description: "Absolute path of the Markdown document to merge. Provide either `from` or `text`."
			},
			text: {
				type: "string",
				description: "Inline Markdown content to merge. Provide either `from` or `text`."
			},
			slug: {
				type: "string",
				description: "Reference file name (kebab-case) under references/. Defaults to a slug of the source name."
			},
			dryRun: {
				type: "boolean",
				description: "Preview the rewritten SKILL.md without writing the backup, reference, or main file."
			},
			gitInit: {
				type: "boolean",
				description: "Create a git repository in the skill directory when it is not inside one. Defaults to false, in which case a skill outside a repository is refused (the round could not be reverted)."
			},
			judges: {
				type: "integer",
				description: "Number of independent judges the evaluation ticket asks for. Defaults to 3; an even value is raised to the next odd number."
			},
			finalize: {
				type: "boolean",
				description: "Archive one evaluation round instead of merging material. Requires `runId` and `decision`."
			},
			runId: {
				type: "string",
				description: "Evaluation run to finalize (for example `run-20260929-1712`), as printed by the evolve call."
			},
			decision: {
				type: "string",
				enum: ["keep", "revert"],
				description: "The agent's verdict for the finalized round. `revert` is reported as a git command, never executed."
			},
			note: {
				type: "string",
				description: "Free-form note stored with the finalized round (what changed, why keep/revert)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					skillName: { type: "string", required: true },
					skillDir: { type: "string", required: true },
					referenceRel: { type: "string", required: true },
					backupPath: { type: "string", required: true },
					dryRun: { type: "boolean", required: true },
					replacedBlock: { type: "boolean", required: true },
					preview: { type: "string", required: true },
					branch: { type: "string", required: true },
					repoRoot: { type: "string", required: true },
					runId: { type: "string", required: true },
					runDir: { type: "string", required: true },
					planPath: { type: "string", required: true },
					resultsPath: { type: "string", required: true },
					testPrompts: { type: "string", required: true },
					judgeCount: { type: "integer", required: true },
					decision: { type: "string", required: true },
					judgedRows: { type: "integer", required: true },
					resultPath: { type: "string", required: true },
					gitCommand: { type: "string", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const skillDir = resolveSkillDir(args.skill, cwd, cfg);
			if (skillDir === undefined) {
				throw new Error(`skill "${args.skill}" not found in any DSH skill root (or it has no SKILL.md). Run distill_list to see the roots.`);
			}
			const empty = {
				skillName: basename(skillDir),
				skillDir,
				referenceRel: "",
				backupPath: "",
				dryRun: false,
				replacedBlock: false,
				preview: "",
				branch: "",
				repoRoot: "",
				runId: "",
				runDir: "",
				planPath: "",
				resultsPath: "",
				testPrompts: "",
				judgeCount: 0,
				decision: "",
				judgedRows: 0,
				resultPath: "",
				gitCommand: ""
			};

			if (args.finalize === true) {
				const finalized = await finalizeEvolution({
					skillDir,
					runId: args.runId,
					decision: args.decision ?? "keep",
					note: args.note
				});
				return {
					...empty,
					runId: finalized.runId,
					decision: finalized.decision,
					judgedRows: finalized.judgedRows,
					resultPath: finalized.resultPath,
					resultsPath: finalized.resultsFile,
					gitCommand: finalized.gitCommand ?? "",
					summary: lines([
						`Finalized ${finalized.runId}: ${finalized.decision} (${finalized.judgedRows} judged rows).`,
						`Result: ${finalized.resultPath}`,
						finalized.gitCommand
							? `To revert, run where the skill lives: ${finalized.gitCommand} (the plugin never rewrites history for you).`
							: "Kept in place; no git action needed.",
						"Next: distill_list {generated:true} shows the recorded run."
					])
				};
			}

			if (args.from === undefined && args.text === undefined) {
				throw new Error("provide either `from` (a Markdown file path) or `text` (inline Markdown)");
			}
			const sourceLabel = args.from !== undefined ? resolvePath(expandTilde(args.from)) : "(inline)";
			const referenceContent = args.from !== undefined ? await readFile(sourceLabel, "utf8") : args.text;
			const runner = createSubprocessRunner(ctx);
			if (runner === undefined && args.dryRun !== true) {
				throw new Error("the subprocess service is unavailable in this profile, so the git pre-flight cannot run; use dryRun to preview, or run the bundled CLI");
			}
			const result = await evolveSkill({
				skillDir,
				referenceContent,
				sourceLabel,
				slug: args.slug,
				dryRun: args.dryRun === true,
				runner,
				gitInit: args.gitInit === true,
				judges: args.judges ?? 3
			});
			return {
				...empty,
				skillName: result.skillName,
				referenceRel: result.referenceRel,
				backupPath: result.backupPath ?? "",
				dryRun: result.dryRun,
				replacedBlock: result.replacedBlock ?? false,
				preview: result.preview ?? "",
				branch: result.branch ?? "",
				repoRoot: result.repoRoot ?? "",
				runId: result.runId ?? "",
				runDir: result.runDir ?? "",
				planPath: result.planPath ?? "",
				resultsPath: result.resultsPath ?? "",
				testPrompts: result.testPrompts ?? "",
				judgeCount: result.judgeCount ?? 0,
				summary: result.dryRun
					? lines([
							`DRY RUN — would evolve "${result.skillName}" with ${result.referenceBytes} bytes.`,
							`Reference: ${result.referenceRel}`,
							"Nothing was written (no branch, no skeleton, no ticket)."
						])
					: lines([
							`Evolved "${result.skillName}" with ${result.referenceBytes} bytes on branch ${result.branch}.`,
							`Reference: ${result.referenceRel}; previous SKILL.md archived at ${result.backupPath}`,
							result.testPrompts ? `test-prompts.json skeleton written — rewrite it before judging: ${result.testPrompts}` : "test-prompts.json already existed and was left alone.",
							`Evaluation ticket: ${result.planPath} (${result.judgeCount} judges, odd) with ${result.resultsPath}`,
							`When judging is done: distill_evolve {skill:"${args.skill}", finalize:true, runId:"${result.runId}", decision:"keep"|"revert"}.`
						])
			};
		},
		presentCall: (args) => ({ card: "generic", title: args?.finalize === true ? "Finalize evolution round" : "Evolve skill from document", kind: "other", rawInput: args.skill })
	}));

	/* ---------------- distill_cangjie ---------------- */
	ctx.tools.register(defineTool({
		name: "distill_cangjie",
		description: lines([
			"Compile a verified cangjie Capability Bundle into a real, installable DSH skill — the deterministic half of cangjie's pipeline.",
			"Runs `uv run --with pyyaml python cangjie.py compile` through the platform subprocess seam, validates the produced SKILL.md,",
			"copies the skill into a DSH skill root (default: the user root), and records provenance so it shows up in distill_list {generated:true}.",
			"The SEMANTIC half (reading a book, extracting capabilities into the bundle) stays with the agent: this tool starts from an",
			"already-verified bundle, exactly as the cangjie CLI requires.",
			"Use `install: false` to build without installing, and `overwrite: true` to replace an existing skill of the same name."
		]),
		parameters: {
			bundle: {
				type: "string",
				required: true,
				description: "Absolute path to the verified Capability Bundle directory (the one containing verified.yaml)."
			},
			variant: {
				type: "string",
				description: "Output variant: single (one skill), pack (router + promoted skills), or auto. Default single."
			},
			purpose: {
				type: "string",
				description: "Output purpose: learning, reference, workflow, or distribution. Default learning."
			},
			out: {
				type: "string",
				description: "Directory to publish into. Defaults to a fresh temp directory."
			},
			target: {
				type: "string",
				description: "Where to install: user (default, $DSH_HOME/skills) or project (<cwd>/.dsh/skills)."
			},
			install: {
				type: "boolean",
				description: "Set false to compile only and report the artifact without copying it into a skill root."
			},
			overwrite: {
				type: "boolean",
				description: "Replace an existing skill with the same name. Default false (refuses and lists the conflict)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					exitCode: { type: "integer", required: true },
					cli: { type: "string", required: true },
					outDir: { type: "string", required: true },
					elapsedMs: { type: "integer", required: true },
					installed: { type: "array", required: true, items: { type: "string" } },
					rejected: { type: "array", required: true, items: { type: "string" } },
					skillRoot: { type: "string", required: true },
					stdoutTail: { type: "string", required: true },
					summary: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		},
		async execute(args, exec) {
			const cwd = cwdOf(exec);
			const cli = resolveCangjieCli(cwd, cfg);
			if (cli === undefined) {
				throw new Error(
					"cangjie CLI not found (scripts/cangjie.py). Install cangjie-skill into a skill root, or set config.cangjieCli / $CANGJIE_CLI."
				);
			}
			const runner = createSubprocessRunner(ctx);
			if (runner === undefined) {
				throw new Error("the subprocess service is unavailable in this profile, so the cangjie CLI cannot be run");
			}
			const bundleDir = resolvePath(expandTilde(args.bundle));
			if (!existsSync(bundleDir)) throw new Error(`bundle directory not found: ${bundleDir}`);
			const outDir = args.out !== undefined ? resolvePath(expandTilde(args.out)) : join(tmpdir(), `dsh-distill-${Date.now()}`);
			const variant = args.variant ?? "single";
			const purpose = args.purpose ?? "learning";

			const result = await runCangjieCompile({
				runner,
				cli,
				bundleDir,
				outDir,
				variant,
				purpose,
				cwd,
				timeoutMs: cfg.cangjieTimeoutMs,
				command: cfg.cangjieUv
			});
			if (result.code !== 0) {
				const detail = String(result.stderr ?? "").split("\n").slice(-8).join("\n");
				throw new Error(`cangjie compile failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}):\n${detail}`);
			}
			const found = await findCompiledSkills(outDir);
			let installed = [];
			let rejected = found.filter((f) => !f.valid).map((f) => `${f.name}: ${f.reason}`);
			let skillRoot = "";
			if (args.install !== false) {
				const outcome = await installCompiledSkills({
					outDir,
					target: args.target ?? "user",
					cwd,
					config: cfg,
					overwrite: args.overwrite === true,
					sourceLabel: bundleDir,
					variant
				});
				installed = outcome.installed;
				rejected = outcome.rejected.map((r) => `${r.name}: ${r.reason}`);
				skillRoot = outcome.root;
			}
			const stdoutTail = String(result.stdout ?? "").split("\n").filter((l) => l.trim().length > 0).slice(-3).join("\n");
			return {
				exitCode: result.code ?? 0,
				cli,
				outDir,
				elapsedMs: result.elapsedMs,
				installed: installed.map((i) => i.name),
				rejected,
				skillRoot,
				stdoutTail,
				summary: lines([
					`cangjie compile (${variant}/${purpose}) → exit ${result.code} in ${result.elapsedMs}ms`,
					stdoutTail,
					installed.length > 0
						? `Installed ${installed.length} skill(s): ${installed.map((i) => i.name).join(", ")} → ${skillRoot}`
						: "Compiled only (install disabled).",
					installed.length > 0 ? `Load with the skill tool: ${installed.map((i) => `skill("${i.name}")`).join(", ")}` : "",
					rejected.length > 0 ? `Rejected: ${rejected.join("; ")}` : ""
				])
			};
		},
		presentCall: (args) => ({ card: "generic", title: "Compile cangjie bundle", kind: "other", rawInput: args.bundle })
	}));
}

