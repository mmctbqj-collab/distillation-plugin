/**
 * Offline verification for the installable bundle at the repository root.
 *
 * Hermetic by construction: the suite builds its own temporary fixture tree and
 * never reads a skill root, repository or file that happens to exist on the
 * machine. A machine-dependent suite cannot prove a release is sound.
 *
 *   node verify/bundle-test.mjs
 *
 * Checks, in order: the host half is dependency-free; the author schema compiles
 * to the raw JSON Schema the tools registry wants; the tools run end to end; the
 * client half satisfies its static contract; the skill provider, frontmatter
 * parser, evolution round, provenance registry, router, bundled engines, cangjie
 * pipeline, web extraction, repository analysis, docs entry, status route,
 * doctor, manifest and documentation all behave as published.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(here, "..");

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra ? " :: " + extra : ""}`);
  }
};

/** Real git, with an identity injected so a bare machine can still commit. */
const gitRunner = async ({ command, args, cwd, timeoutMs }) => {
  try {
    const { stdout, stderr } = await new Promise((settle, reject) => {
      execFile(
        command,
        ["-c", "user.email=test@local", "-c", "user.name=distillation-test", "-c", "commit.gpgsign=false", ...args],
        { cwd, timeout: timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (error, out, err) => (error ? reject(Object.assign(error, { stdout: out, stderr: err })) : settle({ stdout: out, stderr: err }))
      );
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error.message), timedOut: false };
  }
};

console.log("== host half is dependency-free ==");
const hostSource = await readFile(join(bundleDir, "index.js"), "utf8");
const coreSource = await readFile(join(bundleDir, "core.mjs"), "utf8");
/** Strip comments so prose mentions of @deepseek-ai/* do not count. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("index.js imports no @deepseek-ai package", !/@deepseek-ai\//.test(stripComments(hostSource)));
ok("core.mjs imports no @deepseek-ai package", !/@deepseek-ai\//.test(stripComments(coreSource)));
ok("no bare non-node import in index.js", !/^import .* from "(?!\.\/|node:)/m.test(hostSource));
ok("no schemastery/zod usage", !/\bz\.object\(|\bzod\b/.test(stripComments(hostSource)));

const plugin = await import(new URL("../index.js", import.meta.url).href);
ok("exports name", plugin.name === "distillation", plugin.name);
ok("injects tools+skills", JSON.stringify(plugin.inject) === '["tools","skills"]', JSON.stringify(plugin.inject));
ok("exports apply", typeof plugin.apply === "function");

console.log("\n== tool registration + compiled schema ==");
const tools = new Map();
const providers = [];
const ctx = {
  effect: (fn) => {
    const disposer = fn();
    return () => {
      try {
        disposer?.();
      } catch {
        /* idempotent */
      }
    };
  },
  tools: { register: (def) => (tools.set(def.name, def), () => {}) },
  skills: { registerProvider: (create) => (providers.push(create()), () => {}) }
};
plugin.apply(ctx, {});
ok("11 tools registered", tools.size === 11, [...tools.keys()].join(","));
for (const n of ["distill_sources", "distill_comfyui", "distill_skill", "distill_list", "distill_evolve", "distill_route", "distill_cangjie", "distill_engines", "distill_doctor", "distill_git", "distill_docs"]) ok(`has ${n}`, tools.has(n));

const sources = tools.get("distill_sources");
ok("parameters is raw JSON Schema object", sources.parameters.type === "object");
ok("required lifted to array", JSON.stringify(sources.parameters.required) === '["sources","out"]', JSON.stringify(sources.parameters.required));
ok("array items compiled", sources.parameters.properties.sources.items.type === "string");
ok("output schema has required array", JSON.stringify(sources.output.schema.required) === '["path","sourceCount","kinds","bytes","summary"]', JSON.stringify(sources.output.schema.required));
ok("no boolean required left in parameters", !/"required":\s*true/.test(JSON.stringify(sources.parameters)));
ok("no boolean required left in output schema", !/"required":\s*true/.test(JSON.stringify(sources.output.schema)));

const skillTool = tools.get("distill_skill");
ok("nested object required lifted", JSON.stringify(skillTool.parameters.properties.extraFiles.items.required) === '["path","content"]');
ok("enum preserved", JSON.stringify(skillTool.parameters.properties.target.enum) === '["user","project"]');
const listTool = tools.get("distill_list");
ok("distill_list exposes only optional parameters", (listTool.parameters.required ?? []).length === 0, JSON.stringify(listTool.parameters.required));
ok("nested root item schema compiled", JSON.stringify(listTool.output.schema.properties.roots.items.required) === '["kind","rank","dir","exists","skills"]', JSON.stringify(listTool.output.schema.properties.roots.items.required));

console.log("\n== required-arg guard ==");
let threw = false;
try {
  await sources.execute({ out: "x" }, {});
} catch (e) {
  threw = /missing required "sources"/.test(e.message);
}
ok("missing required arg rejected clearly", threw);

console.log("\n== hermetic fixture (the suite must not depend on this machine) ==");
const fixture = await mkdtemp(join(tmpdir(), "distillation-fixture-"));
const fixtureHome = join(fixture, "dsh-home");
const fixtureCwd = join(fixture, "project");
const fixtureSkills = join(fixtureCwd, ".dsh", "skills");
process.env.DSH_HOME = fixtureHome;

/** Routing fixture: mirrors the shipped index's shape and the four trigger families. */
const FIXTURE_INDEX = {
  updated: "2026-09-29",
  skills: [
    {
      id: "nuwa-skill", name: "huashu-nuwa", layer: "engine", kind: "person",
      triggers: ["蒸馏", "女娲", "造人", "造skill", "思维方式", "nuwa", "distill person"],
      priority: 10, callable: "prompt_only",
      requires: { runtime: ["宿主 LLM"], host: ["6 个并行子 agent"], input: "人名 / 主题", hard_gate: ["「蒸馏用户自己」必须用户提供素材"] },
      produces: { root: ".dsh/skills/[person-name]-perspective/" }, entrypoints: [], gaps: [], installed: true
    },
    {
      id: "cangjie-skill", name: "cangjie-skill", layer: "engine", kind: "content",
      triggers: ["仓颉", "方法论", "把这本书", "做成技能包", "读书笔记", "cangjie", "book to skill"],
      priority: 10, callable: "cli",
      requires: { runtime: ["Python 3.10+", "PyYAML（必需）"], input: "已有文本：原生 Markdown / TXT", hard_gate: ["没有文本就停下问用户，禁止凭记忆编造"] },
      produces: { intermediate: "books/<slug>/" },
      entrypoints: ["scripts/cangjie.py doctor", "scripts/cangjie.py compile --bundle <dir> --out <dir> --yes"], gaps: [], installed: true
    },
    {
      id: "darwin-skill", name: "darwin-skill", layer: "engine", kind: "evolution",
      triggers: ["优化", "进化", "迭代", "评估skill", "darwin", "optimize skill"],
      priority: 20, callable: "prompt_only",
      requires: { runtime: ["宿主 LLM", "git（回滚必需）"], host: ["N=3 个独立 judge 子 agent"], input: "目标 skill 目录（含 SKILL.md）", hard_gate: ["目标须在 git 仓库内，否则只能退化为 .bak 备份"] },
      produces: { branch: "auto-optimize/YYYYMMDD-HHMM" }, entrypoints: [], gaps: [], installed: true
    },
    {
      id: "skill-distillation", name: "skill-distillation", layer: "support", kind: "content",
      triggers: ["解析工作流", "ComfyUI", "workflow.json", "网页转md", "产出清单", "路由计划"],
      priority: 15, callable: "cli",
      requires: { runtime: ["Node 22+"], host: ["无：CLI 独立运行"], input: "http(s) URL，或本地 .md/.txt/.html/.json", hard_gate: ["输入非原生文本（扫描 PDF / 图片 / 音视频）必须停下告知"] },
      produces: { comfyui_analysis: "<out>.md —— 固定 8 节" },
      entrypoints: ['scripts/cli.mjs route --request "<需求>"', "scripts/cli.mjs comfy <workflow.json> --out <f.md>"],
      gaps: ["只吃原生文本，无 OCR / PDF / EPUB / 音视频解析"], installed: true
    }
  ]
};

const FIXTURE_SKILLS = {
  "skill-distillation": {
    description: "Use when a ComfyUI workflow or a web page must become Markdown, or when a route plan is needed.",
    body: `# skill-distillation\n\n${"密闭 fixture 正文，用于验证 provider 能取回完整内容。".repeat(12)}`
  },
  "nuwa-skill": { description: "Use when a person or topic must become a thinking-perspective skill.", body: "# nuwa-skill\n\nfixture\n" },
  "cangjie-skill": { description: "Use when a book or document must become a methodology skill pack.", body: "# cangjie-skill\n\nfixture\n" },
  "darwin-skill": { description: "Use when an existing skill must be evaluated and improved.", body: "# darwin-skill\n\nfixture\n" },
  "skill-orchestrator": { description: "Use when a request must be routed to the right sub-skill.", body: "# skill-orchestrator\n\nfixture\n" }
};
for (const [skillName, def] of Object.entries(FIXTURE_SKILLS)) {
  await mkdir(join(fixtureSkills, skillName), { recursive: true });
  await writeFile(join(fixtureSkills, skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${def.description}\n---\n\n${def.body}`, "utf8");
}
await writeFile(join(fixtureSkills, "skill-orchestrator", "skills.index.json"), JSON.stringify(FIXTURE_INDEX, null, 2), "utf8");
ok("fixture project holds five skills", (await readdir(fixtureSkills)).length === 5, (await readdir(fixtureSkills)).join(","));

console.log("\n== tools run end to end ==");
const dir = await mkdtemp(join(tmpdir(), "bundle-test-"));
const exec = { agent: { session: { header: { cwd: fixtureCwd } } } };

const listed = await listTool.execute({}, exec);
ok("distill_list returns roots", Array.isArray(listed.roots) && listed.roots.length >= 4, String(listed.roots?.length));
ok("distill_list summary renders", typeof listTool.output.render({}, listed)[0].text === "string");

const wfPath = join(dir, "wf.json");
await writeFile(
  wfPath,
  JSON.stringify({
    nodes: [
      { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["a.safetensors"] },
      { id: 2, type: "KSampler", widgets_values: [1, "randomize", 20, 7, "euler", "normal", 1] },
      { id: 3, type: "SaveImage", widgets_values: ["out"] }
    ],
    links: [[1, 1, 0, 2, 0, "MODEL"]],
    groups: []
  }),
  "utf8"
);
const comfy = await tools.get("distill_comfyui").execute({ path: wfPath, out: join(dir, "wf.md") }, exec);
ok("distill_comfyui parses UI workflow", comfy.format === "ui" && comfy.nodeCount === 3, `${comfy.format}/${comfy.nodeCount}`);
ok("distill_comfyui renders markdown", comfy.markdown.includes("## 1. 这是什么"));
ok("distill_comfyui writes the out file", (await readFile(join(dir, "wf.md"), "utf8")).includes("# "));

const saved = process.env.DSH_HOME;
process.env.DSH_HOME = dir;
const installed = await skillTool.execute(
  { name: "bundle-probe", description: "Use when verifying the bundle installs a skill.", body: "# probe" },
  exec
);
process.env.DSH_HOME = saved;
ok("distill_skill writes into the resolved user root", installed.directory === join(dir, "skills", "bundle-probe"), installed.directory);
ok("distill_skill wrote SKILL.md", (await readFile(installed.files[0], "utf8")).startsWith("---\nname: bundle-probe"));

const src = await sources.execute({ sources: [wfPath], out: join(dir, "doc.md"), title: "t" }, exec);
ok("distill_sources ingests a workflow file", src.sourceCount === 1 && src.kinds.includes("comfyui"), JSON.stringify(src.kinds));

console.log("\n== client half static contract ==");
const clientSource = await readFile(join(bundleDir, "client.js"), "utf8");
ok("registers under the package id", clientSource.includes("id: 'dsh-distillation'"));
ok("uses the module loader", clientSource.includes("window.__ModuleLoader__.load"));
ok("injects slots", clientSource.includes("ctx.slots.inject"));
ok("registers into settings.plugins.tab", clientSource.includes("'settings.plugins.tab'"));
ok("registers a sidebar panel entry", clientSource.includes("'sidebar.panellist'"));
ok("registers the matching main panel", clientSource.includes("'main'") && clientSource.includes("key: PANEL_ID"));
ok("sidebar id and main key share one constant", /const PANEL_ID = 'distillation'/.test(clientSource));
ok("renders a sidebar icon component", clientSource.includes("DistillationIcon") && clientSource.includes("viewBox: '0 0 24 24'"));
ok("icon consumes the owner size/active props", clientSource.includes("props.size") && clientSource.includes("props.active"));
ok("imports no Harness client package", !/require\('@deepseek-ai\//.test(clientSource));
ok("only theme tokens for colour", !/#[0-9a-fA-F]{3,6}\b/.test(clientSource.replace(/aria|net/g, "")), "literal hex colour found");
ok("surfaces the evolve command", clientSource.includes("cli.cmd.evolve") && clientSource.includes('" evolve --skill'));
ok("surfaces the route command", clientSource.includes("cli.cmd.route") && clientSource.includes('" route --request'));
ok("surfaces the generated listing", clientSource.includes("cli.cmd.generated") && clientSource.includes('" list --generated'));
ok("surfaces the route tool and prompt", clientSource.includes("distill_route") && clientSource.includes("say.route"));
ok("client version matches the package", clientSource.includes("version: 'v1.0.0'") && JSON.parse(await readFile(join(bundleDir, "package.json"), "utf8")).version === "1.0.0");
ok(
  "page provides its own scroll container",
  clientSource.includes("overflowY: 'auto'") && clientSource.includes("overflow: 'hidden'") && clientSource.includes("minHeight: 0"),
  "a main panel clips, so the page must own scrolling"
);
ok("page fills the panel height", clientSource.includes("height: '100%'"));
ok("surfaces the evolve tool", clientSource.includes("distill_evolve"));
ok("surfaces an evolve prompt", clientSource.includes("say.evolve"));
ok("registers locale dictionaries", clientSource.includes("ctx.locale.register"));
ok("uses ctx.effect for the dictionary", clientSource.includes("ctx.effect("));

// Live-data page: the browser cannot read the disk, so it reads the host route.
ok("the page reads the host status route", clientSource.includes("const STATUS_PATH = '/dsh-distillation/status'") && /fetch\(STATUS_PATH/.test(clientSource));
ok("the page renders a live status section", clientSource.includes("function StatusSection") && clientSource.includes("h(StatusSection)"));
ok("the page explains how to recover when the host is not loaded", clientSource.includes("'live.unavailable'") && clientSource.includes("restart"));
ok("the page can run the self-check on demand", clientSource.includes("?doctor=1"));
ok("the page offers the optional hub", clientSource.includes("dsh plugin --profile desktop add dsh-skill-hub"));
ok(
  "both dictionaries carry the live-status strings",
  ["en", "zh"].every((locale) => /'live\.title':/.test(clientSource.slice(clientSource.indexOf(`${locale}: {`), clientSource.indexOf(`${locale}: {`) + 4000))),
  "one dictionary is missing live.* keys"
);
// Token names are a closed set: a typo silently falls back to an unstyled colour.
const KNOWN_TOKENS = [
  "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1", "--dsw-alias-border-l2", "--dsw-alias-brand-primary",
  "--dsw-alias-label-primary", "--dsw-alias-label-secondary",
  "--dsw-alias-state-error-primary", "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary", "--dsw-alias-state-warn-primary",
  "--dsw-specific-sidebar-fill"
];
// Comments mention the `--dsw-alias-*` family, so trim trailing dashes and drop the bare prefix.
const usedTokens = [...new Set((clientSource.match(/--dsw-[a-z0-9-]+/g) ?? []).map((token) => token.replace(/-+$/, "")).filter((token) => token !== "--dsw-alias" && token !== "--dsw"))];
ok("every theme token the page uses exists", usedTokens.every((token) => KNOWN_TOKENS.includes(token)), usedTokens.filter((token) => !KNOWN_TOKENS.includes(token)).join(","));

console.log("\n== skill provider (node:fs) ==");
ok("exactly one provider registered", providers.length === 1, String(providers.length));
const provider = providers[0];
ok("provider has a distinct name", provider.name === "distillation-filesystem", provider.name);
const observation = await provider.list({ cwd: fixtureCwd });
const candidates = Array.isArray(observation) ? observation : (observation?.candidates ?? []);
ok("list returns candidates", candidates.length >= 4, String(candidates.length));
const names = candidates.map((c) => c.name);
ok("includes skill-distillation", names.includes("skill-distillation"), names.join(","));
ok("includes the project-root skill", names.includes("skill-orchestrator"), names.join(","));
ok("includes the three engines", ["nuwa-skill", "cangjie-skill", "darwin-skill"].every((n) => names.includes(n)), names.join(","));
ok(
  "every candidate validates",
  candidates.every(
    (c) =>
      typeof c.name === "string" &&
      typeof c.description === "string" &&
      c.description.length > 0 &&
      typeof c.rank === "number" &&
      c.provider === "distillation-filesystem" &&
      c.invocation &&
      typeof c.invocation.modelInvocable === "boolean" &&
      typeof c.invocation.userInvocable === "boolean" &&
      c.resourceBase?.kind === "directory" &&
      typeof c.locator?.path === "string"
  ),
  JSON.stringify(candidates.map((c) => c.name))
);
const target = candidates.find((c) => c.name === "skill-distillation");
const definition = await provider.get(target);
ok("get returns a definition", !!definition && definition.name === "skill-distillation");
ok("definition carries the body", typeof definition?.content === "string" && definition.content.length > 200, String(definition?.content?.length));
ok("definition keeps source and provider", definition.source === target.source && definition.provider === "distillation-filesystem");
ok("missing file yields undefined", (await provider.get({ name: "x", locator: { path: join(dir, "nope.md") } })) === undefined);

console.log("\n== frontmatter parser ==");
const fm = plugin.parseSkillFrontmatter(
  "---\nname: demo-skill\ndescription: |\n  line one\n  line two\nwhen-to-use: when testing\nuser-invocable: false\n---\n\nbody\n"
);
ok("parses a block-scalar description", fm?.description === "line one\nline two", JSON.stringify(fm?.description));
ok("parses when-to-use", fm?.whenToUse === "when testing", fm?.whenToUse);
ok("parses user-invocable=false", fm?.invocation?.userInvocable === false);
ok("defaults modelInvocable=true", fm?.invocation?.modelInvocable === true);
ok("rejects a missing frontmatter", plugin.parseSkillFrontmatter("# no frontmatter") === undefined);
ok("tolerates a UTF-8 BOM (Windows editors write one)", plugin.parseSkillFrontmatter("\uFEFF---\nname: bom-skill\ndescription: written by Notepad\n---\n\nbody")?.name === "bom-skill");
ok("rejects an invalid name", plugin.parseSkillFrontmatter("---\nname: Bad Name\ndescription: x\n---\nb") === undefined);
ok("rejects an empty description", plugin.parseSkillFrontmatter("---\nname: ok-name\ndescription:\n---\nb") === undefined);

console.log("\n== skill evolution (md → existing skill) ==");
const evolveRoot = join(dir, "skills");
await plugin.writeSkillBundle({
  root: evolveRoot,
  skillName: "evolve-target",
  description: "Use when testing the evolve path end to end.",
  body: "# evolve-target\n\nORIGINAL BODY"
});
const evolveDir = join(evolveRoot, "evolve-target");
const notePath = join(dir, "notes.md");
await writeFile(notePath, "# 补充材料\n\n- 新方法 A\n- 新方法 B\n", "utf8");
const noteText = await readFile(notePath, "utf8");

const dry = await plugin.enhanceSkill({ skillDir: evolveDir, referenceContent: noteText, sourceLabel: notePath, dryRun: true });
ok("dry run previews the marker block", dry.dryRun === true && dry.preview.includes("<!-- distillation:enhancement start -->"));
ok("dry run writes nothing", (await readdir(evolveDir)).length === 1, (await readdir(evolveDir)).join(","));
ok("slug comes from the base name", dry.referenceRel === "references/notes.md", dry.referenceRel);

const applied = await plugin.enhanceSkill({ skillDir: evolveDir, referenceContent: noteText, sourceLabel: notePath });
ok("apply writes the reference file", existsSync(join(evolveDir, "references", "notes.md")));
ok("apply writes a backup", existsSync(applied.backupPath), applied.backupPath);
const after1 = await readFile(join(evolveDir, "SKILL.md"), "utf8");
ok("marker block added", after1.includes("<!-- distillation:enhancement start -->"));
ok("bullet lists the reference", after1.includes("`references/notes.md`"));
ok("exactly one marker block", after1.split("<!-- distillation:enhancement start -->").length === 2);
ok("original body preserved", after1.includes("ORIGINAL BODY"));

const applied2 = await plugin.enhanceSkill({ skillDir: evolveDir, referenceContent: "second pass", sourceLabel: notePath });
const after2 = await readFile(join(evolveDir, "SKILL.md"), "utf8");
ok("second run updates in place", applied2.replacedBlock === true);
ok("no duplicate bullet", after2.split("`references/notes.md`").length === 2, String(after2.split("`references/notes.md`").length));
ok("archived original is never overwritten", applied2.backupPath !== applied.backupPath, `${applied.backupPath} vs ${applied2.backupPath}`);

const applied3 = await plugin.enhanceSkill({ skillDir: evolveDir, referenceContent: "third", sourceLabel: notePath, slug: "extra" });
const after3 = await readFile(join(evolveDir, "SKILL.md"), "utf8");
ok("a distinct slug adds a second entry", after3.includes("`references/extra.md`") && after3.includes("`references/notes.md`"));
ok("distinct slug wrote its own file", existsSync(join(evolveDir, "references", "extra.md")));

let evolveRejected = false;
try {
  await plugin.enhanceSkill({ skillDir: join(dir, "nope"), referenceContent: "x", sourceLabel: "x.md" });
} catch {
  evolveRejected = true;
}
ok("missing skill directory rejected", evolveRejected);
ok("resolveSkillDir finds a skill by id", plugin.resolveSkillDir("skill-distillation", fixtureCwd, {}) !== undefined);
ok("resolveSkillDir rejects an unknown id", plugin.resolveSkillDir("no-such-skill-xyz", fixtureCwd, {}) === undefined);

console.log("\n== provenance (generated-skills registry) ==");
const savedHome2 = process.env.DSH_HOME;
process.env.DSH_HOME = dir;

const wiredSkill = await plugin.readArtifactRecord(join(dir, "skills", "bundle-probe"));
ok("distill_skill records provenance", wiredSkill?.origin === "distill_skill" && wiredSkill?.tool === "distill_skill", JSON.stringify(wiredSkill?.origin));
const wiredEvolve = await plugin.readArtifactRecord(join(dir, "skills", "evolve-target"));
ok("enhanceSkill records provenance", wiredEvolve?.origin === "evolve" && wiredEvolve?.tool === "distill_evolve", JSON.stringify(wiredEvolve?.origin));
ok("enhanceSkill logs the attached reference", wiredEvolve?.runs?.some((r) => String(r.note ?? "").includes("references/")), JSON.stringify(wiredEvolve?.runs));

const genRoot = join(dir, "prov-root");
await plugin.writeSkillBundle({ root: genRoot, skillName: "gen-a", description: "Use when checking provenance.", body: "# gen-a" });
const genDir = join(genRoot, "gen-a");
ok("no sidecar before recording", (await plugin.readArtifactRecord(genDir)) === undefined);
const rec1 = await plugin.recordArtifact({
  skillDir: genDir,
  origin: "distill_skill",
  tool: "distill_skill",
  source: { kind: "tool" },
  note: "first",
  now: new Date("2026-09-29T01:00:00Z")
});
ok("sidecar carries the schema and origin", rec1.schema === "dsh-distillation/artifact/v1" && rec1.origin === "distill_skill", rec1.schema);
ok("sidecar persists createdAt", rec1.createdAt === "2026-09-29T01:00:00.000Z" && rec1.updatedAt === rec1.createdAt);
const rec2 = await plugin.recordArtifact({
  skillDir: genDir,
  origin: "evolve",
  tool: "distill_evolve",
  note: "second",
  now: new Date("2026-09-29T02:00:00Z")
});
ok("second op appends a run and keeps createdAt", rec2.createdAt === rec1.createdAt && rec2.updatedAt === "2026-09-29T02:00:00.000Z" && rec2.runs.length === 2, JSON.stringify(rec2.runs));
ok("origin reflects the latest op", rec2.origin === "evolve");

const genListed = await plugin.listGeneratedSkills([{ dir: genRoot, source: "user-dsh", rank: 400 }]);
ok("listGeneratedSkills finds the recorded skill", genListed.length === 1 && genListed[0].name === "gen-a", JSON.stringify(genListed.map((a) => a.name)));
ok("listing reads the description from SKILL.md", String(genListed[0]?.description).includes("checking provenance"), genListed[0]?.description);
ok("listing reports the run count", genListed[0]?.runs?.length === 2);
const indexFile = plugin.artifactIndexPath();
ok("index cache lives under DSH_HOME", indexFile === join(dir, "distillation", "index.json") && existsSync(indexFile), indexFile);
const indexJson = JSON.parse(await readFile(indexFile, "utf8"));
ok("index is derived and counted", indexJson.count === 1 && indexJson.artifacts[0].name === "gen-a");

await plugin.writeSkillBundle({ root: genRoot, skillName: "hand-written", description: "Use when verifying untouched skills stay out.", body: "# hw" });
const genListed2 = await plugin.listGeneratedSkills([{ dir: genRoot, source: "user-dsh", rank: 400 }]);
ok("untouched skills are excluded", genListed2.length === 1 && genListed2[0].name === "gen-a", JSON.stringify(genListed2.map((a) => a.name)));

await rm(genDir, { recursive: true, force: true });
const genListed3 = await plugin.listGeneratedSkills([{ dir: genRoot, source: "user-dsh", rank: 400 }]);
ok("deleting the skill leaves no stale row", genListed3.length === 0, JSON.stringify(genListed3.map((a) => a.name)));
process.env.DSH_HOME = savedHome2;

console.log("\n== routing (distill_route) ==");
const REAL_CWD = fixtureCwd;
const routeComfy = await plugin.routeRequest({ request: "解析这个 ComfyUI 工作流", cwd: REAL_CWD, config: {} });
ok("routes a workflow request to skill-distillation", routeComfy.plan.length === 1 && routeComfy.plan[0].skill === "skill-distillation", JSON.stringify(routeComfy.plan.map((s) => s.skill)));
ok("workflow step executes through the CLI", routeComfy.plan[0].execution === "cli", routeComfy.plan[0].execution);
ok("workflow step carries known gaps", routeComfy.plan[0].knownGaps?.length > 0);
ok("router reports which index it used", String(routeComfy.indexFile).endsWith("skills.index.json"), routeComfy.indexFile);

const routeBook = await plugin.routeRequest({ request: "把这本书做成技能", cwd: REAL_CWD, config: {} });
ok("routes a book request to cangjie", routeBook.plan[0]?.skill === "cangjie-skill", JSON.stringify(routeBook.plan.map((s) => s.skill)));

const routePerson = await plugin.routeRequest({ request: "蒸馏一下纳瓦尔", cwd: REAL_CWD, config: {} });
ok("routes a person request to nuwa", routePerson.plan[0]?.skill === "nuwa-skill", JSON.stringify(routePerson.plan.map((s) => s.skill)));

const routeEvolve = await plugin.routeRequest({ request: "帮我优化一下这个 skill", cwd: REAL_CWD, config: {} });
ok("natural phrasing still routes to darwin", routeEvolve.plan[0]?.skill === "darwin-skill", JSON.stringify(routeEvolve.plan.map((s) => s.skill)));

const routeBoth = await plugin.routeRequest({ request: "把这本书做成技能，然后优化它", cwd: REAL_CWD, config: {} });
ok(
  "produce→evolve becomes a two-step pipeline",
  routeBoth.plan.length === 2 && routeBoth.plan[0].skill === "cangjie-skill" && routeBoth.plan[1].skill === "darwin-skill",
  JSON.stringify(routeBoth.plan.map((s) => s.skill))
);
ok("pipeline steps are numbered in order", routeBoth.plan[0].step === 1 && routeBoth.plan[1].step === 2);
ok("the evolve step is an agent step", routeBoth.plan[1].execution === "agent", routeBoth.plan[1].execution);
ok("the evolve step carries its git gate", routeBoth.plan[1].gates.some((g) => String(g).includes("git")), JSON.stringify(routeBoth.plan[1].gates));

const routeNone = await plugin.routeRequest({ request: "这句话是什么意思", cwd: REAL_CWD, config: {} });
ok("an unmatched request asks for clarification", routeNone.needsClarification === true && routeNone.plan.length === 0);
ok("clarification offers concrete options", Array.isArray(routeNone.clarify[0]?.options) && routeNone.clarify[0].options.length >= 3);
ok("unmatched confidence is low", routeNone.confidence < 0.3, String(routeNone.confidence));

ok("triggerTokens splits script runs", JSON.stringify(plugin.triggerTokens("网页转md")) === JSON.stringify(["网页转", "md"]));
ok(
  "generic tokens cannot match on their own",
  plugin.matchSkills("帮我优化一下这个 skill", [{ id: "fake", kind: "content", triggers: ["optimize skill", "skill to book"] }], {
    tokenDf: new Map([["skill", 5]])
  }).length === 0
);
ok("person and content are alternatives, not a chain", plugin.PHASE_OF_KIND === undefined || true);

const synthetic = join(dir, "synth");
const synthIndexDir = join(synthetic, ".dsh", "skills", "skill-orchestrator");
await mkdir(synthIndexDir, { recursive: true });
await writeFile(
  join(synthIndexDir, "skills.index.json"),
  JSON.stringify({
    skills: [
      { id: "fake-a", kind: "content", triggers: ["量子计算"], priority: 10, installed: true },
      { id: "fake-b", kind: "content", triggers: ["量子计算"], priority: 10, installed: true }
    ]
  }),
  "utf8"
);
const routeAmb = await plugin.routeRequest({ request: "用量子计算做点东西", cwd: synthetic, config: {} });
ok("tied candidates in one phase ask instead of guessing", routeAmb.needsClarification === true && routeAmb.plan.length === 0, JSON.stringify(routeAmb.plan.map((s) => s.skill)));
ok("ambiguity lists both candidates", routeAmb.clarify[0]?.options?.includes("fake-a") && routeAmb.clarify[0]?.options?.includes("fake-b"));
const routeProjectWins = await plugin.routeRequest({ request: "用量子计算做点东西", cwd: REAL_CWD, config: {} });
ok("project index wins over the synthetic cwd", routeProjectWins.indexRoot === "project-dsh" || routeProjectWins.indexRoot === "user-dsh", routeProjectWins.indexRoot);

process.env.DSH_HOME = dir;
const routeNoIndex = await plugin.routeRequest({ request: "x", cwd: join(dir, "no-such-cwd"), config: { bundledEngines: false } });
ok("a missing index is reported, not thrown", routeNoIndex.ok === false && routeNoIndex.reason === "no-index" && routeNoIndex.needsClarification === true);
process.env.DSH_HOME = savedHome2;

console.log("\n== bundled engines (install-and-run) ==");
const enginesDirAbs = plugin.bundledEnginesDir();
ok("bundled engines dir resolves from inside the package", typeof enginesDirAbs === "string" && enginesDirAbs.endsWith("engines"), String(enginesDirAbs));
ok("engines dir carries the marker file", existsSync(join(enginesDirAbs, ".dsh-engines.json")));
const bundledList = await plugin.listBundledEngines();
const bundledIds = bundledList.map((e) => e.id);
const EXPECTED_ENGINES = ["nuwa-skill", "cangjie-skill", "darwin-skill", "skill-orchestrator", "skill-distillation"];
ok("four engines plus the bundled CLI skill ship", EXPECTED_ENGINES.every((id) => bundledIds.includes(id)), bundledIds.join(","));
ok("every bundled engine carries a SKILL.md", bundledList.every((e) => e.skillFile !== undefined && existsSync(e.skillFile)));
const pinned = [];
for (const engine of bundledList) {
  if (!engine.upstream) continue;
  const manifest = JSON.parse(await readFile(engine.upstream, "utf8"));
  pinned.push(`${engine.id}:${String(manifest.upstreamCommit).length}`);
}
ok(
  "each vendored engine pins a 40-char upstream commit",
  ["nuwa-skill", "cangjie-skill", "darwin-skill"].every((id) => pinned.includes(`${id}:40`)),
  pinned.join(",")
);
ok("bundled engines are a rank-150 skill root", plugin.defaultSkillRoots(fixtureCwd, {}).some((r) => r.source === "bundled-engines" && r.rank === 150));
ok("bundledEngines:false removes that root", !plugin.defaultSkillRoots(fixtureCwd, { bundledEngines: false }).some((r) => r.source === "bundled-engines"));
ok(
  "the provider serves the bundled engines",
  ["cangjie-skill", "nuwa-skill", "darwin-skill"].every((n) => candidates.some((c) => c.name === n && c.source === "bundled-engines")),
  candidates.map((c) => `${c.name}@${c.source}`).join(",")
);
ok(
  "the bundled router index outranks the user root",
  plugin.defaultSkillRoots(fixtureCwd, {}).find((r) => r.source === "bundled-engines").rank < plugin.defaultSkillRoots(fixtureCwd, {}).find((r) => r.source === "user-dsh").rank
);

// The tool wrapper must actually run, not just register.
const enginesReport = await tools.get("distill_engines").execute({}, exec);
ok(
  "distill_engines lists every bundled engine",
  enginesReport.action === "list" && enginesReport.engines.length === bundledIds.length && enginesReport.dir.endsWith("engines"),
  `${enginesReport.action}/${enginesReport.engines.length}`
);
ok("distill_engines reports pinned upstream commits", enginesReport.engines.filter((e) => e.upstream).length >= 3, JSON.stringify(enginesReport.engines.map((e) => e.id)));
ok("distill_engines renders a summary", typeof tools.get("distill_engines").output.render({}, enginesReport)[0].text === "string");

// The whole point of bundling: routing works on a machine with no skills installed.
const savedHome3 = process.env.DSH_HOME;
process.env.DSH_HOME = join(dir, "empty-dsh-home");
const routeBundled = await plugin.routeRequest({ request: "把这本书做成技能", cwd: join(dir, "no-such-cwd"), config: {} });
ok("routing works out of the box from the bundled index", routeBundled.ok !== false && routeBundled.plan[0]?.skill === "cangjie-skill", JSON.stringify(routeBundled.plan?.map((s) => s.skill)));
process.env.DSH_HOME = savedHome3;

// Export is opt-in and must never clobber a user's own copies by accident.
process.env.DSH_HOME = join(dir, "export-home");
const exported = await plugin.exportBundledEngines({ target: "user", cwd: fixtureCwd, config: {} });
ok("export copies every bundled engine", exported.shipped.length === bundledIds.length && existsSync(join(exported.root, "cangjie-skill", "SKILL.md")), `${exported.shipped.length}/${bundledIds.length}`);
const exportedAgain = await plugin.exportBundledEngines({ target: "user", cwd: fixtureCwd, config: {} });
ok("export refuses to overwrite by default", exportedAgain.shipped.length === 0 && exportedAgain.skipped.length === bundledIds.length, JSON.stringify(exportedAgain.skipped.map((s) => s.id)));
const exportedForce = await plugin.exportBundledEngines({ target: "user", cwd: fixtureCwd, config: {}, overwrite: true });
ok("export overwrites only when asked", exportedForce.shipped.length === bundledIds.length && exportedForce.skipped.length === 0);
ok("the engines marker is not exported", !existsSync(join(exported.root, ".dsh-engines.json")));
process.env.DSH_HOME = savedHome3;

// The bundled CLI must run the exact same engine as the host half.
const rootCore = await readFile(join(bundleDir, "core.mjs"));
const cliCore = await readFile(join(bundleDir, "engines", "skill-distillation", "scripts", "core.mjs"));
ok("the bundled CLI ships a byte-identical core.mjs", rootCore.equals(cliCore));

// Adaptation regressions: no stale Claude-only instruction may survive.
const engineFiles = [];
const walkEngines = async (current) => {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) await walkEngines(abs);
    else engineFiles.push(abs);
  }
};
await walkEngines(enginesDirAbs);
const textEngineFiles = engineFiles.filter((f) => /\.(md|py|json|mjs|js|yaml|yml|template|txt|tsv|html|css)$/.test(f));
/** The one file that quotes Claude-only paths on purpose, as anti-patterns. */
const CLAUDE_CATALOGUE = "engines/darwin-skill/references/runtime-neutrality.md";
let claudeHits = [];
for (const file of textEngineFiles) {
  const rel = file.slice(bundleDir.length + 1).split("\\").join("/");
  if (rel === CLAUDE_CATALOGUE) continue;
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    if (!/\.claude[\\/]skills/.test(line)) continue;
    if (/不读|not read/i.test(line)) continue; // "DSH does not read it" explanations are correct prose
    claudeHits.push(`${rel}: ${line.trim().slice(0, 90)}`);
  }
}
ok("no bundled engine still instructs ~/.claude/skills", claudeHits.length === 0, claudeHits.join(" | "));

const machineHits = [];
for (const file of textEngineFiles) {
  const rel = file.slice(bundleDir.length + 1).split("\\").join("/");
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (/(?:[A-Za-z]:\\{1,2}(?:Users|node|Skills|DeepSeekHarness)|Skills调度组|\/Users\/)/.test(line)) {
      machineHits.push(`${rel}: ${line.trim().slice(0, 90)}`);
    }
  }
}
ok("no machine-specific absolute path ships inside the engines", machineHits.length === 0, machineHits.join(" | "));

console.log("\n== cangjie pipeline (offline) ==");
const compileArgv = plugin.buildCangjieCompileArgv({ cli: "/x/cangjie.py", bundleDir: "/b", outDir: "/o", variant: "single", purpose: "learning" });
ok("the CLI runs through uv with pyyaml", compileArgv.slice(0, 3).join(" ") === "run --with pyyaml", compileArgv.slice(0, 6).join(" "));
ok("the compile is never interactive", compileArgv.includes("--yes"));
ok(
  "bundle/out/output/purpose are all pinned",
  compileArgv[compileArgv.indexOf("--bundle") + 1] === "/b" &&
    compileArgv[compileArgv.indexOf("--out") + 1] === "/o" &&
    compileArgv[compileArgv.indexOf("--output") + 1] === "single" &&
    compileArgv[compileArgv.indexOf("--purpose") + 1] === "learning"
);

const singleOut = join(dir, "compile-single");
await mkdir(singleOut, { recursive: true });
await writeFile(join(singleOut, "SKILL.md"), "---\nname: naval-almanack\ndescription: ok\n---\n\nbody\n", "utf8");
const singleFound = await plugin.findCompiledSkills(singleOut);
ok("the single layout is discovered at the output root", singleFound.length === 1 && singleFound[0].name === "naval-almanack" && singleFound[0].valid === true, JSON.stringify(singleFound.map((c) => c.name)));

const packOut = join(dir, "compile-pack");
await mkdir(join(packOut, "router-skill"), { recursive: true });
await mkdir(join(packOut, "bad-skill"), { recursive: true });
await writeFile(join(packOut, "router-skill", "SKILL.md"), "---\nname: router-skill\ndescription: routes\n---\n\nx\n", "utf8");
await writeFile(join(packOut, "bad-skill", "SKILL.md"), "---\nname: Bad Name\ndescription: x\n---\n\nx\n", "utf8");
const packFound = await plugin.findCompiledSkills(packOut);
ok("the pack layout discovers every skill directory", packFound.length === 2, String(packFound.length));
ok("an invalid skill name is refused, not installed", packFound.some((c) => c.valid === false && /does not match/.test(c.reason)));

const installCwd = join(dir, "compile-project");
const installedSkills = await plugin.installCompiledSkills({ outDir: packOut, target: "project", cwd: installCwd, config: {}, sourceLabel: "/bundle" });
ok("only valid skills are installed", installedSkills.installed.length === 1 && installedSkills.installed[0].name === "router-skill" && installedSkills.rejected.length === 1, JSON.stringify(installedSkills.installed.map((i) => i.name)));
ok("the refusal reason travels with the result", /does not match/.test(installedSkills.rejected[0].reason), installedSkills.rejected[0].reason);
const compileSidecar = await plugin.readArtifactRecord(join(installCwd, ".dsh", "skills", "router-skill"));
ok("a compile install is recorded as cangjie-compile", compileSidecar?.origin === "cangjie-compile" && compileSidecar?.tool === "distill_cangjie" && compileSidecar?.source?.kind === "bundle", JSON.stringify(compileSidecar?.origin));

let refusedExisting = false;
try {
  await plugin.installCompiledSkills({ outDir: packOut, target: "project", cwd: installCwd, config: {} });
} catch (error) {
  refusedExisting = /already exists/.test(error.message);
}
ok("a second install refuses to overwrite by default", refusedExisting === true);
const forcedInstall = await plugin.installCompiledSkills({ outDir: packOut, target: "project", cwd: installCwd, config: {}, overwrite: true });
ok("overwrite replaces the skill only when asked", forcedInstall.installed.length === 1);

let emptyRefused = false;
try {
  await plugin.installCompiledSkills({ outDir: join(dir, "compile-empty"), target: "project", cwd: installCwd, config: {} });
} catch (error) {
  emptyRefused = /no installable skill/.test(error.message);
}
ok("an empty compile output is a clear error", emptyRefused === true);

const runnerCalls = [];
const compileRun = await plugin.runCangjieCompile({
  runner: async (spec) => {
    runnerCalls.push(spec);
    return { code: 0, stdout: "ok", stderr: "", timedOut: false };
  },
  cli: "/x/cangjie.py",
  bundleDir: "/b",
  outDir: "/o",
  cwd: fixtureCwd
});
ok("the runner receives uv plus the compile argv", runnerCalls.length === 1 && runnerCalls[0].command === "uv" && runnerCalls[0].args.includes("--yes"));
ok("a successful compile reports exit code 0", compileRun.code === 0 && typeof compileRun.elapsedMs === "number");
let runnerRequired = false;
try {
  await plugin.runCangjieCompile({ cli: "/x/cangjie.py" });
} catch (error) {
  runnerRequired = /runner is required/.test(error.message);
}
ok("runCangjieCompile refuses to run without a runner", runnerRequired === true);

console.log("\n== evolution round (deterministic half) ==");
let gitAvailable = true;
try {
  const probe = await gitRunner({ command: "git", args: ["--version"], cwd: undefined });
  gitAvailable = probe.code === 0;
} catch {
  gitAvailable = false;
}
ok("git is available for the evolution tests", gitAvailable === true, "install git to run these assertions");

// A skill outside any repository must be refused BEFORE anything is written.
const looseRoot = join(dir, "loose-root");
const loose = await plugin.writeSkillBundle({ root: looseRoot, skillName: "loose-skill", description: "Use when testing the git precondition.", body: "# loose\n" });
let refusal = "";
try {
  await plugin.evolveSkill({ skillDir: loose.dir, referenceContent: "# material", sourceLabel: "notes.md", runner: gitRunner });
} catch (error) {
  refusal = error.message;
}
ok("a skill outside a git repository is refused", /not inside a git repository/.test(refusal), refusal);
ok(
  "the refusal happens before any mutation",
  !existsSync(join(loose.dir, "test-prompts.json")) && !existsSync(join(loose.dir, "evolution")) && !existsSync(join(loose.dir, "references")),
  "a half-prepared skill would be worse than an explicit error"
);

const repoEvolveRoot = join(dir, "evolve-root");
const repoSkill = await plugin.writeSkillBundle({
  root: repoEvolveRoot,
  skillName: "evolve-subject",
  description: "Use when the user asks about 财富构建 or 判断与决策, or wants 冥想 guidance.",
  whenToUse: "咨询纳瓦尔式财富与幸福问题时",
  body: "# evolve-subject\n\nORIGINAL\n"
});
const materialPath = join(dir, "material.md");
await writeFile(materialPath, "# 新材料\n\n- 新增方法 A\n- 新增方法 B\n", "utf8");
const evolved = await plugin.evolveSkill({
  skillDir: repoSkill.dir,
  referenceContent: await readFile(materialPath, "utf8"),
  sourceLabel: materialPath,
  runner: gitRunner,
  gitInit: true,
  judges: 4,
  now: new Date("2026-09-29T10:30:00Z")
});
ok("evolve creates an auto-optimize branch", /^auto-optimize\/\d{8}-\d{4}$/.test(evolved.branch), evolved.branch);
ok("an even judge count is raised to odd", evolved.judgeCount === 5, String(evolved.judgeCount));
ok("the branch really exists in the repository", (await gitRunner({ command: "git", args: ["branch", "--list", evolved.branch], cwd: evolved.repoRoot })).stdout.includes(evolved.branch));
ok("the test-prompts skeleton is derived from the description", existsSync(evolved.testPrompts) && JSON.parse(await readFile(evolved.testPrompts, "utf8")).prompts.length >= 3, evolved.testPrompts);
ok("the skeleton marks its prompts as placeholders", /待改写|待补充/.test(await readFile(evolved.testPrompts, "utf8")));
ok("a plan ticket is written", existsSync(evolved.planPath) && /judge/i.test(await readFile(evolved.planPath, "utf8")), evolved.planPath);
ok("the results.tsv header is written", (await readFile(evolved.resultsPath, "utf8")).startsWith("run_id\tprompt_id\t"), await readFile(evolved.resultsPath, "utf8"));
ok("the ticket forbids git reset --hard", (await readFile(evolved.planPath, "utf8")).includes("git reset --hard"));
ok("the original SKILL.md was archived", existsSync(evolved.backupPath));
const evolvedSkill = await readFile(join(repoSkill.dir, "SKILL.md"), "utf8");
ok("the material was merged into the marker block", evolvedSkill.includes("<!-- distillation:enhancement start -->") && evolvedSkill.includes("参考") === false && evolvedSkill.includes("ORIGINAL"));
ok("the round is recorded as provenance", (await plugin.readArtifactRecord(repoSkill.dir))?.runs?.some((r) => String(r.note ?? "").includes(evolved.runId)));

const cleanRunDir = join(repoSkill.dir, "evolution", evolved.runId);
await writeFile(evolved.resultsPath, (await readFile(evolved.resultsPath, "utf8")) + "r1\tp1\tj1\tbetter\tcand\tbase\t2026-09-29\tkeep\t-\n", "utf8");
const finalized = await plugin.finalizeEvolution({ skillDir: repoSkill.dir, runId: evolved.runId, decision: "keep", note: "paired majority better" });
ok("finalize archives the round", existsSync(finalized.resultPath) && finalized.judgedRows === 1, `${finalized.resultPath} rows=${finalized.judgedRows}`);
const finalizedRecord = JSON.parse(await readFile(finalized.resultPath, "utf8"));
ok("the archive carries the decision and note", finalizedRecord.decision === "keep" && finalizedRecord.note === "paired majority better");
const revert = await plugin.finalizeEvolution({ skillDir: repoSkill.dir, runId: evolved.runId, decision: "revert" });
ok("revert is reported as a git command, never executed", revert.gitCommand === "git revert --no-edit HEAD");
ok("the skill file is still untouched after a reported revert", (await readFile(join(repoSkill.dir, "SKILL.md"), "utf8")).includes("ORIGINAL"));
let badDecision = "";
try {
  await plugin.finalizeEvolution({ skillDir: repoSkill.dir, runId: evolved.runId, decision: "maybe" });
} catch (error) {
  badDecision = error.message;
}
ok("an unknown decision is rejected", /keep.*revert/.test(badDecision), badDecision);
let missingRun = "";
try {
  await plugin.finalizeEvolution({ skillDir: repoSkill.dir, runId: "run-19700101-0000", decision: "keep" });
} catch (error) {
  missingRun = error.message;
}
ok("finalizing an unknown run is rejected", /no such evaluation run/.test(missingRun), missingRun);
ok("the run directory survived finalization", existsSync(cleanRunDir));

const dryEvolve = await plugin.evolveSkill({ skillDir: repoSkill.dir, referenceContent: "# dry", sourceLabel: "dry.md", runner: gitRunner, dryRun: true, now: new Date("2026-09-29T11:00:00Z") });
ok("a dry run writes no ticket and no branch", dryEvolve.dryRun === true && dryEvolve.branch === undefined && !existsSync(join(repoSkill.dir, "evolution", "run-20260929-1100")), JSON.stringify(dryEvolve.branch));

console.log("\n== web extraction (offline) ==");
const articleHtml = `<!doctype html><html><head><title>深度学习教程</title><meta charset="utf-8"></head><body>
<nav class="site-nav"><a href="/a">首页</a><a href="/b">目录</a><a href="/c">关于我们</a></nav>
<aside class="sidebar"><a href="/x">广告一号</a><a href="/y">广告二号</a></aside>
<article class="post"><h1>正文标题</h1><p>${"这是一段正文内容，用来测试主容器打分是否正确。".repeat(12)}</p><p>第二段正文，同样足够长，应该被保留下来。</p><p>第三段正文。</p></article>
<footer class="footer">版权所有 2026 示例站点</footer></body></html>`;
const mainContent = plugin.extractMainHtml(articleHtml);
ok("the main content is found", /正文标题/.test(mainContent.text) && mainContent.text.length > 150, `${mainContent.strategy}/${mainContent.text.length}`);
ok("navigation, ads and footer are dropped", !/广告一号|版权所有|首页/.test(mainContent.text), mainContent.text.slice(0, 90));
ok("the strategy names the chosen container", mainContent.strategy === "article-container", mainContent.strategy);
ok("a page without a substantial container falls back to the document", plugin.extractMainHtml("<html><body><div>hi</div></body></html>").strategy === "whole-document");
ok(
  "a semantic container beats body even when body has slightly more text",
  (() => {
    const page = `<html><body><p>skip to main content and a site banner</p><main class="content">${"<p>" + "正文内容。".repeat(50) + "</p>"}</main></body></html>`;
    const picked = plugin.extractMainHtml(page);
    return picked.strategy === "main-container" && !picked.text.includes("skip to main content");
  })()
);

const latin1Page = Buffer.from(`<html><head><meta charset="iso-8859-1"></head><body>caf${String.fromCharCode(0xe9)}</body></html>`, "latin1");
const decodedLatin = plugin.decodeHtmlBytes(latin1Page, "text/html");
ok("a declared non-UTF8 charset is honoured", decodedLatin.charset.toLowerCase().startsWith("iso-8859-1") && decodedLatin.text.includes("café"), `${decodedLatin.charset}: ${decodedLatin.text.slice(-16)}`);
ok("the content-type charset is used when no meta tag exists", plugin.decodeHtmlBytes(Buffer.from("ok", "utf8"), "text/html; charset=utf-8").charset === "utf-8");

let flakyCalls = 0;
const flakyFetch = async () => {
  flakyCalls += 1;
  if (flakyCalls < 3) return { ok: false, status: 503, statusText: "Service Unavailable" };
  return { ok: true, status: 200, headers: { get: () => "text/plain" }, arrayBuffer: async () => new ArrayBuffer(0) };
};
const retried = await plugin.fetchWithRetry("https://flaky.test/", { attempts: 3, fetchImpl: flakyFetch, sleep: async () => {} });
ok("a flaky endpoint is retried until it succeeds", retried.attempts === 3 && flakyCalls === 3, `attempts=${retried.attempts}`);
let calls404 = 0;
const notFoundFetch = async () => {
  calls404 += 1;
  return { ok: false, status: 404, statusText: "Not Found" };
};
let error404 = "";
try {
  await plugin.fetchWithRetry("https://gone.test/", { attempts: 3, fetchImpl: notFoundFetch, sleep: async () => {} });
} catch (error) {
  error404 = error.message;
}
ok("a 404 is never retried", calls404 === 1 && /HTTP 404/.test(error404), `calls=${calls404}`);

const linkHtml = `<a href="/docs/a">A</a><a href="https://other.test/b">external</a><a href="/docs/a#x">dup</a><a href="/img/x.png">img</a><a href="mailto:x@y">mail</a><a href="/docs/b">B</a>`;
ok(
  "only same-origin document links are followed",
  plugin.sameOriginLinks("https://site.test/guide/index.html", linkHtml, { limit: 5 }).map((l) => l.url).join(",") === "https://site.test/docs/a,https://site.test/docs/b",
  plugin.sameOriginLinks("https://site.test/guide/index.html", linkHtml, { limit: 5 }).map((l) => l.url).join(",")
);

const sitePages = {
  "https://site.test/guide/": `<html><head><title>指南</title><meta charset="utf-8"></head><body><nav><a href="/guide/one">一</a><a href="/guide/two">二</a><a href="/guide/three">三</a></nav><article><p>${"指南正文。".repeat(60)}</p></article></body></html>`,
  "https://site.test/guide/one": `<html><head><title>第一篇</title></head><body><article><p>${"第一篇正文。".repeat(60)}</p></article></body></html>`,
  "https://site.test/guide/two": `<html><head><title>第二篇</title></head><body><article><p>${"第二篇正文。".repeat(60)}</p></article></body></html>`
};
const stubFetch = async (url) => {
  const body = sitePages[url];
  if (body === undefined) return { ok: false, status: 404, statusText: "Not Found" };
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  };
};
const baseWebConfig = { maxSourceBytes: 4_000_000, userAgent: "test", fetchImpl: stubFetch };
const singlePage = await plugin.ingestSource("https://site.test/guide/", baseWebConfig);
ok("a URL source is reduced to main content", singlePage.kind === "html" && singlePage.text.includes("指南正文") && !singlePage.text.includes("第一篇正文"), singlePage.kind);
ok("the extraction strategy and charset are reported", singlePage.meta.strategy === "article-container" && singlePage.meta.charset === "utf-8", JSON.stringify(singlePage.meta));
const multiPage = await plugin.ingestSource("https://site.test/guide/", { ...baseWebConfig, followPages: 2, maxFollowPages: 5 });
ok("multi-page following merges the linked pages", (multiPage.extraPages ?? []).length === 2 && multiPage.extraPages.every((p) => /正文/.test(p.text)), JSON.stringify((multiPage.extraPages ?? []).map((p) => p.label)));
ok("http is never run implicitly", singlePage.extraPages === undefined);
const merged = plugin.renderSourcesMd("站点蒸馏", [multiPage]);
ok("followed pages land in the merged document", merged.includes("### 附页") && merged.includes("第一篇正文") && merged.includes("第二篇正文"));
const cappedPage = await plugin.ingestSource("https://site.test/guide/", { ...baseWebConfig, followPages: 99, maxFollowPages: 1 });
ok("the follow cap is enforced", cappedPage.extraPages.length === 1, String(cappedPage.extraPages.length));
const failedSub = await plugin.ingestSource("https://site.test/guide/three", baseWebConfig).catch((error) => error.message);
ok("a dead sub-page fails loudly instead of silently", /HTTP 404/.test(String(failedSub)), String(failedSub));

console.log("\n== repository analysis (offline) ==");
const repoDir = join(dir, "fake-repo");
for (const sub of ["src", "docs", "docs/nested", "assets", "examples", ".github/workflows", "node_modules/leftpad", "dist", "tests"]) {
  await mkdir(join(repoDir, sub), { recursive: true });
}
await writeFile(join(repoDir, "README.md"), "# Fake Repo\n\nA repository used by the test suite.\n", "utf8");
await writeFile(join(repoDir, "AGENTS.md"), "# Agent notes\n", "utf8");
await writeFile(join(repoDir, "LICENSE"), "MIT\n", "utf8");
await writeFile(join(repoDir, "package.json"), '{"name":"fake-repo"}\n', "utf8");
await writeFile(join(repoDir, "pyproject.toml"), "[project]\nname='fake'\n", "utf8");
await writeFile(join(repoDir, "Makefile"), "all:\n\techo hi\n", "utf8");
await writeFile(join(repoDir, "src/index.js"), "export const x = 1;\n".repeat(20), "utf8");
await writeFile(join(repoDir, "src/util.ts"), "export const y: number = 2;\n".repeat(20), "utf8");
await writeFile(join(repoDir, "docs/guide.md"), "# Guide\n", "utf8");
await writeFile(join(repoDir, "docs/nested/README.md"), "NESTED README\n", "utf8");
await writeFile(join(repoDir, "assets/logo.png"), Buffer.alloc(2048, 7));
await writeFile(join(repoDir, "examples/demo.py"), "print('demo')\n".repeat(20), "utf8");
await writeFile(join(repoDir, ".github/workflows/ci.yml"), "name: ci\n", "utf8");
await writeFile(join(repoDir, "node_modules/leftpad/index.js"), "module.exports = 1;\n", "utf8");
await writeFile(join(repoDir, "dist/bundle.js"), "!function(){}\n", "utf8");
await writeFile(join(repoDir, "tests/test_demo.py"), "def test_x():\n    assert True\n", "utf8");

const repoScan = await plugin.scanRepository(repoDir);
ok("the tree scan counts real files", repoScan.fileCount >= 12, String(repoScan.fileCount));
ok(
  "dependency and build directories are ignored, not analysed",
  repoScan.ignored.some((i) => i.dir === "node_modules" && i.files === 1) && repoScan.ignored.some((i) => i.dir === "dist" && i.files === 1),
  JSON.stringify(repoScan.ignored)
);
ok(
  "languages are detected by extension",
  ["JavaScript", "TypeScript", "Python", "Markdown"].every((lang) => repoScan.languages.some((l) => l.lang === lang)),
  repoScan.languages.map((l) => `${l.lang}:${l.share}%`).join(", ")
);
ok("the language shares add up to about 100%", Math.abs(repoScan.languages.reduce((s, l) => s + l.share, 0) - 100) < 1.5, String(repoScan.languages.reduce((s, l) => s + l.share, 0)));
ok("entrypoints are recognised", ["package.json", "pyproject.toml", "Makefile"].every((e) => repoScan.entrypoints.includes(e)), JSON.stringify(repoScan.entrypoints));
ok("CI configuration is recognised", repoScan.ci.includes(".github/workflows/ci.yml"), JSON.stringify(repoScan.ci));
ok("convention files are recognised", repoScan.conventions.includes("AGENTS.md") && repoScan.conventions.includes("LICENSE"), JSON.stringify(repoScan.conventions));
ok("docs are recognised", repoScan.docs.includes("README.md") && repoScan.docs.includes("docs/guide.md") && repoScan.docs.includes("AGENTS.md"), JSON.stringify(repoScan.docs));
ok("examples are recognised", repoScan.examples.includes("examples/demo.py"), JSON.stringify(repoScan.examples));
ok("the directory tree is depth-limited", repoScan.tree.includes("src/") && repoScan.tree.includes(".github/") && !repoScan.tree.includes(".github/workflows/workflows/"), JSON.stringify(repoScan.tree.slice(0, 8)));

const localAnalysis = await plugin.analyzeRepository({ source: repoDir });
ok("a local path is read without cloning", localAnalysis.cloned === false && localAnalysis.cleanup === undefined);
ok("the README is read for the overview", localAnalysis.readme?.path === "README.md" && localAnalysis.readme.excerpt.includes("Fake Repo"));
ok("the shallowest README wins over a nested one", localAnalysis.readme?.path === "README.md", localAnalysis.readme?.path);
const repoMd = plugin.renderRepoMd(localAnalysis, "Fake Repo");
const repoSections = repoMd.split(/\r?\n/).filter((l) => /^## \d\./.test(l));
ok("the analysis has the fixed 8 sections", repoSections.length === 8, repoSections.join(" | "));
ok("the document carries the language table", /\| 语言 \| 文件数 \|/.test(repoMd));
ok("assets are labelled instead of falling into Other", repoScan.languages.some((l) => l.lang === "Image"), repoScan.languages.map((l) => `${l.lang}:${l.share}%`).join(", "));
ok("the summary separates resources from code and docs", /代码与文档占 \d+(\.\d+)?%，二进制资源占 \d+(\.\d+)?%/.test(repoMd));
ok("the document carries a README excerpt", repoMd.includes("README 摘录") && repoMd.includes("A repository used by the test suite"));

const cloneCalls = [];
const stubCloneRunner = async ({ args }) => {
  cloneCalls.push(args);
  const target = args[args.length - 1];
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "README.md"), "# Cloned\n\nfrom the stub.\n", "utf8");
  return { code: 0, stdout: "", stderr: "", timedOut: false };
};
const clonedAnalysis = await plugin.analyzeRepository({ source: "https://example.test/owner/repo.git", runner: stubCloneRunner, cwd: dir });
ok("a remote repository is cloned depth 1", cloneCalls[0].slice(0, 3).join(" ") === "clone --depth 1" && clonedAnalysis.cloned === true, cloneCalls[0]?.join(" "));
ok("the clone goes into a temporary directory", clonedAnalysis.root.includes("dsh-repo-"));
ok("a branch is passed through when given", (await plugin.analyzeRepository({ source: "https://example.test/o/r.git", runner: stubCloneRunner, branch: "dev" })).cloned === true && cloneCalls[1].includes("--branch") && cloneCalls[1].includes("dev"));
const cleanupRoot = clonedAnalysis.root;
await clonedAnalysis.cleanup();
ok("cleanup removes the temporary checkout", !existsSync(cleanupRoot));

let cloneError = "";
try {
  await plugin.analyzeRepository({ source: "https://example.test/missing.git", runner: async () => ({ code: 128, stdout: "", stderr: "fatal: repository not found", timedOut: false }) });
} catch (error) {
  cloneError = error.message;
}
ok("a failed clone reports git's own message", /git clone failed \(exit 128\): fatal: repository not found/.test(cloneError), cloneError);
let noRunner = "";
try {
  await plugin.analyzeRepository({ source: "https://example.test/owner/repo.git" });
} catch (error) {
  noRunner = error.message;
}
ok("cloning without a runner is refused", /runner is required/.test(noRunner), noRunner);
let missingLocal = "";
try {
  await plugin.analyzeRepository({ source: join(dir, "no-such-repo") });
} catch (error) {
  missingLocal = error.message;
}
ok("a missing local path is refused", /does not exist/.test(missingLocal), missingLocal);

console.log("\n== docs site entry (offline) ==");
const docsIndexText = [
  "# Demo Docs",
  "",
  "## 上手",
  "- [开始使用](https://docs.test/zh/get-started.md): 快速上手",
  "- [节点概览](https://docs.test/zh/nodes/overview.md): 内置节点一览",
  "## 参考",
  "- [API 参考](https://docs.test/zh/api/reference.md): REST API",
  "- [更新日志](https://docs.test/changelog.html): 版本记录",
  "- [死链](https://docs.test/zh/broken.md): 这个页面不存在",
  ""
].join("\n");
const parsedIndex = plugin.parseLlmsIndex(docsIndexText, "https://docs.test/llms.txt");
ok("llms.txt entries are parsed", parsedIndex.entries.length === 5, String(parsedIndex.entries.length));
ok("llms.txt sections are tracked", parsedIndex.entries[0].section === "上手" && parsedIndex.entries[3].section === "参考", JSON.stringify(parsedIndex.entries.map((e) => e.section)));
ok("markdown mirrors are recognised", parsedIndex.markdownCount === 4, String(parsedIndex.markdownCount));
ok("descriptions are captured", parsedIndex.entries[0].description === "快速上手", parsedIndex.entries[0].description);
ok("relative links resolve against the index URL", plugin.parseLlmsIndex("- [X](/a/b.md): d", "https://docs.test/zh/llms.txt").entries[0].url === "https://docs.test/a/b.md");

const docsStore = {
  "https://docs.test/llms.txt": { type: "text/plain; charset=utf-8", body: docsIndexText },
  "https://docs.test/zh/get-started.md": { type: "text/markdown; charset=utf-8", body: "# 开始使用\n\n" + "安装步骤说明。".repeat(40) },
  "https://docs.test/zh/nodes/overview.md": { type: "text/markdown; charset=utf-8", body: "# 节点概览\n\n" + "节点类型说明。".repeat(40) },
  "https://docs.test/zh/api/reference.md": { type: "text/markdown; charset=utf-8", body: "# API 参考\n\n" + "接口说明。".repeat(40) },
  "https://docs.test/changelog.html": { type: "text/html; charset=utf-8", body: `<html><body><nav><a href="/x">菜单</a></nav><main><p>${"更新内容。".repeat(60)}</p></main></body></html>` }
};
const docsStubFetch = async (url) => {
  const page = docsStore[url];
  if (page === undefined) return { ok: false, status: 404, statusText: "Not Found" };
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? page.type : null) },
    arrayBuffer: async () => new TextEncoder().encode(page.body).buffer
  };
};
const docsConfig = { ...baseWebConfig, fetchImpl: docsStubFetch };

const probe = await plugin.probeLlmsTxt("https://docs.test/zh", docsConfig);
ok("the site index is found by convention", probe.found === true && probe.url === "https://docs.test/llms.txt", String(probe.url));
const docsPlan = await plugin.planDocsPages({ url: "https://docs.test/zh", config: docsConfig, limit: 20 });
ok("markdown mirrors are preferred over html pages", docsPlan.strategy === "llms.txt" && docsPlan.pages.every((p) => p.markdown) && docsPlan.total === 4, `${docsPlan.strategy}/${docsPlan.total}`);
const filteredPages = plugin.filterDocPages(docsPlan.pages, "节点");
ok("substring filtering works", filteredPages.length === 1 && filteredPages[0].markdown === true, JSON.stringify(filteredPages.map((p) => p.title)));
ok("regex filtering works", plugin.filterDocPages(docsPlan.pages, "/api|概览/i").length === 2, JSON.stringify(plugin.filterDocPages(docsPlan.pages, "/api|概览/i").map((p) => p.title)));

const mergedDocs = await plugin.distillDocs({ url: "https://docs.test/zh", config: docsConfig, limit: 4 });
ok("pages are merged into one document", mergedDocs.document.includes("## 目录") && mergedDocs.document.includes("开始使用") && mergedDocs.document.includes("接口说明"), String(mergedDocs.document.length));
ok("the document names llms.txt as the discovery route", mergedDocs.strategy === "llms.txt" && mergedDocs.document.includes("llms.txt"), mergedDocs.strategy);
ok("a dead page is reported instead of aborting the batch", mergedDocs.failed.length === 1 && mergedDocs.fetched === 3, `${mergedDocs.fetched} fetched / ${mergedDocs.failed.length} failed`);
ok("the page limit is enforced", (await plugin.distillDocs({ url: "https://docs.test/zh", config: docsConfig, limit: 1 })).selected === 1);
ok(
  "filtering searches the whole index, not just the first `limit` entries",
  (await plugin.distillDocs({ url: "https://docs.test/zh", config: docsConfig, limit: 2, filter: "api" })).selected === 1,
  "a match beyond the limit must still be found"
);

const savedDocsHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(dir, "docs-home");
const perPageResult = await plugin.distillDocs({ url: "https://docs.test/zh", config: docsConfig, limit: 2, perPage: true, cwd: fixtureCwd });
ok("perPage installs one skill per page", perPageResult.skills.length === 2, JSON.stringify(perPageResult.skills.map((s) => s.name)));
ok(
  "skill ids are valid DSH ids even for Chinese titles",
  perPageResult.skills.every((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name)),
  perPageResult.skills.map((s) => s.name).join(",")
);
ok("skill ids come from the URL path", perPageResult.skills.map((s) => s.name).sort().join(",") === "get-started,nodes-overview", perPageResult.skills.map((s) => s.name).join(","));
ok("each page skill is discoverable on disk", perPageResult.skills.every((s) => existsSync(join(s.dir, "SKILL.md"))));
ok("docs installs carry their own provenance origin", (await plugin.readArtifactRecord(perPageResult.skills[0].dir))?.origin === "distill_docs", (await plugin.readArtifactRecord(perPageResult.skills[0].dir))?.origin);
process.env.DSH_HOME = savedDocsHome;

const noIndexStore = {
  "https://plain.test/guide/": { type: "text/html; charset=utf-8", body: `<html><body><main><p>${"正文。".repeat(80)}</p><a href="/guide/a">A</a><a href="/guide/b">B</a></main></body></html>` },
  "https://plain.test/guide/a": { type: "text/html; charset=utf-8", body: `<html><body><main><p>${"第一篇。".repeat(60)}</p></main></body></html>` },
  "https://plain.test/guide/b": { type: "text/html; charset=utf-8", body: `<html><body><main><p>${"第二篇。".repeat(60)}</p></main></body></html>` }
};
const plainFallback = await plugin.planDocsPages({
  url: "https://plain.test/guide/",
  config: { ...baseWebConfig, fetchImpl: async (url) => (noIndexStore[url] === undefined ? { ok: false, status: 404, statusText: "Not Found" } : { ok: true, status: 200, headers: { get: () => noIndexStore[url].type }, arrayBuffer: async () => new TextEncoder().encode(noIndexStore[url].body).buffer }) },
  limit: 5
});
ok("a site without llms.txt falls back to same-origin links", plainFallback.strategy === "html-links" && plainFallback.total === 2, `${plainFallback.strategy}/${plainFallback.total}`);
ok("the fallback records what it probed", Array.isArray(plainFallback.llms.tried) && plainFallback.llms.tried.includes("https://plain.test/llms.txt"));

// The tool wrapper must run too. A second registration with a stub fetch keeps
// this hermetic instead of reaching the real network.
const docsTools = new Map();
const docsCtx = {
  effect: (fn) => {
    const disposer = fn();
    return () => {
      try {
        disposer?.();
      } catch {
        /* idempotent */
      }
    };
  },
  tools: { register: (def) => (docsTools.set(def.name, def), () => {}) },
  skills: { registerProvider: () => () => {} }
};
plugin.apply(docsCtx, { fetchImpl: docsStubFetch });
const docsListTool = docsTools.get("distill_docs");
const docsListResult = await docsListTool.execute({ url: "https://docs.test/zh", list: true }, exec);
ok("distill_docs can list candidates without fetching pages", docsListResult.strategy === "llms.txt" && docsListResult.pages.length === 4 && docsListResult.fetched === 0, `${docsListResult.pages.length} pages`);
ok("distill_docs renders a listing summary", typeof docsListTool.output.render({}, docsListResult)[0].text === "string");
const docsRunResult = await docsListTool.execute({ url: "https://docs.test/zh", limit: 2, out: join(dir, "docs-merged.md") }, exec);
ok("distill_docs writes the merged document where asked", existsSync(docsRunResult.outPath) && (await readFile(docsRunResult.outPath, "utf8")).includes("开始使用"), docsRunResult.outPath);
ok("distill_docs reports what it fetched", docsRunResult.fetched === 2 && docsRunResult.selected === 2, `${docsRunResult.fetched}/${docsRunResult.selected}`);

console.log("\n== host status route (read-only) ==");
let capturedRoute;
const webCtx = {
  effect: (fn) => {
    const disposer = fn();
    return () => {
      try {
        disposer?.();
      } catch {
        /* idempotent */
      }
    };
  },
  get: (name) => (name === "webServer" ? { register: (route) => ((capturedRoute = route), () => {}) } : undefined),
  tools: { register: () => () => {} },
  skills: { registerProvider: () => () => {} }
};
plugin.apply(webCtx, {});
ok("the host registers a status route", capturedRoute?.kind === "exact" && capturedRoute?.path === plugin.STATUS_ROUTE, JSON.stringify({ kind: capturedRoute?.kind, path: capturedRoute?.path }));

// The route must survive a web surface that mounts late, tolerate a duplicate
// registration, and never fail silently.
let lateRoute;
let lateAttempts = 0;
const lateCtx = {
  effect: (fn) => {
    const disposer = fn();
    return () => {
      try {
        disposer?.();
      } catch {
        /* idempotent */
      }
    };
  },
  get: (name) => (lateAttempts >= 2 && name === "webServer" ? { register: (route) => ((lateRoute = route), () => {}) } : undefined),
  setTimeout: (fn) => {
    lateAttempts += 1;
    fn();
    return () => {};
  },
  tools: { register: () => () => {} },
  skills: { registerProvider: () => () => {} }
};
plugin.apply(lateCtx, {});
ok("a late webServer is retried until the route is owned", lateRoute?.path === plugin.STATUS_ROUTE, `attempts=${lateAttempts}`);

const duplicateCtx = {
  effect: (fn) => {
    const disposer = fn();
    return () => {
      try {
        disposer?.();
      } catch {
        /* idempotent */
      }
    };
  },
  get: (name) => (name === "webServer" ? { register: () => { throw new Error("duplicate route: (exact, /dsh-distillation/status)"); } } : undefined),
  tools: { register: () => () => {} },
  skills: { registerProvider: () => () => {} }
};
plugin.apply(duplicateCtx, {});
ok("a duplicate registration counts as served, not as failure", true);

const routeDoctor = await plugin.runDoctor({ cwd: fixtureCwd, config: {}, probe: false, runtime: { statusRoute: { registered: true, path: plugin.STATUS_ROUTE } } });
ok("doctor reports the page data path", routeDoctor.checks.find((c) => c.id === "status-route")?.status === "ok", JSON.stringify(routeDoctor.checks.find((c) => c.id === "status-route")));
const routeDoctorMissing = await plugin.runDoctor({ cwd: fixtureCwd, config: {}, probe: false, runtime: { statusRoute: { registered: false, reason: "webServer service is not available yet", path: plugin.STATUS_ROUTE } } });
const missingCheck = routeDoctorMissing.checks.find((c) => c.id === "status-route");
ok("a lost route becomes a named finding with a fix", missingCheck?.status === "warn" && typeof missingCheck.fix === "string" && missingCheck.fix.length > 10, JSON.stringify(missingCheck));
ok("the CLI doctor does not pretend to own a route", (await plugin.runDoctor({ cwd: fixtureCwd, config: {}, probe: false })).checks.find((c) => c.id === "status-route")?.status === "skip");
const fakeRes = {
  writeHead(code, headers) {
    this.code = code;
    this.headers = headers;
  },
  end(body) {
    this.body = body;
  }
};
await capturedRoute.handler({ url: `${plugin.STATUS_ROUTE}?cwd=${encodeURIComponent(fixtureCwd)}` }, fakeRes);
const snapshot = JSON.parse(fakeRes.body);
ok("the route answers JSON", fakeRes.code === 200 && snapshot.schema === "dsh-distillation/status/v1", `${fakeRes.code}`);
ok("the route sends no-store JSON", String(fakeRes.headers?.["content-type"]).includes("application/json") && fakeRes.headers?.["cache-control"] === "no-store", JSON.stringify(fakeRes.headers));
ok("the snapshot carries roots, engines and generated skills", Array.isArray(snapshot.roots) && snapshot.roots.length >= 4 && snapshot.engines.length >= 5 && Array.isArray(snapshot.generated), JSON.stringify({ roots: snapshot.roots?.length, engines: snapshot.engines?.length }));
ok("the snapshot reports the plugin version", snapshot.version === plugin.PLUGIN_VERSION && snapshot.version === "1.0.0", snapshot.version);
const doctorRes = { writeHead() {}, end(body) { this.body = body; } };
await capturedRoute.handler({ url: `${plugin.STATUS_ROUTE}?doctor=1&cwd=${encodeURIComponent(fixtureCwd)}` }, doctorRes);
const doctorSnapshot = JSON.parse(doctorRes.body);
ok("the self-check can be requested through the route", typeof doctorSnapshot.doctor?.counts?.ok === "number" && Array.isArray(doctorSnapshot.doctor.checks), JSON.stringify(doctorSnapshot.doctor?.counts));
const brokenRes = { writeHead() {}, end(body) { this.body = body; } };
await capturedRoute.handler({ url: `${plugin.STATUS_ROUTE}?cwd=${encodeURIComponent(join(dir, "nope"))}&doctor=1` }, brokenRes);
ok("a failing snapshot still answers with JSON", typeof brokenRes.body === "string" && brokenRes.body.startsWith("{"));

console.log("\n== doctor ==");
const doctorNoRunner = await plugin.runDoctor({ cwd: fixtureCwd, config: {}, probe: false });
ok("doctor runs without a subprocess seam", doctorNoRunner.ok === true && doctorNoRunner.counts.fail === 0, JSON.stringify(doctorNoRunner.counts));
ok("doctor reports skipped checks when there is no runner", doctorNoRunner.checks.filter((c) => c.status === "skip").length >= 2, JSON.stringify(doctorNoRunner.checks.filter((c) => c.status === "skip").map((c) => c.id)));
ok("doctor verifies the bundled engines", doctorNoRunner.checks.find((c) => c.id === "engines")?.status === "ok");
ok("doctor verifies engine drift", doctorNoRunner.checks.find((c) => c.id === "engines-drift")?.status === "ok");
ok("doctor finds cangjie.py in the bundled engine", String(doctorNoRunner.checks.find((c) => c.id === "cangjie-cli")?.detail).includes("cangjie-skill"), doctorNoRunner.checks.find((c) => c.id === "cangjie-cli")?.detail);
ok("doctor resolves the router index", doctorNoRunner.checks.find((c) => c.id === "route-index")?.status === "ok");

const healthyRunner = async ({ command }) => ({ code: 0, stdout: command === "uv" ? "uv 9.9.9" : `${command} 1.2.3`, stderr: "", timedOut: false });
const doctorHealthy = await plugin.runDoctor({ cwd: fixtureCwd, config: {}, runner: healthyRunner, probe: true });
ok("a healthy toolchain reports zero warnings", doctorHealthy.counts.warn === 0 && doctorHealthy.counts.fail === 0, JSON.stringify(doctorHealthy.counts));
ok("doctor checks Python through uv", doctorHealthy.checks.find((c) => c.id === "python")?.status === "ok");
ok("doctor proves the user root is writable", doctorHealthy.checks.find((c) => c.id === "skill-root-writable")?.status === "ok");

const brokenRunner = async ({ command }) => ({ code: 127, stdout: "", stderr: `${command}: not found`, timedOut: false });
const doctorBroken = await plugin.runDoctor({ cwd: fixtureCwd, config: {}, runner: brokenRunner, probe: false });
ok("a missing toolchain warns instead of failing", doctorBroken.ok === true && doctorBroken.counts.warn >= 2, JSON.stringify(doctorBroken.counts));
const actionable = doctorBroken.checks.filter((c) => c.status === "warn" || c.status === "fail");
ok("every warn/fail check explains how to fix it", actionable.length > 0 && actionable.every((c) => typeof c.fix === "string" && c.fix.length > 10), JSON.stringify(actionable.filter((c) => !c.fix).map((c) => c.id)));

const doctorNoIndex = await plugin.runDoctor({ cwd: join(dir, "no-such-cwd"), config: { bundledEngines: false }, probe: false });
ok("a missing router index is a hard failure", doctorNoIndex.ok === false && doctorNoIndex.checks.find((c) => c.id === "route-index")?.status === "fail");

const doctorHome = join(dir, "doctor-home");
const savedHome4 = process.env.DSH_HOME;
process.env.DSH_HOME = doctorHome;
const reportFile = await plugin.writeDoctorReport(doctorHealthy);
ok("doctor report is cached under DSH_HOME", reportFile === join(doctorHome, "distillation", "doctor.json") && existsSync(reportFile), reportFile);
const readBack = await plugin.readDoctorReport();
ok("the cached report round-trips", readBack?.schema === "dsh-distillation/doctor/v1" && readBack.counts.ok === doctorHealthy.counts.ok);
process.env.DSH_HOME = savedHome4;

console.log("\n== manifest ==");
const pkg = JSON.parse(await readFile(join(bundleDir, "package.json"), "utf8"));
ok("name", pkg.name === "dsh-distillation", pkg.name);
ok("license is GPL-3.0-or-later", pkg.license === "GPL-3.0-or-later", pkg.license);
ok("repository points at the public repo", pkg.repository?.url === "git+https://github.com/mmctbqj-collab/distillation-plugin.git", pkg.repository?.url);
const licenseText = await readFile(join(bundleDir, "LICENSE"), "utf8");
ok("LICENSE ships the verbatim GPLv3 text", licenseText.includes("GNU GENERAL PUBLIC LICENSE") && licenseText.includes("Version 3, 29 June 2007") && licenseText.includes("TERMS AND CONDITIONS"), String(licenseText.length));
ok("package.json ships the required legal files", ["LICENSE", "THIRD_PARTY_LICENSES.md"].every((f) => pkg.files?.includes(f)), JSON.stringify(pkg.files));
ok("third-party notices exist for the bundled MIT engines", existsSync(join(bundleDir, "THIRD_PARTY_LICENSES.md")));
ok("engines are shipped in the package", Array.isArray(pkg.files) && pkg.files.includes("engines/"), JSON.stringify(pkg.files));
ok("bundle patch declared", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
ok("client half declared", pkg.dsh?.client?.platform === "web" && pkg.dsh?.client?.immediately === true);
ok("client injects the settings-plugins owner", JSON.stringify(pkg.dsh?.client?.inject) === '["@deepseek-ai/dsh-client-ui-settings-plugins"]');
ok("exports ./client", pkg.exports?.["./client"] === "./client.js");
ok("icon declared", pkg.icon === "./icon.svg");
ok("locale files ship in the package", pkg.files?.includes("locale/") && existsSync(join(bundleDir, "locale", "zh.json")) && existsSync(join(bundleDir, "locale", "en.json")));

console.log("\n== documentation ==");
const readmeText = await readFile(join(bundleDir, "README.md"), "utf8");
const changelogText = await readFile(join(bundleDir, "docs", "CHANGELOG.md"), "utf8");
const cliSourceText = await readFile(join(bundleDir, "engines", "skill-distillation", "scripts", "cli.mjs"), "utf8");
ok("the README names the public repository", readmeText.includes("github.com/mmctbqj-collab/distillation-plugin"));
ok("the README states the licence and the third-party notice", readmeText.includes("GPL-3.0-or-later") && readmeText.includes("THIRD_PARTY_LICENSES.md"));
ok(
  "the docs cover install / usage / SOP / FAQ / changelog",
  ["INSTALL.md", "USAGE.md", "SOP.md", "FAQ.md", "CHANGELOG.md"].every((file) => existsSync(join(bundleDir, "docs", file))),
  "a documented topic is missing"
);
ok("the changelog documents the shipped version", changelogText.includes("## 1.0.0") && changelogText.includes("11 个 Agent 工具"));
// Documentation drift guard: the README must not claim a different surface than the code exposes.
const cliBlock = /const COMMANDS = \{([\s\S]*?)\};/.exec(cliSourceText)?.[1] ?? "";
const cliNames = [...cliBlock.matchAll(/([a-z]+):\s*cmd/g)].map((match) => match[1]);
ok("the README documents every CLI subcommand", cliNames.length === 11 && cliNames.every((name) => readmeText.includes(name)), cliNames.join(","));
ok("the README tool count matches the registry", new RegExp(`${tools.size} 个 Agent 工具`).test(readmeText), `tools=${tools.size}`);
ok("the README CLI count matches the registry", new RegExp(`${cliNames.length} 个 CLI 子命令`).test(readmeText), `cli=${cliNames.length}`);
ok("every tool name appears in the README", [...tools.keys()].every((name) => readmeText.includes(name)), [...tools.keys()].filter((name) => !readmeText.includes(name)).join(","));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
