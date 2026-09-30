/**
 * dsh-distillation core — pure, host-dependency-free logic.
 *
 * Extracted verbatim from lib/index.js by build/split-core.mjs so that the SAME
 * implementation backs both the DSH host plugin (lib/index.js) and the
 * no-restart skill CLI (skills/skill-distillation/scripts/distill.mjs).
 * Only `node:*` builtins may be imported here.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const dshHome = () =>
	resolvePath(process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"));

/** The user-level skill root (`$DSH_HOME/skills`, rank 400). */
export const userSkillsDir = (config) =>
	config.skillsDir && config.skillsDir.length > 0 ? resolvePath(expandTilde(config.skillsDir)) : join(dshHome(), "skills");

/** The project-level skill root (`<cwd>/.dsh/skills`, rank 100 — wins over the user root). */
export const projectSkillsDir = (cwd) => join(resolvePath(cwd), ".dsh", "skills");

export function expandTilde(p) {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

/** Resolve the target skill root from a tool argument. */
export function resolveSkillRoot(target, cwd, config) {
	if (target === "project") return projectSkillsDir(cwd);
	if (target === "user") return userSkillsDir(config);
	// Explicit path wins; otherwise default to the user root so distilled skills are global.
	if (typeof target === "string" && target.length > 0 && target !== "auto") return resolvePath(expandTilde(target));
	return userSkillsDir(config);
}

export function slugify(text) {
	return String(text)
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 64) || "distilled";
}

/* ------------------------------------------------------------------ *
 * Text extraction
 * ------------------------------------------------------------------ */

export const HTML_ENTITIES = {
	"&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
	"&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
	"&ldquo;": "“", "&rdquo;": "”", "&lsquo;": "‘", "&rsquo;": "’"
};

/** Very small HTML→text reducer: drop script/style/pre noise, keep headings and block breaks. */
export function htmlToText(html) {
	let s = String(html);
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, "");
	s = s.replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, (_m, t) => "\n# " + String(t).trim() + "\n");
	s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
	s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n\n");
	s = s.replace(/<li\b[^>]*>/gi, "- ");
	s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, lvl) => "\n" + "#".repeat(Number(lvl)) + " ");
	s = s.replace(/<[^>]+>/g, "");
	s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
	s = s.replace(/&[a-z]+;|&#39;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
	s = s.replace(/[ \t\u00a0]+/g, " ");
	s = s.replace(/\n[ \t]+/g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

/** Extract `<title>` when present. */
export function htmlTitle(html) {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
	return m ? htmlToText(m[1]).trim() : undefined;
}

/** Recognize ComfyUI workflow JSON in either the UI format or the API format. */
export function isComfyWorkflow(value) {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value.nodes) && value.nodes.some((n) => n && typeof n.type === "string")) return true;
	const values = Object.values(value);
	return values.length > 0 && values.every((v) => v && typeof v === "object" && typeof v.class_type === "string");
}

/* ------------------------------------------------------------------ *
 * ComfyUI workflow analysis
 * ------------------------------------------------------------------ */

export const PARAM_KEYS = [
	"seed", "noise_seed", "steps", "cfg", "cfg_scale", "sampler_name", "scheduler", "denoise",
	"width", "height", "batch_size", "ckpt_name", "lora_name", "strength", "strength_model",
	"strength_clip", "text", "positive", "negative", "filename_prefix", "vae_name", "model_name",
	"unet_name", "control_net_name", "image", "video_frames", "fps", "frame_rate", "total_frames"
];

export const NODE_ROLES = [
	[/CheckpointLoader|UNETLoader|DiffusionLoader|^Load.*Model/i, "模型加载"],
	[/LoraLoader/i, "LoRA"],
	[/VAELoader|VAEDecode|VAEEncode/i, "VAE"],
	[/CLIPTextEncode|CLIPLoader|Conditioning/i, "提示词/条件"],
	[/KSampler|SamplerCustom|Sampler\b/i, "采样器"],
	[/ControlNet|Canny|Depth|OpenPose|LineArt|Scribble/i, "ControlNet"],
	[/EmptyLatentImage|EmptySD3LatentImage|EmptyLatent/i, "潜空间尺寸"],
	[/ImageScale|Upscale|LatentUpscale|ESRGAN/i, "放大/缩放"],
	[/Inpaint|SetLatentNoiseMask|MaskFrom/i, "局部重绘"],
	[/IPAdapter|CLIPVision/i, "IPAdapter"],
	[/SaveImage|PreviewImage|SaveAnimated|VHS_VideoCombine/i, "输出"],
	[/AnimateDiff|VideoModel|WanVideo|SVD|HunyuanVideo|LTXV/i, "视频/动画"],
	[/LoadImage|LoadVideo|VHS_LoadVideo/i, "输入媒体"],
	[/Primitive|Note|Reroute|Anything Everywhere/i, "辅助"],
];

export function nodeRole(type) {
	for (const [re, role] of NODE_ROLES) if (re.test(type)) return role;
	return "其他";
}

/** Concatenate any widget values that look like prompt text. */
export function widgetString(node) {
	const bucket = [];
	for (const key of ["widgets_values", "inputs"]) {
		const value = node[key];
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (typeof item === "string" && item.trim().length > 0) bucket.push(item.trim());
			else if (item && typeof item === "object" && typeof item.widget === "string" && item.widget.trim().length > 0) bucket.push(item.widget.trim());
		}
	}
	return bucket.join("\n");
}

/**
 * Positional `widgets_values` carry no names in the UI format. This table maps
 * common node types to their real widget names so the analysis reads naturally
 * (`steps=28` instead of `widget[2]=28`). Unknown types keep `widget[i]`.
 */
export const WIDGET_NAMES = {
	CheckpointLoaderSimple: ["ckpt_name"],
	CheckpointLoader: ["config_name", "ckpt_name"],
	UNETLoader: ["unet_name", "weight_dtype"],
	LoraLoader: ["lora_name", "strength_model", "strength_clip"],
	LoraLoaderModelOnly: ["lora_name", "strength_model"],
	VAELoader: ["vae_name"],
	ControlNetLoader: ["control_net_name"],
	CLIPLoader: ["clip_name", "type", "device"],
	CLIPTextEncode: ["text"],
	KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
	KSamplerAdvanced: ["add_noise", "noise_seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
	SamplerCustom: ["noise_seed", "cfg", "sampler_name", "scheduler", "denoise"],
	EmptyLatentImage: ["width", "height", "batch_size"],
	EmptySD3LatentImage: ["width", "height", "batch_size"],
	SaveImage: ["filename_prefix"],
	LoadImage: ["image", "upload"],
	ImageScale: ["upscale_method", "width", "height", "crop"],
	ImageScaleBy: ["upscale_method", "scale_by"],
	UpscaleModelLoader: ["model_name"],
	ControlNetApplyAdvanced: ["strength", "start_percent", "end_percent"],
	ControlNetApply: ["strength"]
};

/** Collect `{key: scalar}` parameters from a UI-format node. */
export function nodeParams(node) {
	const out = {};
	const names = WIDGET_NAMES[node.type];
	const raw = node.widgets_values;
	if (Array.isArray(raw)) {
		raw.forEach((v, i) => {
			if (v === null || v === undefined) return;
			if (typeof v === "object") return;
			out[names?.[i] ?? `widget[${i}]`] = v;
		});
	} else if (raw && typeof raw === "object") {
		for (const [k, v] of Object.entries(raw)) {
			if (v === null || v === undefined || typeof v === "object") continue;
			out[k] = v;
		}
	}
	if (node.properties && typeof node.properties === "object") {
		for (const key of PARAM_KEYS) if (key in node.properties) out[key] = node.properties[key];
	}
	return out;
}

/**
 * Analyze a ComfyUI workflow (UI or API format) into a structured, model-readable object.
 * Pure function — no I/O — so it stays testable.
 */
export function analyzeComfyWorkflow(workflow, sourceLabel) {
	const ui = Array.isArray(workflow?.nodes);

	/** Normalized nodes: { id, type, title, mode, role, params, text, inputs }. */
	const nodes = [];
	/** Directed edges: { from, fromType, to, toType, kind }. */
	const edges = [];

	if (ui) {
		const byId = new Map();
		for (const raw of workflow.nodes) {
			if (!raw || typeof raw.type !== "string") continue;
			const node = {
				id: raw.id,
				type: raw.type,
				title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : undefined,
				mode: raw.mode ?? 0,
				role: nodeRole(raw.type),
				params: nodeParams(raw),
				text: widgetString(raw).slice(0, 4000),
				pos: Array.isArray(raw.pos) ? raw.pos : undefined,
				size: Array.isArray(raw.size) ? raw.size : undefined,
				inputs: Array.isArray(raw.inputs) ? raw.inputs.map((i) => ({ name: i?.name, type: i?.type, link: i?.link })) : []
			};
			nodes.push(node);
			byId.set(String(raw.id), node);
		}
		for (const link of Array.isArray(workflow.links) ? workflow.links : []) {
			// Canonical UI link shape: [id, originNodeId, originSlot, targetNodeId, targetSlot, type]
			if (!Array.isArray(link) || link.length < 5) continue;
			const from = byId.get(String(link[1]));
			const to = byId.get(String(link[3]));
			if (!from || !to) continue;
			const targetSlot = Number(link[4]);
			const toInput = Array.isArray(to.inputs) && Number.isInteger(targetSlot) ? to.inputs[targetSlot]?.name : undefined;
			edges.push({ from: from.id, fromType: from.type, to: to.id, toType: to.type, kind: typeof link[5] === "string" ? link[5] : "link", toInput });
		}
	} else {
		for (const [id, def] of Object.entries(workflow ?? {})) {
			if (!def || typeof def !== "object") continue;
			const params = {};
			const textParts = [];
			const inputs = {};
			for (const [key, value] of Object.entries(def.inputs ?? {})) {
				if (Array.isArray(value)) {
					inputs[key] = { from: value[0], fromOutput: value[1] };
					continue;
				}
				if (value === null || value === undefined || typeof value === "object") continue;
				params[key] = value;
				// Prompt-bearing inputs are text even when short; other long strings are prose worth surfacing.
				if (typeof value === "string" && (/^(text|prompt|string|positive|negative)$/i.test(key) || value.length > 60)) textParts.push(value);
			}
			nodes.push({
				id,
				type: def.class_type,
				mode: def.mode ?? 0,
				role: nodeRole(def.class_type),
				params,
				text: textParts.join("\n").slice(0, 4000),
				inputs: Object.entries(inputs).map(([k, v]) => ({ name: k, type: v.fromOutput, from: v.from })),
				_apiLinked: Object.values(inputs).map((v) => String(v.from))
			});
		}
		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const node of nodes) {
			for (const link of node.inputs) {
				if (!link.from) continue;
				const from = byId.get(String(link.from));
				if (!from) continue;
				edges.push({ from: from.id, fromType: from.type, to: node.id, toType: node.type, kind: link.type ?? "link", toInput: link.name });
			}
		}
	}

	// Groups: ComfyUI UI JSON has no explicit membership list, only a bounding box,
	// so derive membership from node-centre containment.
	const groups = ui && Array.isArray(workflow.groups)
		? workflow.groups.map((g) => {
			const b = Array.isArray(g?.bounding) ? g.bounding : Array.isArray(g?.boundingBox) ? g.boundingBox : null;
			let members = Array.isArray(g?.nodes) ? g.nodes.map(String) : [];
			if (members.length === 0 && b && b.length >= 4) {
				const [gx, gy, gw, gh] = b.map(Number);
				members = nodes
					.filter((n) => {
						if (!Array.isArray(n.pos)) return false;
						const [nx, ny] = n.pos.map(Number);
						const [nw, nh] = Array.isArray(n.size) ? n.size.map(Number) : [0, 0];
						const cx = nx + nw / 2;
						const cy = ny + nh / 2;
						return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
					})
					.map((n) => String(n.id));
			}
			return { title: g?.title, nodes: members };
		})
		: [];

	// Role histogram + feature inference.
	const roles = {};
	for (const node of nodes) roles[node.role] = (roles[node.role] ?? 0) + 1;
	const types = nodes.map((n) => n.type);
	const has = (re) => types.some((t) => re.test(t));
	const concepts = [];
	if (has(/KSampler|SamplerCustom/i)) concepts.push("文本→图像（txt2img）扩散采样");
	// img2img / inpaint is only real when an ENCODED image (not a mere loader) reaches the sampler latent.
	const encodedTypes = /VAEEncode|ImageToLatent|LoadLatent|Inpaint|SetLatentNoiseMask/i;
	const latentSources = edges
		.filter((e) => /^(latent_image|latent|samples)$/i.test(e.toInput ?? "") && /Sampler|Upscale|VAEDecode/i.test(e.toType))
		.map((e) => e.fromType);
	if (has(/KSampler|SamplerCustom/i) && (has(encodedTypes) || latentSources.some((t) => encodedTypes.test(t)))) {
		concepts.push("图→图 / 局部重绘（mask 或 latent 噪声）");
	}
	if (has(/ControlNet/i)) concepts.push("ControlNet 结构化约束（姿态/深度/边缘）");
	if (has(/LoraLoader/i)) concepts.push("LoRA 微调风格/角色");
	if (has(/IPAdapter/i)) concepts.push("IPAdapter 图像提示");
	if (has(/Upscale|ESRGAN|ImageScale/i)) concepts.push("放大/超分后处理");
	if (has(/AnimateDiff|VideoModel|WanVideo|SVD|HunyuanVideo|VHS_VideoCombine|LTXV/i)) concepts.push("视频/动画生成");
	if (has(/Inpaint/i)) concepts.push("局部修补");
	if (nodes.some((n) => n.mode === 4)) concepts.push("存在被静音的节点（mode=4），说明可切换分支");

	const textNodes = nodes.filter((n) => /CLIPTextEncode|Text|Prompt/i.test(n.type) && n.text);
	const loaders = nodes.filter((n) => n.role === "模型加载" || n.role === "LoRA");
	const samplers = nodes.filter((n) => n.role === "采样器");

	return {
		format: ui ? "ui" : "api",
		sourceLabel,
		nodeCount: nodes.length,
		edgeCount: edges.length,
		groupCount: groups.length,
		roles,
		concepts,
		nodes,
		edges,
		groups,
		textNodes,
		loaders,
		samplers,
		hasUI: ui
	};
}

/** Render the analysis as a Markdown document. */
export function renderComfyMd(analysis, title) {
	const L = [];
	const heading = title && title.length > 0 ? title : `${analysis.sourceLabel ?? "ComfyUI 工作流"} 解析`;
	L.push(`# ${heading}`, "");
	L.push(`> 来源：\`${analysis.sourceLabel ?? "(inline)"}\` · 格式：**${analysis.format}** · 节点 ${analysis.nodeCount} · 连线 ${analysis.edgeCount} · 分组 ${analysis.groupCount}`, "");

	L.push("## 1. 这是什么", "");
	if (analysis.concepts.length === 0) L.push("工作流由基础节点组成，未检测到明显的进阶特征。");
	else for (const c of analysis.concepts) L.push(`- ${c}`);
	L.push("");

	L.push("## 2. 节点构成", "");
	L.push("| 角色 | 数量 |", "|---|---|");
	for (const [role, count] of Object.entries(analysis.roles).sort((a, b) => b[1] - a[1])) L.push(`| ${role} | ${count} |`);
	L.push("");

	if (analysis.loaders.length > 0) {
		L.push("## 3. 模型与 LoRA", "");
		L.push("| # | 节点类型 | 关键值 |", "|---|---|---|");
		for (const n of analysis.loaders) {
			const vals = Object.entries(n.params).filter(([k]) => /name|ckpt|lora|model|strength|weight/i.test(k)).map(([k, v]) => `${k}=${v}`).join("; ");
			L.push(`| ${n.id} | ${n.type} | ${vals || "—"} |`);
		}
		L.push("");
	}

	if (analysis.samplers.length > 0) {
		L.push("## 4. 采样参数", "");
		L.push("| # | 节点类型 | 已知参数 |", "|---|---|---|");
		for (const n of analysis.samplers) {
			const vals = Object.entries(n.params).map(([k, v]) => `${k}=${v}`).join("; ");
			L.push(`| ${n.id} | ${n.type} | ${vals || "（参数在 widget 中，见附录）"} |`);
		}
		L.push("");
	}

	if (analysis.textNodes.length > 0) {
		L.push("## 5. 提示词", "");
		for (const n of analysis.textNodes) {
			L.push(`### 节点 ${n.id} · ${n.type}${n.title ? ` · ${n.title}` : ""}`, "", "```text", n.text, "```", "");
		}
	}

	if (analysis.groups.length > 0) {
		L.push("## 6. 分组（设计者的模块划分）", "");
		for (const g of analysis.groups) L.push(`- **${g.title ?? "(未命名)"}** — ${g.nodes.length} 个节点：${g.nodes.join(", ")}`);
		L.push("");
	}

	L.push("## 7. 执行链路（数据流）", "");
	if (analysis.edges.length === 0) L.push("（未解析到连线，可能是 API 格式或被裁剪的工作流）");
	else {
		L.push("```text");
		const seen = new Set();
		for (const e of analysis.edges) {
			const line = `${e.from}:${e.fromType}  ->  ${e.to}:${e.toType}  [${e.kind}]`;
			if (seen.has(line)) continue;
			seen.add(line);
			L.push(line);
		}
		L.push("```");
	}
	L.push("");

	L.push("## 8. 附录：全部节点", "");
	L.push("| # | type | title | mode | 角色 | 参数 |", "|---|---|---|---|---|---|");
	for (const n of analysis.nodes) {
		const vals = Object.entries(n.params).map(([k, v]) => `${k}=${v}`).join("; ").replace(/\|/g, "\\|");
		L.push(`| ${n.id} | ${n.type} | ${n.title ?? ""} | ${n.mode} | ${n.role} | ${vals.slice(0, 300)} |`);
	}
	L.push("");
	return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Source ingestion
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Web extraction — main-content scoring, retries, multi-page, charset
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Attributes/class hints that mark chrome rather than content. */
const CHROME_HINT = /(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|footer|header|comment|comments|share|social|ad|ads|advert|promo|cookie|consent|breadcrumb|pagination|pager|toc|related|recommend|subscribe|newsletter|banner|toolbar|modal|popup|login|signup|search)([-_ ]|$)/i;

/**
 * Spans of the given container tags, matched with an explicit stack.
 *
 * There is no DOM here on purpose: the plugin is dependency-free (`link:`
 * installs cannot resolve third-party packages), and a stack over open/close tags
 * is enough to score containers and pick the main one.
 */
function containerSpans(html, tags) {
	const names = new Set(tags);
	const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
	const stack = [];
	const spans = [];
	let match;
	while ((match = re.exec(html)) !== null) {
		const tag = match[2].toLowerCase();
		if (!names.has(tag) || VOID_TAGS.has(tag)) continue;
		const selfClosing = /\/>$/.test(match[0]);
		if (match[1] !== "/") {
			if (!selfClosing) stack.push({ tag, attrs: match[3] ?? "", start: match.index, contentStart: re.lastIndex });
			continue;
		}
		for (let i = stack.length - 1; i >= 0; i -= 1) {
			if (stack[i].tag !== tag) continue;
			const open = stack.splice(i, 1)[0];
			spans.push({ tag: open.tag, attrs: open.attrs, start: open.start, end: re.lastIndex, inner: html.slice(open.contentStart, match.index) });
			break;
		}
	}
	return spans;
}

/** Score one container the way readability does: text beats links, chrome loses. */
function scoreContainer(span) {
	const text = htmlToText(span.inner);
	const linkText = (span.inner.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).map(htmlToText).join("").length;
	const paragraphs = (span.inner.match(/<p\b/gi) ?? []).length;
	const chrome = (String(span.attrs).match(CHROME_HINT) ?? []).length;
	const structuralBonus = /^(article|main)$/i.test(span.tag) ? 120 : 0;
	return {
		text,
		score: text.length + paragraphs * 25 + structuralBonus - linkText * 3 - chrome * 250,
		linkRatio: text.length === 0 ? 1 : linkText / text.length
	};
}

/**
 * Pick the main content of a page without a readability dependency.
 *
 * Removes chrome tags first, then scores every container; the winner is the
 * highest score that also clears a minimum length. Falls back to the whole
 * document, so a page this heuristic misreads still produces something usable.
 */
export function extractMainHtml(html, { minLength = 200 } = {}) {
	const cleaned = String(html)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|iframe|template|form)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<(nav|aside|footer|header)\b[\s\S]*?<\/\1>/gi, "");
	const spans = containerSpans(cleaned, ["article", "main", "div", "section", "td", "body"]);
	const eligible = [];
	for (const span of spans) {
		const scored = scoreContainer(span);
		if (scored.text.length < minLength) continue;
		// A container that is mostly links is navigation, however long it is.
		if (scored.linkRatio > 0.6) continue;
		eligible.push({ span, scored });
	}
	// `<body>` is the fallback, never the winner: it wraps the chrome that survived
	// stripping (skip-links, banners), so when a real content container clears the
	// bar it wins even though it is a few characters shorter.
	const semantic = eligible.filter((entry) => entry.span.tag !== "body");
	const pool = semantic.length > 0 ? semantic : eligible;
	let best;
	for (const entry of pool) {
		if (best === undefined || entry.scored.score > best.scored.score) best = entry;
	}
	if (best === undefined) {
		const fallback = htmlToText(cleaned);
		return { html: cleaned, text: fallback, strategy: "whole-document", score: fallback.length };
	}
	return { html: best.span.inner, text: best.scored.text, strategy: `${best.span.tag}-container`, score: best.scored.score };
}

/** Decode page bytes honouring `<meta charset>` / `Content-Type`, falling back to UTF-8. */
export function decodeHtmlBytes(buffer, contentType = "") {
	const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	const head = bytes.subarray(0, 4096).toString("latin1");
	const declared = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
	const candidates = [declared, "utf-8"].filter((c) => typeof c === "string" && c.length > 0);
	for (const charset of candidates) {
		try {
			return { text: new TextDecoder(charset, { fatal: false }).decode(bytes), charset };
		} catch {
			/* unsupported label — try the next one */
		}
	}
	return { text: bytes.toString("utf8"), charset: "utf-8" };
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Fetch with exponential backoff.
 *
 * Only transport failures and 5xx/429 are retried: a 404 will never become a 200,
 * and hammering a site that already said no is both useless and rude.
 */
export async function fetchWithRetry(url, { config = {}, attempts, fetchImpl, sleep } = {}) {
	const tries = Math.max(1, Number.isFinite(attempts) ? Number(attempts) : Number(config.fetchRetries ?? 3) || 3);
	const doFetch = fetchImpl ?? config.fetchImpl ?? fetch;
	const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	let lastError;
	for (let attempt = 1; attempt <= tries; attempt += 1) {
		try {
			const response = await doFetch(url, {
				headers: {
					"user-agent": config.userAgent ?? "dsh-distillation",
					accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5"
				},
				redirect: "follow"
			});
			if (response.ok) return { response, attempts: attempt };
			const error = new Error(`fetch ${url} failed: HTTP ${response.status} ${response.statusText}`);
			if (!RETRYABLE_STATUS.has(response.status)) throw Object.assign(error, { noRetry: true });
			lastError = error;
		} catch (error) {
			if (error?.noRetry === true) throw error;
			lastError = error;
			if (attempt === tries) break;
		}
		if (attempt < tries) await wait(Math.min(8000, 400 * 2 ** (attempt - 1)));
	}
	throw lastError ?? new Error(`fetch ${url} failed`);
}

/** Same-origin links worth following, in document order, deduplicated by path. */
export function sameOriginLinks(baseUrl, html, { limit = 5 } = {}) {
	const base = new URL(baseUrl);
	const selfKey = base.origin + base.pathname;
	const seen = new Set();
	const links = [];
	for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		const href = match[1].trim();
		if (/^(#|mailto:|javascript:|tel:|data:)/i.test(href)) continue;
		let abs;
		try {
			abs = new URL(href, base);
		} catch {
			continue;
		}
		if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
		if (abs.origin !== base.origin) continue;
		if (/\.(png|jpe?g|gif|svg|webp|ico|zip|gz|tgz|pdf|mp4|mp3|css|js|json|xml|rss)$/i.test(abs.pathname)) continue;
		abs.hash = "";
		const key = abs.origin + abs.pathname;
		if (key === selfKey || seen.has(key)) continue;
		seen.add(key);
		links.push({ url: abs.href, text: htmlToText(match[2]).replace(/\s+/g, " ").trim().slice(0, 80) });
		if (links.length >= limit) break;
	}
	return links;
}

/** Fetch and normalize one URL (no page following — `ingestSource` orchestrates that). */
export async function ingestUrl(url, config) {
	const { response, attempts } = await fetchWithRetry(url, { config });
	const contentType = response.headers.get("content-type") ?? "";
	const buffer = Buffer.from(await response.arrayBuffer());
	const bytes = buffer.byteLength;
	if (bytes > config.maxSourceBytes) throw new Error(`source ${url} exceeds maxSourceBytes (${bytes} > ${config.maxSourceBytes})`);
	const asText = () => decodeHtmlBytes(buffer, contentType).text;
	const trimmed = asText().trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[") || contentType.includes("json")) {
		let json;
		try {
			json = JSON.parse(trimmed);
		} catch {
			json = undefined;
		}
		if (json !== undefined && isComfyWorkflow(json)) {
			const analysis = analyzeComfyWorkflow(json, url);
			return { label: url, kind: "comfyui", text: renderComfyMd(analysis, undefined), meta: { format: analysis.format, nodeCount: analysis.nodeCount, edges: analysis.edgeCount, attempts }, analysis };
		}
		return { label: url, kind: "json", text: "```json\n" + trimmed.slice(0, config.maxSourceBytes) + "\n```", meta: { bytes: trimmed.length, attempts } };
	}
	if (contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(trimmed)) {
		const { text: html, charset } = decodeHtmlBytes(buffer, contentType);
		const main = extractMainHtml(html);
		return {
			label: htmlTitle(html) ?? url,
			kind: "html",
			text: main.text,
			html,
			meta: { url, bytes, charset, attempts, strategy: main.strategy, extracted: main.text.length, mainScore: Math.round(main.score) }
		};
	}
	return { label: url, kind: "text", text: asText(), meta: { url, bytes, attempts } };
}

/** Read one source (local path or http(s) URL) into `{ label, kind, text, meta }`. */
export async function ingestSource(source, config) {
	const isUrl = /^https?:\/\//i.test(source);
	if (isUrl) {
		const page = await ingestUrl(source, config);
		const raw = page.html;
		delete page.html;
		const followCap = Math.max(0, Number(config.maxFollowPages ?? 5) || 5);
		const follow = Math.min(Math.max(0, Number(config.followPages ?? 0) || 0), followCap);
		if (follow > 0 && page.kind === "html" && typeof raw === "string") {
			const extraPages = [];
			for (const link of sameOriginLinks(source, raw, { limit: follow })) {
				try {
					const sub = await ingestUrl(link.url, { ...config, followPages: 0 });
					delete sub.html;
					extraPages.push({ ...sub, linkText: link.text });
				} catch (error) {
					extraPages.push({ label: link.url, kind: "error", text: `（抓取失败：${error?.message ?? error}）`, meta: { url: link.url } });
				}
			}
			return { ...page, extraPages, meta: { ...page.meta, followed: extraPages.length } };
		}
		return page;
	}

	const abs = resolvePath(expandTilde(source));
	const info = await stat(abs);
	if (!info.isFile()) throw new Error(`source is not a file: ${abs}`);
	if (info.size > config.maxSourceBytes) throw new Error(`source ${abs} exceeds maxSourceBytes (${info.size})`);
	const ext = extname(abs).toLowerCase();
	const raw = await readFile(abs, "utf8");
	if (ext === ".json" || ext === ".workflow" || ext === ".wf") {
		let json;
		try { json = JSON.parse(raw); } catch (error) { throw new Error(`${abs} is not valid JSON: ${error.message}`); }
		if (isComfyWorkflow(json)) {
			const analysis = analyzeComfyWorkflow(json, abs);
			return { label: basename(abs), kind: "comfyui", text: renderComfyMd(analysis, `${basename(abs)} 解析`), meta: { format: analysis.format, nodeCount: analysis.nodeCount, edges: analysis.edgeCount }, analysis };
		}
		return { label: basename(abs), kind: "json", text: "```json\n" + raw + "\n```", meta: { bytes: raw.length } };
	}
	if (ext === ".html" || ext === ".htm") {
		return { label: htmlTitle(raw) ?? basename(abs), kind: "html", text: htmlToText(raw), meta: { path: abs, bytes: raw.length } };
	}
	return { label: basename(abs), kind: ext.replace(/^\./, "") || "text", text: raw, meta: { path: abs, bytes: raw.length } };
}

/** Compose the combined analysis document written by `distill_sources`. */
export function renderSourcesMd(title, results) {
	const L = [`# ${title}`, "", `共 ${results.length} 个来源，生成时间 ${new Date().toISOString()}`, ""];
	for (const r of results) {
		L.push(`## 来源：${r.label}`, "", `- 类型：\`${r.kind}\``);
		for (const [k, v] of Object.entries(r.meta ?? {})) L.push(`- ${k}：${v}`);
		L.push("", r.text.trim(), "", "---", "");
		for (const extra of r.extraPages ?? []) {
			L.push(`### 附页：${extra.label}`, "");
			if (extra.linkText) L.push(`- 链接文字：${extra.linkText}`);
			for (const [k, v] of Object.entries(extra.meta ?? {})) L.push(`- ${k}：${v}`);
			L.push("", extra.text.trim(), "");
		}
		if ((r.extraPages ?? []).length > 0) L.push("---", "");
	}
	return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Docs sites — find llms.txt, pick pages, distill one document or many skills
 * ------------------------------------------------------------------ */

/**
 * Parse an `llms.txt` / `llms-full.txt` index.
 *
 * The convention (llmstxt.org) is Markdown: optional `##` sections and one
 * `- [Title](url): description` per page — which is exactly the shape this
 * returns. Links ending in `.md` are already plain Markdown, so they need no
 * HTML extraction at all.
 */
export function parseLlmsIndex(text, baseUrl) {
	const entries = [];
	let heading = [];
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		const head = /^(#{1,6})\s+(.*)$/.exec(line);
		if (head) {
			heading = heading.slice(0, head[1].length - 1);
			heading[head[1].length - 1] = head[2].trim();
			continue;
		}
		const link = /^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/.exec(line);
		if (!link) continue;
		let absolute;
		try {
			absolute = new URL(link[2], baseUrl);
		} catch {
			continue;
		}
		if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
		entries.push({
			title: link[1].trim(),
			url: absolute.href,
			description: (link[3] ?? "").trim(),
			// The deepest heading is the useful grouping label; the H1 is the
			// document title and would prefix every single entry.
			section: heading.filter(Boolean).slice(-1)[0] ?? "",
			sectionPath: heading.filter(Boolean).join(" › "),
			markdown: /\.mdx?$/i.test(absolute.pathname)
		});
	}
	return { entries, markdownCount: entries.filter((entry) => entry.markdown).length };
}

/** Probe the conventional index locations for a docs site. */
export async function probeLlmsTxt(siteUrl, config = {}) {
	const base = new URL(siteUrl);
	const origin = base.origin;
	const dir = base.pathname.replace(/\/[^/]*$/, "");
	const candidates = [`${origin}/llms.txt`];
	if (dir && dir !== "/" && dir !== "") candidates.push(`${origin}${dir}/llms.txt`);
	candidates.push(`${origin}/llms-full.txt`);
	const tried = [];
	for (const candidate of candidates) {
		tried.push(candidate);
		try {
			const page = await ingestUrl(candidate, { ...config, followPages: 0 });
			const parsed = parseLlmsIndex(page.text ?? "", candidate);
			// A handful of links is the minimum that makes an index useful; below
			// that it is a redirect page or an error page that happened to be 200.
			if (parsed.entries.length >= 3) {
				return { found: true, url: candidate, tried, format: candidate.endsWith("llms-full.txt") ? "full" : "index", ...parsed };
			}
		} catch {
			/* try the next candidate */
		}
	}
	return { found: false, url: undefined, tried, format: undefined, entries: [], markdownCount: 0 };
}

/** Decide which pages to fetch: the index when it exists, same-origin links otherwise. */
export async function planDocsPages({ url, config = {}, limit = 20 }) {
	const llms = await probeLlmsTxt(url, config);
	if (llms.found) {
		const markdown = llms.entries.filter((entry) => entry.markdown);
		const pool = markdown.length > 0 ? markdown : llms.entries;
		// The pool is intentionally NOT sliced here: callers filter first and limit
		// second, so `--filter` searches the whole index instead of only the first
		// N entries (which is what made "filter + limit" miss every match).
		return { strategy: "llms.txt", indexUrl: llms.url, total: pool.length, pages: pool, all: pool, llms };
	}
	const page = await ingestUrl(url, { ...config, followPages: 0 });
	const links = typeof page.html === "string" ? sameOriginLinks(url, page.html, { limit }) : [];
	return {
		strategy: "html-links",
		indexUrl: url,
		total: links.length,
		pages: links.map((link) => ({ title: link.text || link.url, url: link.url, description: "", section: "", markdown: false })),
		all: [],
		llms,
		landingText: page.text
	};
}

/** Substring or `/regex/` filtering over title, url and description. */
export function filterDocPages(pages, filter) {
	if (typeof filter !== "string" || filter.trim().length === 0) return pages;
	const asRegex = /^\/(.*)\/([a-z]*)$/.exec(filter.trim());
	const matches = (page) => {
		const haystack = `${page.title} ${page.url} ${page.description}`;
		if (asRegex) {
			try {
				return new RegExp(asRegex[1], asRegex[2] || "i").test(haystack);
			} catch {
				return false;
			}
		}
		return haystack.toLowerCase().includes(filter.trim().toLowerCase());
	};
	return pages.filter(matches);
}

/** Merge fetched pages into one reviewable Markdown document. */
export function renderDocsMd(title, { url, strategy, indexUrl, pages, total }) {
	const L = [
		`# ${title} 文档蒸馏`,
		"",
		`- 站点：${url}`,
		`- 发现方式：${strategy === "llms.txt" ? `llms.txt（${indexUrl}）` : "同源链接跟随（该站没有 llms.txt）"}`,
		`- 可选页面：${total}；本次抓取：${pages.length}`,
		"",
		"## 目录",
		""
	];
	pages.forEach((page, index) => L.push(`${index + 1}. ${page.title || page.url} — ${page.url}`));
	L.push("");
	for (const page of pages) {
		L.push(`## ${page.title || page.url}`, "");
		L.push(`- 来源：${page.url}`);
		if (page.section) L.push(`- 章节：${page.section}`);
		if (page.description) L.push(`- 说明：${page.description}`);
		L.push(`- 类型：\`${page.kind}\``, "");
		L.push((page.text ?? "").trim(), "", "---", "");
	}
	return L.join("\n");
}

const firstSentence = (text) => {
	const line = String(text ?? "")
		.split(/\r?\n/)
		.map((l) => l.replace(/^#+\s*/, "").trim())
		.find((l) => l.length >= 20 && !l.startsWith("-") && !l.startsWith("|"));
	return line === undefined ? undefined : line.slice(0, 200);
};

/** ASCII-only skill id (DSH requires `^[a-z0-9]+(?:-[a-z0-9]+)*$`). */
function asciiSkillBase(text, max = 48) {
	return String(text)
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, max)
		.replace(/-+$/, "");
}

/**
 * Derive a valid skill id for one docs page.
 *
 * Titles of a Chinese docs site slugify to CJK, which the DSH loader rejects, so
 * the id comes from the URL path instead (locale prefix dropped) — and a name
 * already taken in this batch, or already on disk, gets a numeric suffix rather
 * than silently overwriting someone's skill.
 */
/** Two-letter (or zh-CN style) locale prefixes that carry no naming value. */
const LOCALE_PREFIX = /^(en|zh|ja|ko|es|fr|de|pt|ru|it|hi|vi|th|id|ar|nl|pl|tr|uk)(-[a-z]{2})?$/i;

function docsSkillName(title, pageUrl, taken, root) {
	let segments = [];
	try {
		segments = new URL(pageUrl).pathname
			.split("/")
			.filter(Boolean)
			.map((part) => part.replace(/\.[a-z0-9]+$/i, ""));
	} catch {
		segments = [];
	}
	if (segments.length > 1 && LOCALE_PREFIX.test(segments[0])) segments = segments.slice(1);
	let base = asciiSkillBase(segments.slice(-2).join("-"));
	if (base.length === 0) base = asciiSkillBase(segments.slice(-1).join("-"));
	if (base.length === 0) base = asciiSkillBase(title);
	if (base.length === 0) base = "docs-page";
	let candidate = base;
	for (let n = 2; taken.includes(candidate) || (root !== undefined && existsSync(join(root, candidate))); n += 1) {
		candidate = `${base}-${n}`;
	}
	return candidate;
}

/**
 * Distill a docs site: probe the index, fetch the selected pages, then either
 * merge them into ONE document or write ONE skill per page.
 *
 * A page that fails to fetch is reported inside the document rather than
 * aborting the batch — a docs site always has a few dead links.
 */
export async function distillDocs({
	url,
	config = {},
	filter,
	limit = 20,
	perPage = false,
	skillName,
	target = "user",
	cwd,
	now = new Date()
} = {}) {
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("distillDocs: an http(s) docs site URL is required");
	const plan = await planDocsPages({ url, config, limit: Math.max(1, Number(limit) || 20) });
	// Filter the WHOLE index, then take the first `limit` matches.
	const matching = filterDocPages(plan.pages, filter);
	const selected = matching.slice(0, Math.max(1, Number(limit) || 20));
	if (selected.length === 0) {
		throw new Error(
			`no pages to distill from ${url} (discovery: ${plan.strategy}${filter ? `, filter "${filter}"` : ""}; ${plan.total} candidate(s), ${matching.length} after filtering)`
		);
	}
	const fetched = [];
	for (const page of selected) {
		try {
			const got = await ingestUrl(page.url, { ...config, followPages: 0 });
			fetched.push({ ...page, kind: got.kind, text: got.text, meta: got.meta });
		} catch (error) {
			fetched.push({ ...page, kind: "error", text: `（抓取失败：${error?.message ?? error}）`, meta: {} });
		}
	}
	const title = skillName ?? new URL(url).host;
	const document = renderDocsMd(title, { url, strategy: plan.strategy, indexUrl: plan.indexUrl, pages: fetched, total: plan.total });
	const base = {
		strategy: plan.strategy,
		indexUrl: plan.indexUrl,
		markdownPages: plan.llms?.markdownCount ?? 0,
		total: plan.total,
		selected: selected.length,
		fetched: fetched.filter((page) => page.kind !== "error").length,
		failed: fetched.filter((page) => page.kind === "error").map((page) => page.url),
		document,
		pages: fetched.map((page) => ({ title: page.title, url: page.url, kind: page.kind, bytes: String(page.text ?? "").length })),
		skills: [],
		root: undefined
	};
	if (!perPage) return base;

	const root = resolveSkillRoot(target, cwd, config);
	const skills = [];
	for (const page of fetched) {
		if (page.kind === "error") continue;
		const name = docsSkillName(page.title, page.url, skills.map((s) => s.name), root);
		const description = page.description || firstSentence(page.text) || `${page.title}（来自 ${new URL(url).host} 文档）`;
		const { dir } = await writeSkillBundle({ root, skillName: name, description, body: page.text });
		await recordArtifact({
			skillDir: dir,
			origin: "distill_docs",
			tool: "distill_docs",
			source: { kind: "web", label: page.url },
			note: `docs page from ${plan.indexUrl}`,
			now
		});
		skills.push({ name, dir, url: page.url, description });
	}
	return { ...base, root, skills };
}

/* ------------------------------------------------------------------ *
 * Repository extraction — clone (or read locally), scan, analyse
 * ------------------------------------------------------------------ */

/** Directories that are never part of what a repository IS. */
export const REPO_SKIP_DIRS = new Set([
	".git", "node_modules", ".venv", "venv", "env", "dist", "build", "out", "target", "vendor",
	"__pycache__", ".pytest_cache", ".mypy_cache", ".next", ".nuxt", ".cache", ".turbo",
	"coverage", ".nyc_output", ".idea", ".vscode", ".DS_Store", "Pods", ".gradle"
]);

/** Extension → language label (the long tail is fine as "Other"). */
export const LANGUAGE_BY_EXT = {
	".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
	".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
	".py": "Python", ".pyi": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust",
	".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".c": "C", ".h": "C",
	".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP",
	".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell", ".psm1": "PowerShell",
	".sql": "SQL", ".lua": "Lua", ".dart": "Dart", ".scala": "Scala", ".ex": "Elixir",
	".md": "Markdown", ".mdx": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
	".toml": "TOML", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".vue": "Vue",
	".svelte": "Svelte", ".ipynb": "Notebook", ".gradle": "Gradle", ".cmake": "CMake",
	// Assets must be labelled, not dumped into "Other": a repository whose bulk is
	// screenshots would otherwise report 95% "Other" and the language table would
	// say nothing at all.
	".png": "Image", ".jpg": "Image", ".jpeg": "Image", ".gif": "Image", ".webp": "Image",
	".bmp": "Image", ".tiff": "Image", ".ico": "Image", ".svg": "Image", ".psd": "Image",
	".woff": "Font", ".woff2": "Font", ".ttf": "Font", ".otf": "Font", ".eot": "Font",
	".zip": "Archive", ".gz": "Archive", ".tgz": "Archive", ".tar": "Archive", ".7z": "Archive",
	".rar": "Archive", ".jar": "Archive", ".whl": "Archive",
	".mp4": "Media", ".mp3": "Media", ".wav": "Media", ".mov": "Media", ".webm": "Media", ".gifv": "Media",
	".pdf": "Document", ".docx": "Document", ".pptx": "Document", ".xlsx": "Document",
	".csv": "Data", ".tsv": "Data", ".parquet": "Data", ".sqlite": "Data", ".db": "Data", ".lock": "Lockfile"
};

/** Coarse grouping, so the summary can separate what a repo IS from what it carries. */
export const ASSET_LANGUAGES = new Set(["Image", "Font", "Archive", "Media", "Document"]);

const ENTRYPOINT_FILES = [
	"package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
	"composer.json", "Gemfile", "Makefile", "Dockerfile", "docker-compose.yml", "CMakeLists.txt",
	"cangjie.py", "run.py", "main.py", "index.js", "src/index.js", "src/main.rs", "src/main.go"
];
const CI_FILES = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|azure-pipelines\.yml|\.circleci\/config\.yml|Jenkinsfile|\.travis\.yml|\.drone\.yml)$/i;
const CONVENTION_FILES = /(^|\/)(AGENTS\.md|CLAUDE\.md|\.cursorrules|CONTRIBUTING\.md|CODE_OF_CONDUCT\.md|LICENSE|LICENCE|COPYING|\.editorconfig|\.gitignore|\.prettierrc.*|\.eslintrc.*)$/i;

/**
 * Walk a checkout and gather the facts a repository analysis is made of.
 *
 * Depth-limited and size-capped on purpose: the analysis must stay useful on a
 * huge monorepo, and it must never read the whole tree into memory.
 */
export async function scanRepository(dir, { maxFiles = 4000, treeDepth = 2 } = {}) {
	const files = [];
	const ignored = new Map();
	const tree = [];
	let totalBytes = 0;
	const walk = async (current, depth, relPrefix) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
			const abs = join(current, entry.name);
			if (entry.isDirectory()) {
				if (REPO_SKIP_DIRS.has(entry.name)) {
					const counted = await countFiles(abs);
					ignored.set(entry.name, (ignored.get(entry.name) ?? 0) + counted);
					continue;
				}
				if (depth < treeDepth) tree.push(`${rel}/`);
				await walk(abs, depth + 1, rel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (files.length >= maxFiles) continue;
			let size = 0;
			try {
				size = (await stat(abs)).size;
			} catch {
				continue;
			}
			totalBytes += size;
			const ext = extname(entry.name).toLowerCase();
			files.push({ path: rel, bytes: size, lang: LANGUAGE_BY_EXT[ext] ?? "Other", ext });
		}
	};
	await walk(dir, 0, "");

	const byLang = new Map();
	for (const file of files) {
		const bucket = byLang.get(file.lang) ?? { files: 0, bytes: 0 };
		bucket.files += 1;
		bucket.bytes += file.bytes;
		byLang.set(file.lang, bucket);
	}
	const languages = [...byLang.entries()]
		.map(([lang, v]) => ({ lang, files: v.files, bytes: v.bytes, share: fileShare(v.bytes, totalBytes) }))
		.sort((a, b) => b.bytes - a.bytes);
	const assetBytes = languages.filter((l) => ASSET_LANGUAGES.has(l.lang)).reduce((sum, l) => sum + l.bytes, 0);
	const pick = (re) => files.filter((f) => re.test(f.path)).map((f) => f.path);
	return {
		fileCount: files.length,
		totalBytes,
		languages,
		assetShare: fileShare(assetBytes, totalBytes),
		codeShare: fileShare(totalBytes - assetBytes, totalBytes),
		tree,
		ignored: [...ignored.entries()].map(([name, count]) => ({ dir: name, files: count })).sort((a, b) => b.files - a.files),
		entrypoints: ENTRYPOINT_FILES.filter((name) => files.some((f) => f.path === name || f.path.endsWith(`/${name}`))),
		ci: pick(CI_FILES),
		conventions: pick(CONVENTION_FILES),
		docs: pick(/^(docs?|documentation)\/|(^|\/)(README[^/]*|CHANGELOG[^/]*|AGENTS\.md|CLAUDE\.md|SKILL\.md)$/i),
		examples: pick(/(^|\/)(examples?|samples?|demos?|templates?|benchmarks?)\//i),
		topFiles: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 15)
	};
}

function fileShare(bytes, total) {
	return total === 0 ? 0 : Math.round((bytes / total) * 1000) / 10;
}

async function countFiles(dir, limit = 20000) {
	let count = 0;
	const walk = async (current) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (count >= limit) return;
			if (entry.isDirectory()) {
				if (REPO_SKIP_DIRS.has(entry.name)) continue;
				await walk(join(current, entry.name));
			} else if (entry.isFile()) count += 1;
		}
	};
	await walk(dir);
	return count;
}

/**
 * Clone (only when needed) and analyse a repository.
 *
 * A local path is read in place — cloning a checkout the user already has would
 * be slower and would analyse a different copy than the one they are looking at.
 */
export async function analyzeRepository({ source, cwd, config = {}, runner, branch, maxFiles = 4000 } = {}) {
	if (typeof source !== "string" || source.length === 0) throw new Error("analyzeRepository: a repository URL or local path is required");
	const looksLocal = !/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(source);
	let root;
	let cloned = false;
	let cleanup;
	let cloneLog = "";
	if (looksLocal) {
		root = resolvePath(expandTilde(source));
		if (!existsSync(root)) throw new Error(`local repository path does not exist: ${root}`);
		try {
			if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${root}`);
		} catch (error) {
			throw new Error(`local repository path is not usable: ${root} (${error?.message ?? error})`);
		}
	} else {
		if (typeof runner !== "function") throw new Error("analyzeRepository: a runner is required to clone a remote repository");
		root = await mkdtemp(join(tmpdir(), "dsh-repo-"));
		cleanup = () => rm(root, { recursive: true, force: true });
		const args = ["clone", "--depth", "1", "--quiet"];
		if (branch) args.push("--branch", branch);
		args.push(source, root);
		const result = await runner({ command: "git", args, cwd: cwd ?? process.cwd(), timeoutMs: 300000 });
		if (result?.code !== 0) {
			await cleanup().catch(() => {});
			throw new Error(`git clone failed (exit ${result?.code}): ${firstLine(result?.stderr) || "unknown error"}`);
		}
		cloned = true;
		cloneLog = firstLine(result.stderr) || "";
	}
	try {
		const scan = await scanRepository(root, { maxFiles });
		// The project's README is the SHALLOWEST one: `benchmarks/toolbook/README.md`
		// must never outrank `/README.md`, and a locale-aware directory walk visits
		// `assets/` before `README.md`, so scan order alone cannot be trusted here.
		const readmeCandidates = scan.docs
			.filter((p) => /(^|\/)README/i.test(p))
			.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
		const readmePath = readmeCandidates[0] ?? scan.docs[0];
		let readme;
		let readmeText;
		if (readmePath !== undefined) {
			try {
				readmeText = await readFile(join(root, readmePath), "utf8");
				readme = { path: readmePath, bytes: readmeText.length, excerpt: readmeText.slice(0, 4000) };
			} catch {
				readme = undefined;
			}
		}
		return {
			source,
			root,
			cloned,
			cleanup,
			branch: branch ?? (cloned ? "default (depth 1)" : undefined),
			readme,
			readmePath,
			scan,
			cloneLog
		};
	} catch (error) {
		if (cleanup) await cleanup().catch(() => {});
		throw error;
	}
}

/** Render the repository analysis as the fixed 8-section document. */
export function renderRepoMd(analysis, title) {
	const { scan, readme } = analysis;
	const name = title ?? basename(analysis.root) ?? analysis.source;
	const L = [];
	L.push(`# ${name} 仓库分析`, "", `- 来源：\`${analysis.source}\``, `- 获取方式：${analysis.cloned ? "git clone --depth 1" : "本地路径直读（未 clone）"}`, `- 文件数：${scan.fileCount}`, `- 总大小：${(scan.totalBytes / 1024).toFixed(1)} KB`, "");

	L.push("## 1. 这是什么", "");
	if (readme) {
		const firstLine = readme.excerpt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("![")) ?? "";
		L.push(`- README：\`${readme.path}\`（${readme.bytes} 字符）`);
		if (firstLine) L.push(`- 首行：${firstLine.replace(/^#+\s*/, "")}`);
	} else {
		L.push("- 未找到 README：仓库没有自述文件，需从目录结构与代码入口推断用途。");
	}
	L.push("");

	L.push("## 2. 目录结构（深度 2）", "");
	L.push("```");
	for (const entry of scan.tree.slice(0, 120)) L.push(entry);
	if (scan.tree.length > 120) L.push(`… 其余 ${scan.tree.length - 120} 项省略`);
	L.push("```", "");

	L.push("## 3. 技术栈与语言占比", "");
	if (scan.languages.length === 0) {
		L.push("- 未统计到任何文件（空仓库或全部被忽略）");
	} else {
		L.push("| 语言 | 文件数 | 大小 | 占比 |", "|---|---|---|---|");
		for (const lang of scan.languages.slice(0, 12)) L.push(`| ${lang.lang} | ${lang.files} | ${(lang.bytes / 1024).toFixed(1)} KB | ${lang.share}% |`);
	}
	if (scan.ignored.length > 0) L.push("", `忽略目录：${scan.ignored.map((i) => `${i.dir}(${i.files})`).join("、")}`);
	L.push("", `代码与文档占 ${scan.codeShare}%，二进制资源占 ${scan.assetShare}%。`);
	L.push("");

	L.push("## 4. 入口与构建", "");
	L.push(scan.entrypoints.length > 0 ? scan.entrypoints.map((p) => `- \`${p}\``).join("\n") : "- 未发现常见入口/构建文件");
	L.push("");

	L.push("## 5. 文档", "");
	L.push(scan.docs.length > 0 ? scan.docs.slice(0, 40).map((p) => `- \`${p}\``).join("\n") : "- 未发现文档文件");
	L.push("");

	L.push("## 6. 示例", "");
	L.push(scan.examples.length > 0 ? scan.examples.slice(0, 40).map((p) => `- \`${p}\``).join("\n") : "- 未发现示例目录");
	L.push("");

	L.push("## 7. 约定与 CI", "");
	L.push(scan.ci.length > 0 ? `- CI：${scan.ci.slice(0, 20).map((p) => `\`${p}\``).join("、")}` : "- CI：未发现");
	L.push(scan.conventions.length > 0 ? `- 约定文件：${scan.conventions.slice(0, 20).map((p) => `\`${p}\``).join("、")}` : "- 约定文件：未发现");
	L.push("");

	L.push("## 8. 附录：最大的文件", "");
	L.push("| 文件 | 大小 | 语言 |", "|---|---|---|");
	for (const file of scan.topFiles) L.push(`| \`${file.path}\` | ${(file.bytes / 1024).toFixed(1)} KB | ${file.lang} |`);
	L.push("");
	if (readme) {
		L.push("## 附录：README 摘录", "", "```markdown", readme.excerpt.trim(), "```", "");
	}
	return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Skill bundle writing
 * ------------------------------------------------------------------ */

/** Build the SKILL.md text from parts, validating the frontmatter contract. */
export function buildSkillMarkdown({ name: skillName, description, body, whenToUse }) {
	if (!SKILL_NAME.test(skillName)) throw new Error(`invalid skill name "${skillName}": must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/`);
	if (typeof description !== "string" || description.trim().length === 0) throw new Error("description is required and must be a non-empty string");
	if (description.includes("\n")) {
		// Multi-line descriptions must stay valid YAML: emit a block scalar.
		const indented = description.split("\n").map((l) => "  " + l).join("\n");
		return `---\nname: ${skillName}\ndescription: |\n${indented}\n${whenToUse ? `when-to-use: ${whenToUse}\n` : ""}---\n\n${body?.trim() ?? ""}\n`;
	}
	return `---\nname: ${skillName}\ndescription: ${description.trim()}\n${whenToUse ? `when-to-use: ${whenToUse}\n` : ""}---\n\n${body?.trim() ?? ""}\n`;
}

/** Write a full skill bundle. Returns the written absolute paths. */
export async function writeSkillBundle({ root, skillName, description, body, whenToUse, extraFiles }) {
	const dir = join(root, skillName);
	await mkdir(dir, { recursive: true });
	const main = join(dir, "SKILL.md");
	await writeFile(main, buildSkillMarkdown({ name: skillName, description, body, whenToUse }), "utf8");
	const written = [main];
	for (const extra of extraFiles ?? []) {
		if (!extra || typeof extra.path !== "string" || extra.path.length === 0) continue;
		const rel = extra.path.replace(/^[/\\]+/, "").replace(/\.\./g, "_");
		const target = join(dir, rel);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, String(extra.content ?? ""), "utf8");
		written.push(target);
	}
	return { dir, written };
}

/** Inspect the known skill roots and report what the provider should discover. */
export async function inspectRoots(cwd, config = {}) {
	// One source of truth: whatever defaultSkillRoots reports is what the provider
	// serves, so `distill_list` can never disagree with what `skill()` can load.
	const roots = defaultSkillRoots(cwd, config).map((root) => ({ kind: root.source, rank: root.rank, dir: root.dir }));
	const bundled = process.env.DSH_BUNDLED_SKILL_DIR;
	if (bundled) roots.push({ kind: "bundled", rank: 0, dir: resolvePath(bundled) });
	roots.sort((a, b) => a.rank - b.rank || a.dir.localeCompare(b.dir));

	const out = [];
	for (const root of roots) {
		const entry = { ...root, exists: false, skills: [] };
		try {
			if (existsSync(root.dir)) {
				entry.exists = true;
				for (const child of await readdir(root.dir, { withFileTypes: true })) {
					if (child.name.startsWith(".")) continue;
					// Treat symlinks / Windows junctions like the host provider does: a
					// link that carries a SKILL.md is a skill directory.
					if (child.isDirectory() || child.isSymbolicLink()) {
						if (existsSync(join(root.dir, child.name, "SKILL.md"))) entry.skills.push(child.name);
					} else if (child.isFile() && child.name.endsWith(".md")) {
						entry.skills.push(child.name.replace(/\.md$/, ""));
					}
				}
			}
		} catch (error) {
			entry.error = error.message;
		}
		out.push(entry);
	}
	return out;
}

export const lines = (arr) => arr.filter((l) => typeof l === "string" && l.length > 0).join("\n");

/** Resolve the effective working directory for a tool call. */
export const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

/* ------------------------------------------------------------------ *
 * Doctor — report what the engines need, and the command that fixes it
 * ------------------------------------------------------------------ */

/** Where the last doctor report is cached (`$DSH_HOME/distillation/doctor.json`). */
export const doctorReportPath = () => join(dshHome(), "distillation", "doctor.json");

/**
 * Hash of a file's *canonical* content.
 *
 * Line endings are normalised away on purpose: the vendored engines are recorded
 * with this hash, and a Windows checkout (CRLF) must not look "modified" when a
 * Linux checkout (LF) of the same file does not. Binary payloads hash as bytes.
 */
export function contentHash(buf) {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Run the environment self-check.
 *
 * Only deterministic facts are reported: versions, file existence, hashes and
 * writability. The `runner` seam is optional — a check that needs to execute a
 * command reports `status: "skip"` when the seam is missing, so the report stays
 * useful inside a profile without the subprocess service instead of failing.
 *
 * Every non-ok check carries a `fix` (or an explicit "nothing to fix"), because
 * "装上就能跑" is only true if the user is told exactly what is missing.
 */
export async function runDoctor({ cwd, config = {}, runner, probe = true, runtime } = {}) {
	const checks = [];
	const push = (id, label, status, detail, fix) => checks.push({ id, label, status, detail, ...(fix ? { fix } : {}) });
	const run = async (command, args, timeoutMs = 60_000) => {
		if (!runner) return undefined;
		try {
			return await runner({ command, args, cwd, timeoutMs });
		} catch (error) {
			return { code: null, stdout: "", stderr: String(error?.message ?? error), timedOut: false };
		}
	};
	const firstLine = (text) => String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";

	// 1. Node itself.
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	push("node", "Node.js ≥ 22", nodeMajor >= 22 ? "ok" : "fail", process.version, nodeMajor >= 22 ? undefined : "安装 Node 22+ 后重启 DSH");

	// 2. The engines this package ships, and whether they still match the record.
	const engines = await listBundledEngines();
	const enginesDir = bundledEnginesDir();
	const missingSkill = engines.filter((e) => !e.skillFile).map((e) => e.id);
	if (engines.length === 0) {
		push("engines", "内置引擎", "fail", "本包内没有 engines/ 目录（安装不完整）", "plugin_manager install_bundle <包目录绝对路径> 重新安装");
	} else {
		push(
			"engines",
			"内置引擎",
			missingSkill.length === 0 ? "ok" : "warn",
			`${engines.length} 个：${engines.map((e) => e.id).join(", ")}`,
			missingSkill.length > 0 ? `缺少 SKILL.md：${missingSkill.join(", ")}` : undefined
		);
	}
	const pinned = engines.filter((e) => e.upstream);
	const drift = [];
	for (const engine of pinned) {
		try {
			const manifest = JSON.parse(await readFile(engine.upstream, "utf8"));
			for (const file of manifest.files ?? []) {
				const abs = join(engine.dir, file.path);
				const buf = await readFile(abs).catch(() => undefined);
				if (buf === undefined) drift.push(`${engine.id}/${file.path} 缺失`);
				else if (contentHash(buf) !== file.sha256) drift.push(`${engine.id}/${file.path} 已改动`);
			}
		} catch {
			drift.push(`${engine.id}/UPSTREAM.json 不可读`);
		}
	}
	if (pinned.length > 0) {
		push(
			"engines-drift",
			"引擎与 vendoring 记录一致",
			drift.length === 0 ? "ok" : "warn",
			drift.length === 0 ? `${pinned.length} 个上游引擎逐文件哈希校验通过` : `${drift.length} 处不一致：${drift.slice(0, 3).join("；")}${drift.length > 3 ? " …" : ""}`,
			drift.length === 0 ? undefined : "node build/vendor-engines.mjs 重新同步（自己改过引擎属正常，可忽略）"
		);
	}

	// 3. uv — only the cangjie engine needs it.
	const uvCommand = config.cangjieUv ?? "uv";
	const uv = await run(uvCommand, ["--version"]);
	if (!runner) {
		push("uv", "uv（仓颉引擎需要）", "skip", "本会话没有 subprocess 服务，无法探测", "在 DSH 会话里用 distill_doctor 工具重跑");
	} else if (uv?.code === 0) {
		push("uv", "uv（仓颉引擎需要）", "ok", firstLine(uv.stdout));
	} else {
		// The common real-world case: uv IS installed, but this process' PATH was
		// captured before the installer updated it (the user has not restarted DSH).
		const wellKnown = join(homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
		const discovered = existsSync(wellKnown) ? wellKnown : undefined;
		push(
			"uv",
			"uv（仓颉引擎需要）",
			"warn",
			discovered
				? `${uvCommand} 不在当前 PATH，但已在 ${discovered} 找到（重启 DSH 后生效）`
				: firstLine(uv?.stderr) || `${uvCommand} 不可执行`,
			discovered
				? `重启 DSH 让 PATH 生效；或把 config.cangjieUv 设为 "${discovered}" 立即使用。没有 uv 时 source/comfy/skill/evolve/route/list 仍可用`
				: "Windows: 下载官方 zip 解压到 %USERPROFILE%\\.local\\bin 并加入 PATH（或 winget install astral-sh.uv）；装完重启 DSH 让 PATH 生效。没有 uv 时 source/comfy/skill/evolve/route/list 仍可用"
		);
	}

	// 4. Python + PyYAML, resolved through uv so no system Python is required.
	if (uv?.code === 0) {
		const py = await run(uvCommand, ["run", "--no-project", "--with", "pyyaml", "python", "-c", "import sys, yaml; print(sys.version.split()[0], yaml.__version__)"], 180_000);
		push(
			"python",
			"uv 提供的 Python + PyYAML",
			py?.code === 0 ? "ok" : "fail",
			py?.code === 0 ? firstLine(py.stdout) : firstLine(py.stderr),
			py?.code === 0 ? undefined : "需要能访问 PyPI（首次会下载 Python 与 wheel），检查网络/代理后重跑"
		);
	} else {
		push("python", "uv 提供的 Python + PyYAML", "skip", "uv 不可用，跳过");
	}

	// 5. git — needed by `evolve` (git precondition) and the Git extractor.
	const git = await run("git", ["--version"]);
	if (!runner) push("git", "git（进化与仓库提取）", "skip", "本会话没有 subprocess 服务，无法探测");
	else if (git?.code === 0) push("git", "git（进化与仓库提取）", "ok", firstLine(git.stdout));
	else push("git", "git（进化与仓库提取）", "warn", "git 不可执行", "安装 Git 并确保在 PATH 上；没有 git 时 evolve 会明确拒绝而不是静默降级");

	// 6. The cangjie CLI itself (bundled engine path or an exported copy).
	const cangjieCli = resolveCangjieCli(cwd, config);
	push(
		"cangjie-cli",
		"cangjie.py 可定位",
		cangjieCli ? "ok" : "warn",
		cangjieCli ?? "未找到",
		cangjieCli ? undefined : "确认插件完整安装；或设置 config.cangjieCli / 环境变量 CANGJIE_CLI 指向 scripts/cangjie.py"
	);

	// 7. Skill roots, plus a real write probe into the user root.
	const roots = await inspectRoots(cwd, config);
	const userRoot = userSkillsDir(config);
	let writable = "skip";
	let writableDetail = "已跳过（probe: false）";
	if (probe) {
		const probeFile = join(userRoot, ".distillation-doctor-probe");
		try {
			await mkdir(userRoot, { recursive: true });
			await writeFile(probeFile, "probe", "utf8");
			await rm(probeFile, { force: true });
			writable = "ok";
			writableDetail = userRoot;
		} catch (error) {
			writable = "fail";
			writableDetail = `${userRoot} — ${error?.message ?? error}`;
		}
	}
	push("skill-root-writable", "用户技能根可写", writable, writableDetail, writable === "fail" ? "检查目录权限，或用 config.skillsDir 指向可写目录" : undefined);
	const discovered = roots.reduce((sum, root) => sum + root.skills.length, 0);
	push(
		"skill-roots",
		"技能根可见性",
		discovered > 0 ? "ok" : "warn",
		`${roots.length} 个根，共 ${discovered} 个技能`,
		discovered > 0 ? undefined : "技能根是空的；内置引擎本应至少提供 5 个技能，检查安装是否完整"
	);

	// 8. The router index — the thing that makes "该用哪个 skill" answerable.
	const index = await loadRouteIndex(cwd, config);
	push(
		"route-index",
		"路由索引 skills.index.json",
		index ? "ok" : "fail",
		index ? `${index.file}（${index.index.skills.length} 个技能，来源 ${index.rootSource}）` : "未找到任何 skills.index.json",
		index ? undefined : "内置引擎自带该索引；若缺失说明安装不完整，重新安装插件"
	);

	// 9. The browser page's data path. A page that can only say "HTTP 404" is a
	// support ticket; this check turns it into a named finding with a fix.
	const statusRoute = runtime?.statusRoute;
	if (statusRoute === undefined) {
		push("status-route", "页面数据链路（宿主只读路由）", "skip", "命令行运行，不注册页面路由");
	} else {
		const where = typeof statusRoute.path === "string" && statusRoute.path.length > 0 ? statusRoute.path : "status route";
		push(
			"status-route",
			"页面数据链路（宿主只读路由）",
			statusRoute.registered ? "ok" : "warn",
			statusRoute.registered ? `已注册 ${where}${statusRoute.reason ? `（${statusRoute.reason}）` : ""}` : `未注册 ${where}：${statusRoute.reason ?? "原因未知"}`,
			statusRoute.registered ? undefined : "在插件页把「dsh-distillation」关掉再打开一次（重建 fiber 会重新注册），或重启 DSH；命令行 doctor 不受影响"
		);
	}

	const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
	for (const check of checks) counts[check.status]++;
	const ok = counts.fail === 0;
	const icon = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };
	const summary = lines([
		`蒸馏插件自检：${ok ? "通过" : "有失败项"}（ok ${counts.ok} / warn ${counts.warn} / fail ${counts.fail} / skip ${counts.skip}）`,
		...checks.map((check) => `${icon[check.status]} ${check.label}：${check.detail}${check.fix ? `\n        → ${check.fix}` : ""}`)
	]);
	return {
		schema: "dsh-distillation/doctor/v1",
		checkedAt: new Date().toISOString(),
		ok,
		counts,
		summary,
		checks,
		roots,
		engines: engines.map((engine) => ({ id: engine.id, dir: engine.dir, hasSkill: Boolean(engine.skillFile), pinned: Boolean(engine.upstream) })),
		enginesDir: enginesDir ?? null
	};
}

/** Write the doctor report where a later run (and the page) can read it. */
export async function writeDoctorReport(report) {
	const file = doctorReportPath();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
	return file;
}

/** Read the cached doctor report, if a previous run wrote one. */
export async function readDoctorReport() {
	try {
		return JSON.parse(await readFile(doctorReportPath(), "utf8"));
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ *
 * Skill discovery (Node fs — deliberately not ctx.fs)
 * ------------------------------------------------------------------ */

/**
 * The dsh filesystem skill provider reads local roots through `ctx.fs`, which in the
 * active preset returns nothing for user/project roots (only its Node-fs "bundled" root
 * resolves). This module instead reads the roots with `node:fs` so plugins built on it can
 * expose real skills, which is exactly what `ctx.skills.registerProvider` is for.
 */

/** Parse the SKILL.md frontmatter subset the dsh contract uses. Returns undefined when invalid. */
export function parseSkillFrontmatter(text) {
	// Windows editors (Notepad, PowerShell's own Set-Content) happily write a UTF-8
	// BOM. A BOM must not decide whether a skill is loadable.
	const raw = String(text ?? "").replace(/^\uFEFF/, "");
	const firstEnd = raw.indexOf("\n");
	if (firstEnd < 0) return undefined;
	if (raw.slice(0, firstEnd).replace(/\r$/, "") !== "---") return undefined;
	let cursor = firstEnd + 1;
	let closeStart = -1;
	let bodyStart = raw.length;
	while (cursor <= raw.length) {
		const nextEnd = raw.indexOf("\n", cursor);
		const lineEnd = nextEnd < 0 ? raw.length : nextEnd;
		if (raw.slice(cursor, lineEnd).replace(/\r$/, "") === "---") {
			closeStart = cursor;
			bodyStart = nextEnd < 0 ? raw.length : nextEnd + 1;
			break;
		}
		if (nextEnd < 0) return undefined;
		cursor = nextEnd + 1;
	}
	if (closeStart < 0) return undefined;

	const scalars = {};
	const blockKeys = new Set();
	const blockLines = {};
	for (const rawLine of raw.slice(firstEnd + 1, closeStart).split(/\r?\n/)) {
		if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(rawLine);
		if (!match) {
			if (blockKeys.size > 0) {
				// Continuation line of the open block scalar.
				const key = [...blockKeys][blockKeys.size - 1];
				blockLines[key].push(rawLine.replace(/^\s{2}/, ""));
				continue;
			}
			// An indented line belongs to a nested mapping (e.g. `metadata:`); skip it.
			if (/^\s/.test(rawLine)) continue;
			return undefined;
		}
		const key = match[1];
		let value = match[2];
		if (value === "|" || value === ">" || value === "|-" || value === ">-") {
			blockKeys.add(key);
			blockLines[key] = [];
			scalars[key] = undefined;
			continue;
		}
		blockKeys.clear();
		if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
			value = value
				.slice(1, -1)
				.replace(/\\(["\\/nrt])/g, (_m, c) => ({ '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t" })[c] ?? c);
		} else if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1).replace(/''/g, "'");
		}
		scalars[key] = value;
	}
	for (const key of Object.keys(blockLines)) {
		scalars[key] = blockLines[key].join("\n").replace(/\s+$/, "");
	}

	const name = typeof scalars.name === "string" ? scalars.name.trim() : "";
	const description = typeof scalars.description === "string" ? scalars.description.trim() : "";
	if (name.length === 0 || description.length === 0) return undefined;
	if (!SKILL_NAME.test(name)) return undefined;

	const booleanField = (key, fallback) => {
		if (!Object.hasOwn(scalars, key)) return fallback;
		const value = scalars[key];
		if (value === true || value === "true" || value === "1" || value === "yes" || value === "on") return true;
		if (value === false || value === "false" || value === "0" || value === "no" || value === "off") return false;
		return fallback;
	};
	const whenToUse = typeof scalars["when-to-use"] === "string" && scalars["when-to-use"].length > 0 ? scalars["when-to-use"].trim() : undefined;

	return {
		name,
		description,
		whenToUse,
		invocation: {
			modelInvocable: booleanField("disable-model-invocation", false) !== true,
			userInvocable: booleanField("user-invocable", true) !== false
		},
		body: raw.slice(bodyStart)
	};
}

/**
 * The engines shipped inside this package (`<package>/engines`).
 *
 * This is what makes "install it and it runs" true: nuwa / cangjie / darwin and
 * the router ship with the plugin, so no clone step is needed. Two layouts must
 * both work: core.mjs at the package root (`<pkg>/engines`) and the copy that
 * ships inside `engines/skill-distillation/scripts/` (`<pkg>/engines` is two
 * levels up). A marker file — never copied by `engines export` — is what proves
 * a candidate really is the bundled directory, so an exported skill under
 * `$DSH_HOME/skills` can never be mistaken for it.
 */
export const ENGINES_MARKER = ".dsh-engines.json";

export function bundledEnginesDir() {
	const base = dirname(fileURLToPath(import.meta.url));
	for (const dir of [join(base, "engines"), join(base, "..", "..")]) {
		if (existsSync(join(dir, ENGINES_MARKER))) return resolvePath(dir);
	}
	return undefined;
}

/** The engines this package ships, with the skill id each directory exposes. */
export async function listBundledEngines() {
	const dir = bundledEnginesDir();
	if (!dir) return [];
	const engines = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const engineDir = join(dir, entry.name);
		engines.push({
			id: entry.name,
			dir: engineDir,
			skillFile: existsSync(join(engineDir, "SKILL.md")) ? join(engineDir, "SKILL.md") : undefined,
			upstream: existsSync(join(engineDir, "UPSTREAM.json")) ? join(engineDir, "UPSTREAM.json") : undefined
		});
	}
	return engines.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Copy the bundled engines into a skill root, so DSH's own skill inventory and
 * any other tool can see them too. The bundled root already exposes them to this
 * plugin's provider, so this is opt-in.
 */
export async function exportBundledEngines({ target = "user", cwd, config = {}, only, overwrite = false } = {}) {
	const dir = bundledEnginesDir();
	if (!dir) throw new Error("this package ships no engines/ directory");
	const destRoot = resolveSkillRoot(target, cwd, config);
	await mkdir(destRoot, { recursive: true });
	const shipped = [];
	const skipped = [];
	for (const engine of await listBundledEngines()) {
		if (Array.isArray(only) && only.length > 0 && !only.includes(engine.id)) continue;
		const dest = join(destRoot, engine.id);
		if (existsSync(dest) && overwrite !== true) {
			skipped.push({ id: engine.id, dir: dest, reason: "already exists (pass overwrite to replace)" });
			continue;
		}
		await cp(engine.dir, dest, { recursive: true, force: true });
		shipped.push({ id: engine.id, dir: dest });
	}
	return { root: destRoot, shipped, skipped };
}

/** The default skill roots, in the same rank order the dsh provider documents. */
export function defaultSkillRoots(cwd, config = {}) {
	const roots = [];
	if (cwd) {
		const root = resolvePath(cwd);
		roots.push({ dir: join(root, ".dsh", "skills"), source: "project-dsh", rank: 100 });
		roots.push({ dir: join(root, ".agents", "skills"), source: "project-agents", rank: 200 });
	}
	// Rank 150: a project-level root, so an installed project skill still wins,
	// but the bundled engines win over anything the user happens to have in
	// ~/.dsh/skills — the engines are DSH-adapted, an older clone may not be.
	// `bundledEngines: false` turns the root off for users who keep their own
	// (unadapted) clones and want their index to win.
	const bundled = config.bundledEngines === false ? undefined : bundledEnginesDir();
	if (bundled) roots.push({ dir: bundled, source: "bundled-engines", rank: 150 });
	for (const extra of config.extraSkillDirs ?? []) {
		roots.push({ dir: resolvePath(expandTilde(extra)), source: "custom", rank: 300 });
	}
	roots.push({ dir: join(dshHome(), "skills"), source: "user-dsh", rank: 400 });
	roots.push({ dir: join(dshHome(), "agents", "skills"), source: "user-agents", rank: 500 });
	return roots;
}

/**
 * Read every SKILL.md under the given roots.
 * @returns `{ candidates, complete }` — `complete` is false when a root failed to read.
 */
export async function readSkillCandidates(roots, providerName) {
	const candidates = [];
	let complete = true;
	for (const root of roots) {
		let entries;
		try {
			entries = await readdir(root.dir, { withFileTypes: true });
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") complete = false;
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const isDirLike = entry.isDirectory() || entry.isSymbolicLink();
			const filePath = isDirLike
				? join(root.dir, entry.name, "SKILL.md")
				: entry.isFile() && entry.name.endsWith(".md")
					? join(root.dir, entry.name)
					: undefined;
			if (filePath === undefined) continue;
			let text;
			try {
				text = await readFile(filePath, "utf8");
			} catch {
				continue;
			}
			const parsed = parseSkillFrontmatter(text);
			if (!parsed) continue;
			const directory = isDirLike ? join(root.dir, entry.name) : root.dir;
			// Routing key: the skill-orchestrator convention is the DIRECTORY name when it is a
			// valid skill id (nuwa's frontmatter says `huashu-nuwa` but its directory is
			// `nuwa-skill`), otherwise the frontmatter name.
			const routingKey = isDirLike && SKILL_NAME.test(entry.name) ? entry.name : parsed.name;
			candidates.push({
				name: routingKey,
				frontmatterName: parsed.name,
				description: parsed.description,
				...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
				invocation: parsed.invocation,
				provider: providerName,
				source: root.source,
				rank: root.rank,
				locator: { path: filePath, directory },
				resourceBase: { kind: "directory", path: directory },
				path: filePath
			});
		}
	}
	return { candidates, complete };
}

/* ------------------------------------------------------------------ *
 * Skill evolution (feed a Markdown document into an existing skill)
 * ------------------------------------------------------------------ */

const ENHANCE_START = "<!-- distillation:enhancement start -->";
const ENHANCE_END = "<!-- distillation:enhancement end -->";

/** `YYYYMMDD-HHMM`, matching the darwin backup naming convention. */
export function isoStamp(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}`
	);
}

/** Resolve a skill by id inside the known roots, or accept an explicit directory. */
export function resolveSkillDir(target, cwd, config = {}) {
	if (typeof target !== "string" || target.length === 0) return undefined;
	const looksLikePath = isAbsolute(target) || target.includes("/") || target.includes("\\");
	if (looksLikePath) {
		const dir = resolvePath(expandTilde(target));
		return existsSync(join(dir, "SKILL.md")) ? dir : undefined;
	}
	for (const root of defaultSkillRoots(cwd, config)) {
		const dir = join(root.dir, target);
		if (existsSync(join(dir, "SKILL.md"))) return dir;
	}
	return undefined;
}

/** Render the single marker block that catalogues enhancement material. */
function renderEnhancementBlock(bullets) {
	return [
		ENHANCE_START,
		"## 增强材料（distillation）",
		"",
		"以下材料由 distillation 插件用外部文档增强本技能，来源与日期可追溯：",
		"",
		...bullets,
		"",
		ENHANCE_END
	].join("\n");
}

/**
 * Merge a Markdown document into an existing skill.
 *
 * Deterministic by design: it archives the previous SKILL.md, stores the document under
 * `<skill>/references/`, and upserts one entry in a marker block, so the operation is
 * idempotent and reviewable. The *semantic* rewrite stays with the agent / darwin.
 *
 * @returns the written paths, the upserted bullet, and a preview (also when `dryRun`).
 */
export async function enhanceSkill(options) {
	const { skillDir, referenceContent, sourceLabel, slug, dryRun = false, now = new Date() } = options;
	if (!skillDir) throw new Error("enhanceSkill: skillDir is required");
	const mainFile = join(skillDir, "SKILL.md");
	const original = await readFile(mainFile, "utf8");
	const parsed = parseSkillFrontmatter(original);
	if (!parsed) throw new Error(`not a valid DSH skill (frontmatter missing or invalid): ${mainFile}`);

	// Slug from the document's base name — never from the whole path.
	const slugSource =
		sourceLabel && sourceLabel !== "(inline)" ? basename(String(sourceLabel)).replace(/\.[^.]+$/, "") : "enhancement";
	const safeSlug = SKILL_NAME.test(String(slug ?? "")) ? String(slug) : slugify(slugSource);
	const referenceRel = `references/${safeSlug}.md`;
	const referencePath = join(skillDir, referenceRel);
	const stamp = isoStamp(now);
	// Never overwrite an archived original: a same-minute re-run gets a numeric suffix.
	let backupPath = join(skillDir, `SKILL.md.bak.${stamp}`);
	for (let n = 2; existsSync(backupPath); n += 1) backupPath = join(skillDir, `SKILL.md.bak.${stamp}-${n}`);
	const bullet = `- \`${referenceRel}\` — 来源：\`${sourceLabel ?? "(inline)"}\`（${stamp}）`;

	const start = original.indexOf(ENHANCE_START);
	const end = original.indexOf(ENHANCE_END);
	let bullets;
	let next;
	if (start >= 0) {
		if (end < start) throw new Error(`malformed enhancement block in ${mainFile}`);
		const inner = original.slice(start + ENHANCE_START.length, end);
		bullets = inner
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.startsWith("- ") && !line.startsWith(`- \`${referenceRel}\``));
		bullets.push(bullet);
		next = original.slice(0, start) + renderEnhancementBlock(bullets) + original.slice(end + ENHANCE_END.length);
	} else {
		bullets = [bullet];
		next = original.replace(/\s*$/, "") + "\n\n" + renderEnhancementBlock(bullets) + "\n";
	}

	const result = {
		skillDir,
		skillName: parsed.name,
		mainFile,
		referenceRel,
		referencePath,
		referenceBytes: Buffer.byteLength(String(referenceContent ?? ""), "utf8"),
		backupPath,
		replacedBlock: start >= 0,
		bullet,
		dryRun,
		preview: next
	};
	if (dryRun) return result;

	await writeFile(result.backupPath, original, "utf8");
	await mkdir(join(skillDir, "references"), { recursive: true });
	await writeFile(referencePath, String(referenceContent ?? ""), "utf8");
	await writeFile(mainFile, next, "utf8");
	await recordArtifact({
		skillDir,
		origin: "evolve",
		tool: "distill_evolve",
		source:
			typeof sourceLabel === "string" && sourceLabel.length > 0 && sourceLabel !== "(inline)"
				? { kind: "doc", label: sourceLabel }
				: { kind: "inline" },
		note: `attached ${referenceRel}`
	});
	return result;
}

/* ------------------------------------------------------------------ *
 * Provenance — which skills did this plugin generate or change?
 * ------------------------------------------------------------------ */

export const ARTIFACT_SIDECAR = ".distillation.json";

/** Derived cache; the per-skill sidecar is the source of truth. */
export const artifactIndexPath = () => join(dshHome(), "distillation", "index.json");

export const artifactRecordPath = (skillDir) => join(skillDir, ARTIFACT_SIDECAR);

export async function readArtifactRecord(skillDir) {
	try {
		const parsed = JSON.parse(await readFile(artifactRecordPath(skillDir), "utf8"));
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Record that this plugin produced or modified a skill.
 *
 * A skill written into a DSH root is otherwise indistinguishable from a hand-written
 * one, so "list the skills this plugin generated" has to be anchored on something we
 * write ourselves. The sidecar lives inside the skill directory, which means deleting
 * the directory also deletes the claim.
 */
export async function recordArtifact({ skillDir, origin, tool, source, note, now = new Date() }) {
	const at = now.toISOString();
	const existing = (await readArtifactRecord(skillDir)) ?? {};
	const runs = Array.isArray(existing.runs) ? existing.runs.slice() : [];
	runs.push({ at, op: origin, ...(tool !== undefined ? { tool } : {}), ...(note !== undefined ? { note } : {}) });
	const record = {
		schema: "dsh-distillation/artifact/v1",
		origin: origin ?? existing.origin ?? "unknown",
		...(tool !== undefined ? { tool } : existing.tool !== undefined ? { tool: existing.tool } : {}),
		createdAt: existing.createdAt ?? at,
		updatedAt: at,
		...(source !== undefined ? { source } : existing.source !== undefined ? { source: existing.source } : {}),
		runs: runs.slice(-20)
	};
	await mkdir(skillDir, { recursive: true });
	await writeFile(artifactRecordPath(skillDir), JSON.stringify(record, null, 2) + "\n", "utf8");
	return record;
}

/** Every skill this plugin touched, scanned from the roots and cached to the index. */
export async function listGeneratedSkills(roots, now = new Date()) {
	const artifacts = [];
	for (const root of roots) {
		let entries;
		try {
			entries = await readdir(root.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const skillDir = join(root.dir, entry.name);
			const record = await readArtifactRecord(skillDir);
			if (!record) continue;
			let description = "";
			try {
				const parsed = parseSkillFrontmatter(await readFile(join(skillDir, "SKILL.md"), "utf8"));
				description = parsed?.description ?? "";
			} catch {
				/* keep the entry: the sidecar is still evidence the plugin wrote here */
			}
			artifacts.push({
				name: entry.name,
				dir: skillDir,
				rootSource: root.source,
				rank: root.rank,
				origin: record.origin,
				...(record.tool !== undefined ? { tool: record.tool } : {}),
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				...(record.source !== undefined ? { source: record.source } : {}),
				runs: Array.isArray(record.runs) ? record.runs : [],
				description
			});
		}
	}
	artifacts.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
	const index = { schema: "dsh-distillation/index/v1", updatedAt: now.toISOString(), count: artifacts.length, artifacts };
	try {
		const path = artifactIndexPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(index, null, 2) + "\n", "utf8");
	} catch {
		/* the index is only a cache; a failed write must not break the listing */
	}
	return artifacts;
}

/* ------------------------------------------------------------------ *
 * Routing — turn a request into a plan, without executing it
 * ------------------------------------------------------------------ */

/** The orchestrator index is the single source of truth for routing. */
export const ROUTE_INDEX_REL = join("skill-orchestrator", "skills.index.json");

/** Read the index from the first skill root that has one (project wins over user). */
export async function loadRouteIndex(cwd, config = {}) {
	for (const root of defaultSkillRoots(cwd, config)) {
		const file = join(root.dir, ROUTE_INDEX_REL);
		try {
			const parsed = JSON.parse(await readFile(file, "utf8"));
			if (Array.isArray(parsed?.skills)) return { file, index: parsed, rootSource: root.source };
		} catch {
			/* try the next root */
		}
	}
	return undefined;
}

/** Whitespace-insensitive comparison form (users type "优化一下这个 skill"). */
const normalizeForMatch = (value) => String(value ?? "").toLowerCase().replace(/[\s\u3000]+/g, "");

/**
 * Split a trigger into matchable tokens.
 *
 * Whole-trigger substring matching alone is too strict for natural language: darwin's
 * trigger is `优化skill`, so "帮我优化一下这个 skill" would miss it. CJK runs of 2+ chars
 * and ASCII words of 4+ chars become tokens, so the same request still lands on darwin.
 */
export function triggerTokens(trigger) {
	const parts = String(trigger ?? "").match(/[\u4e00-\u9fff]+|[A-Za-z0-9_.-]+/g) ?? [];
	const tokens = [];
	for (const part of parts) {
		if (/^[\u4e00-\u9fff]+$/.test(part)) {
			if (part.length >= 2) tokens.push(part);
		} else if (part.length >= 2) {
			// 2-char ASCII matters: "网页转md" must still route when the user writes "整理成 md".
			tokens.push(part.toLowerCase());
		}
	}
	return tokens;
}

/**
 * Generic tokens that leak into triggers and would match almost anything:
 * English function words ("book **to** skill") and Chinese filler ("**做个**XX视角").
 */
const STOPWORDS = new Set([
	"to", "of", "the", "and", "in", "on", "for", "with", "or", "an", "is", "it", "my", "xx",
	"做个", "一个", "这个", "那个", "帮我", "怎么", "什么", "一下", "可以", "如何", "怎样"
]);

/**
 * Document frequency of each token across the catalog: a token shared by many skills
 * ("skill" appears in nuwa, cangjie and darwin) carries almost no routing information,
 * so it must not be allowed to match on its own.
 */
export function buildTokenIndex(skills) {
	const df = new Map();
	for (const skill of skills) {
		if (!skill) continue;
		const seen = new Set();
		for (const trigger of Array.isArray(skill.triggers) ? skill.triggers : []) {
			for (const token of triggerTokens(trigger)) seen.add(token);
		}
		for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
	}
	return df;
}

/**
 * Deterministic match: a whole trigger is worth 2 points, each distinct informative token
 * 1 point. Tokens shared by `maxTokenDf` or more skills are ignored as generic.
 * Ties break on `priority` (lower wins), then id.
 */
export function matchSkills(request, skills, options = {}) {
	const tokenDf = options.tokenDf ?? buildTokenIndex(skills);
	const maxTokenDf = options.maxTokenDf ?? 3;
	const text = normalizeForMatch(request);
	const matches = [];
	for (const skill of skills) {
		if (!skill || typeof skill.id !== "string") continue;
		const triggers = Array.isArray(skill.triggers) ? skill.triggers : [];
		const fullHits = [];
		const tokenHits = new Set();
		for (const trigger of triggers) {
			if (typeof trigger !== "string" || trigger.trim().length === 0) continue;
			if (text.includes(normalizeForMatch(trigger))) {
				fullHits.push(trigger);
				continue;
			}
			for (const token of triggerTokens(trigger)) {
				if (STOPWORDS.has(token)) continue;
				if ((tokenDf.get(token) ?? 1) >= maxTokenDf) continue;
				if (text.includes(token)) tokenHits.add(token);
			}
		}
		if (fullHits.length === 0 && tokenHits.size === 0) continue;
		matches.push({
			id: skill.id,
			kind: skill.kind ?? "unknown",
			layer: skill.layer ?? "unknown",
			score: fullHits.length * 2 + tokenHits.size,
			priority: Number.isFinite(Number(skill.priority)) ? Number(skill.priority) : 999,
			hits: [...fullHits, ...tokenHits],
			fullHits,
			tokenHits: [...tokenHits],
			skill
		});
	}
	matches.sort((a, b) => b.score - a.score || a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
	return matches;
}

/** How a matched skill is meant to be executed, from its `callable` field. */
const EXECUTION_BY_CALLABLE = { cli: "cli", importable: "plugin", prompt_only: "agent" };

/** Produce a step from a match. The router never runs the step. */
function planStep(match, index) {
	const skill = match.skill;
	const runtime = skill.requires?.runtime;
	return {
		step: index + 1,
		skill: match.id,
		displayName: skill.name ?? match.id,
		kind: match.kind,
		why: `命中触发词：${match.hits.slice(0, 4).join("、")}`,
		inputs: typeof skill.requires?.input === "string" ? [skill.requires.input] : [],
		gates: Array.isArray(skill.requires?.hard_gate) ? skill.requires.hard_gate : [],
		requires: {
			...(Array.isArray(runtime) ? { runtime } : {}),
			...(Array.isArray(skill.requires?.host) ? { host: skill.requires.host } : {})
		},
		produces: skill.produces ?? {},
		execution: EXECUTION_BY_CALLABLE[skill.callable] ?? "agent",
		...(Array.isArray(skill.entrypoints) && skill.entrypoints.length > 0 ? { entrypoints: skill.entrypoints } : {}),
		...(Array.isArray(skill.gaps) && skill.gaps.length > 0 ? { knownGaps: skill.gaps } : {})
	};
}

/**
 * Routing phases. `person` (造人) and `content` (造书) are ALTERNATIVES — you either build
 * a person-perspective skill or a content-derived one, not both in sequence. Only
 * `evolution` chains after a produce step.
 */
const PHASE_OF_KIND = { person: "produce", content: "produce", evolution: "evolve" };
const PHASE_ORDER = { produce: 1, evolve: 2, other: 5 };
const phaseLabel = (phase) => (phase === "produce" ? "「产出 Skill」" : phase === "evolve" ? "「进化 Skill」" : `「${phase}」`);

/**
 * Turn a request into a structured plan.
 *
 * Deliberately does NOT execute anything: it matches the orchestrator index's triggers
 * and returns the plan plus any question the agent should ask the user. Executing the
 * plan stays with the agent / the CLI in each step (the "hybrid" decision).
 */
export async function routeRequest({ request, cwd, config = {} } = {}) {
	const loaded = await loadRouteIndex(cwd, config);
	if (!loaded) {
		return {
			ok: false,
			reason: "no-index",
			confidence: 0,
			needsClarification: true,
			clarify: [{ question: "找不到 skill-orchestrator/skills.index.json（主 Skill 索引），无法路由。要先安装主 Skill 吗？", options: [] }],
			plan: [],
			matched: [],
			unmatched: []
		};
	}

	const { file, index, rootSource } = loaded;
	const skills = index.skills.filter((s) => s && s.installed !== false);
	const matches = matchSkills(request, skills, { tokenDf: buildTokenIndex(skills) });

	const byPhase = new Map();
	for (const match of matches) {
		const phase = PHASE_OF_KIND[match.kind] ?? "other";
		const list = byPhase.get(phase) ?? [];
		list.push(match);
		byPhase.set(phase, list);
	}

	const clarify = [];
	const selected = [];
	for (const [phase, list] of byPhase) {
		list.sort((a, b) => b.score - a.score || a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
		const best = list[0].score;
		const tied = list.filter((m) => m.score === best);
		if (tied.length > 1) {
			clarify.push({
				question: `「${request}」在${phaseLabel(phase)}这一类里同时命中 ${tied.length} 个技能，应该用哪个？`,
				options: tied.map((m) => m.id)
			});
			continue;
		}
		selected.push(list[0]);
	}
	if (matches.length === 0) {
		clarify.push({
			question: `没有任何技能命中「${request}」。你是想生成一个新 Skill、进化一个已有 Skill，还是只把材料整理成 Markdown？`,
			options: ["生成 Skill（cangjie / nuwa）", "进化已有 Skill（darwin）", "只整理材料（skill-distillation）"]
		});
	}

	selected.sort(
		(a, b) =>
			(PHASE_ORDER[PHASE_OF_KIND[a.kind] ?? "other"] ?? 5) - (PHASE_ORDER[PHASE_OF_KIND[b.kind] ?? "other"] ?? 5) ||
			a.priority - b.priority
	);
	const plan = selected.map((match, i) => planStep(match, i));
	const confidence = matches.length === 0 ? 0.15 : clarify.length > 0 ? 0.5 : matches[0].score >= 2 ? 0.9 : 0.7;

	return {
		ok: true,
		indexFile: file,
		indexRoot: rootSource,
		indexUpdated: index.updated,
		request: String(request ?? ""),
		confidence,
		needsClarification: clarify.length > 0,
		clarify,
		plan,
		matched: matches.map((m) => ({ id: m.id, kind: m.kind, score: m.score, hits: m.hits })),
		unmatched: skills.map((s) => s.id).filter((id) => !matches.some((m) => m.id === id)),
		note: "这只是路由计划，本工具不执行。按每步的 execution 执行：cli=调用该 Skill 的 CLI 入口，plugin=用本插件工具，agent=按该 Skill 的 SKILL.md 执行（子 Agent 可用）。"
	};
}

/* ------------------------------------------------------------------ *
 * Evolution — deterministic pre-flight, evaluation ticket, finalize
 * ------------------------------------------------------------------ */

/** First non-empty line of a command's output (git answers on either stream). */
const firstLine = (text) => String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";

/** `run-YYYYMMDD-HHMM` — one evaluation run, one ticket directory. */
export const evolutionRunId = (now = new Date()) => `run-${isoStamp(now)}`;

export const testPromptsPath = (skillDir) => join(skillDir, "test-prompts.json");

export const evolutionDir = (skillDir, runId) => join(skillDir, "evolution", runId);

/** Columns of the evaluation log the agent fills in (darwin's paired ratchet). */
export const RESULTS_HEADER = "run_id\tprompt_id\tjudge\tverdict\tcandidate_rev\tbaseline_rev\tdate\tdecision\tnotes";

/**
 * Derive a `test-prompts.json` skeleton from the skill's own frontmatter.
 *
 * darwin's dim8 ("实测表现") is worthless without test prompts, and it refuses to
 * score without them — so the plugin derives a starting point from the trigger
 * scenarios the skill already declares. The prompts are deliberately marked as
 * placeholders: a machine cannot invent a user's real phrasing, and a fabricated
 * prompt would make the ratchet measure nothing.
 */
export function buildTestPromptsSkeleton({ name, description, whenToUse, now = new Date() }) {
	const source = [whenToUse, description].filter((v) => typeof v === "string" && v.length > 0).join("\n");
	const clauses = source
		.split(/[。;；\n]+|(?<=[a-z])\.\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 6)
		.slice(0, 3);
	const prompts = clauses.map((clause, index) => ({
		id: `${name}-${index + 1}`,
		scenario: clause.slice(0, 140),
		prompt: `（待改写：把下面的场景写成真实用户会说的话）${clause.slice(0, 140)}`,
		expected: "（待补充：这条 prompt 下可接受的产出要点）"
	}));
	while (prompts.length < 3) {
		prompts.push({
			id: `${name}-${prompts.length + 1}`,
			scenario: "（待补充：一个必须触发本技能的场景）",
			prompt: "（待补充：真实用户 prompt）",
			expected: "（待补充：可接受产出要点）"
		});
	}
	return {
		schema: "dsh-distillation/test-prompts/v1",
		skill: name,
		generatedAt: now.toISOString(),
		note: "骨架由 distill_evolve 生成：请把每条 prompt/expected 改成可判定的真实用例；darwin 的 dim8 依赖它，未改写的占位内容会让评分不可信。",
		prompts
	};
}

function renderEvolutionPlan({ skillName, runId, branch, repoRoot, judgeCount, baseRev, prompts, referenceRel, backupPath }) {
	return [
		`# 进化评估工单 · ${skillName} · ${runId}`,
		"",
		`- 分支：\`${branch}\``,
		`- 仓库：\`${repoRoot}\``,
		`- baseline 提交：\`${baseRev}\``,
		`- 材料：\`${referenceRel}\`（原件已备份到 \`${backupPath}\`）`,
		`- judge 数量：**${judgeCount}**（奇数，paired 多数决）`,
		"",
		"## 你要做什么（Agent 执行，插件不代做）",
		"",
		"1. 读 `SKILL.md` 与 `references/` 下的新material，按 darwin 的 9 维评分找出**最短板那一个维度**；",
		"2. 只改这一个维度，写出 candidate 版 `SKILL.md`；",
		`3. 起 **${judgeCount}** 个独立 judge，对同一条 prompt **成对**比较 candidate 与 baseline（\`git show ${baseRev}:SKILL.md\`），各投 better / worse / tie；`,
		"4. 按多数决决定 keep 或 revert —— 平票视为 worse（不保留）；",
		"5. 把每一票写进 `results.tsv`（制表符分隔，表头已给），然后跑 `distill_evolve --finalize --decision keep|revert`。",
		"",
		"## 硬规则",
		"",
		"- 回滚只用 `git revert`，**禁止** `git reset --hard`（会抹掉别人未提交的工作）；",
		"- 不使用绝对分做取舍（darwin 自述绝对分噪声 ±8），只认成对多数决；",
		"- 没有 `test-prompts.json` 就不要评分 —— 本工单已生成骨架，但**必须先改写它**。",
		"",
		"## 待评 prompt（来自 test-prompts.json）",
		"",
		...prompts.map((p) => `- \`${p.id}\`：${p.scenario || p.prompt}`),
		"",
		"## 日志",
		"",
		"`results.tsv` 列：" + RESULTS_HEADER.split("\t").map((c) => `\`${c}\``).join(" / "),
		""
	].join("\n");
}

/**
 * Evolve a skill: deterministic pre-flight + material merge + evaluation ticket.
 *
 * The split is the whole design: everything that can be checked, reverted or
 * archived is code; everything that needs judgement (which dimension is weakest,
 * whether the rewrite is better) stays with the agent running darwin. A failure
 * before the merge leaves the skill untouched — no branch, no skeleton, no ticket.
 */
export async function evolveSkill(options) {
	const {
		skillDir,
		referenceContent,
		sourceLabel,
		slug,
		dryRun = false,
		runner,
		gitInit = false,
		judges = 3,
		now = new Date()
	} = options;
	if (!skillDir) throw new Error("evolveSkill: skillDir is required");

	// Pre-flight 1: a skill we cannot even parse must never be touched.
	const mainFile = join(skillDir, "SKILL.md");
	const original = await readFile(mainFile, "utf8");
	const parsed = parseSkillFrontmatter(original);
	if (!parsed) throw new Error(`not a valid DSH skill (frontmatter missing or invalid): ${mainFile}`);

	if (dryRun) {
		const preview = await enhanceSkill({ skillDir, referenceContent, sourceLabel, slug, dryRun: true, now });
		return { dryRun: true, skillName: parsed.name, branch: undefined, testPrompts: undefined, ticket: undefined, ...preview };
	}

	if (typeof runner !== "function") {
		throw new Error("evolveSkill: a runner is required for the git pre-flight (the CLI has one; in a profile use the distill_evolve tool)");
	}
	const git = (args, cwd) => runner({ command: "git", args, cwd, timeoutMs: 60_000 });

	// Pre-flight 2: inside a git repository, or nothing happens at all.
	let inside = await git(["rev-parse", "--show-toplevel"], skillDir);
	if (inside?.code !== 0 && gitInit === true) {
		const init = await git(["init"], skillDir);
		if (init?.code !== 0) throw new Error(`git init failed in ${skillDir}: ${firstLine(init?.stderr)}`);
		inside = await git(["rev-parse", "--show-toplevel"], skillDir);
	}
	if (inside?.code !== 0) {
		throw new Error(
			`not inside a git repository: ${skillDir} — the evaluation round needs git to revert a bad rewrite; ` +
				"put the skill in a repository, or pass gitInit to create one here"
		);
	}
	const repoRoot = firstLine(inside.stdout) || skillDir;

	// Pre-flight 3: a test-prompt skeleton, derived from the skill's own triggers.
	let testPrompts;
	if (!existsSync(testPromptsPath(skillDir))) {
		testPrompts = buildTestPromptsSkeleton({ name: parsed.name, description: parsed.description, whenToUse: parsed.whenToUse, now });
		await writeFile(testPromptsPath(skillDir), JSON.stringify(testPrompts, null, 2) + "\n", "utf8");
	}

	// Pre-flight 4: branch + baseline commit, so "revert" is one command away.
	const stamp = isoStamp(now);
	const branch = `auto-optimize/${stamp}`;
	const baseRevResult = await git(["rev-parse", "--short", "HEAD"], repoRoot);
	const baseRev = firstLine(baseRevResult.stdout) || "HEAD";
	let branchResult = await git(["checkout", "-b", branch], repoRoot);
	if (branchResult?.code !== 0) {
		// Same minute (or a previous run): reuse the branch instead of failing.
		branchResult = await git(["checkout", branch], repoRoot);
		if (branchResult?.code !== 0) throw new Error(`git checkout ${branch} failed: ${firstLine(branchResult?.stderr)}`);
	}
	await git(["add", "-A"], repoRoot);
	// "nothing to commit" (exit 1) is a clean tree, not a failure.
	await git(["commit", "-m", `chore(distillation): baseline before auto-optimize ${stamp}`, "--no-verify"], repoRoot);

	// Material intake (the pre-existing deterministic merge).
	const applied = await enhanceSkill({ skillDir, referenceContent, sourceLabel, slug, now });

	// The ticket: everything the agent needs, nothing it has to invent.
	const judgeCount = Number.isFinite(Number(judges)) && Number(judges) >= 1
		? (Number(judges) % 2 === 1 ? Number(judges) : Number(judges) + 1)
		: 3;
	const runId = evolutionRunId(now);
	const runDir = evolutionDir(skillDir, runId);
	await mkdir(runDir, { recursive: true });
	const prompts = (await (async () => {
		try {
			return JSON.parse(await readFile(testPromptsPath(skillDir), "utf8"))?.prompts ?? [];
		} catch {
			return [];
		}
	})()).map((p) => ({ id: p.id, scenario: p.scenario ?? "", prompt: p.prompt ?? "" }));
	const plan = renderEvolutionPlan({
		skillName: parsed.name,
		runId,
		branch,
		repoRoot,
		judgeCount,
		baseRev,
		prompts,
		referenceRel: applied.referenceRel,
		backupPath: applied.backupPath
	});
	const planPath = join(runDir, "plan.md");
	const resultsPath = join(runDir, "results.tsv");
	await writeFile(planPath, plan, "utf8");
	await writeFile(resultsPath, RESULTS_HEADER + "\n", "utf8");
	await recordArtifact({
		skillDir,
		origin: "evolve",
		tool: "distill_evolve",
		source: { kind: "doc", label: sourceLabel ?? "(inline)" },
		note: `evolution ${runId} ticket on ${branch}; material ${applied.referenceRel}`,
		now
	});

	return {
		dryRun: false,
		skillName: parsed.name,
		skillDir,
		repoRoot,
		branch,
		baseRev,
		judgeCount,
		runId,
		runDir,
		planPath,
		resultsPath,
		testPrompts: testPrompts ? testPromptsPath(skillDir) : undefined,
		backupPath: applied.backupPath,
		referenceRel: applied.referenceRel,
		referenceBytes: applied.referenceBytes,
		replacedBlock: applied.replacedBlock
	};
}

/**
 * Archive one evaluation round.
 *
 * `decision` is the agent's call, not ours. Reverting is *reported*, never
 * executed: `git reset --hard` is banned by darwin's own rules and a plugin that
 * silently rewrites history is worse than one that prints the command.
 */
export async function finalizeEvolution({ skillDir, runId, decision, note, now = new Date() } = {}) {
	if (!skillDir) throw new Error("finalizeEvolution: skillDir is required");
	if (decision !== "keep" && decision !== "revert") throw new Error('finalizeEvolution: decision must be "keep" or "revert"');
	const dir = evolutionDir(skillDir, runId ?? "");
	if (!runId || !existsSync(dir)) throw new Error(`finalizeEvolution: no such evaluation run: ${dir}`);
	const resultsPath = join(dir, "results.tsv");
	if (!existsSync(resultsPath)) throw new Error(`finalizeEvolution: missing ${resultsPath}`);
	const rows = (await readFile(resultsPath, "utf8"))
		.split(/\r?\n/)
		.slice(1)
		.filter((line) => line.trim().length > 0);
	const resultPath = join(dir, "result.json");
	const record = {
		schema: "dsh-distillation/evolution-result/v1",
		runId,
		decision,
		note: note ?? "",
		finalizedAt: now.toISOString(),
		judgedRows: rows.length,
		resultsFile: resultsPath
	};
	await writeFile(resultPath, JSON.stringify(record, null, 2) + "\n", "utf8");
	await recordArtifact({
		skillDir,
		origin: "evolve",
		tool: "distill_evolve",
		note: `finalized ${runId}: ${decision}${rows.length > 0 ? ` (${rows.length} judged rows)` : " (no judged rows recorded)"}`,
		now
	});
	return {
		...record,
		resultPath,
		gitCommand: decision === "revert" ? "git revert --no-edit HEAD" : undefined
	};
}

/* ------------------------------------------------------------------ *
 * Generation — run the cangjie compiler and install its output
 * ------------------------------------------------------------------ */

/**
 * Locate `cangjie.py` without hardcoding a machine-specific path.
 *
 * The bundled engine has no install command, so discovery walks the same skill
 * roots the catalog uses: `<cwd>/.dsh/skills/...`, this package's own
 * `engines/cangjie-skill/...`, then `$DSH_HOME/skills/cangjie-skill/...` (the
 * last one also covers a user who ran `engines export`).
 */
export function resolveCangjieCli(cwd, config = {}) {
	const candidates = [];
	if (typeof config.cangjieCli === "string" && config.cangjieCli.length > 0) {
		candidates.push(resolvePath(expandTilde(config.cangjieCli)));
	}
	if (typeof process.env.CANGJIE_CLI === "string" && process.env.CANGJIE_CLI.length > 0) {
		candidates.push(resolvePath(expandTilde(process.env.CANGJIE_CLI)));
	}
	for (const root of defaultSkillRoots(cwd, config)) {
		candidates.push(join(root.dir, "cangjie-skill", "scripts", "cangjie.py"));
	}
	if (cwd) {
		const base = resolvePath(cwd);
		candidates.push(join(base, "cangjie-skill", "scripts", "cangjie.py"));
		candidates.push(join(base, "..", "cangjie-skill", "scripts", "cangjie.py"));
	}
	for (const candidate of candidates) if (existsSync(candidate)) return resolvePath(candidate);
	return undefined;
}

/**
 * `uv run --with pyyaml python <cli> compile ...`.
 *
 * `--with pyyaml` is NOT optional: plain `uv run python` only finds PyYAML inside a
 * project that already has it, and fails with ModuleNotFoundError from any other cwd.
 */
export function buildCangjieCompileArgv({ cli, bundleDir, outDir, variant = "single", purpose = "learning" }) {
	return [
		"run", "--with", "pyyaml", "python", cli,
		"compile",
		"--bundle", bundleDir,
		"--out", outDir,
		"--output", variant,
		"--purpose", purpose,
		"--yes"
	];
}

/**
 * Every skill a compile output contains.
 *
 * `single` publishes one skill AT the output root; `pack` publishes a router plus promoted
 * skills as subdirectories, so both shapes are discovered. Names are validated against the
 * DSH skill-id contract because an invalid name would be rejected by the provider later.
 */
export async function findCompiledSkills(outDir) {
	const results = [];
	const consider = async (dir) => {
		const main = join(dir, "SKILL.md");
		if (!existsSync(main)) return false;
		let parsed;
		let text = "";
		try {
			text = await readFile(main, "utf8");
			parsed = parseSkillFrontmatter(text);
		} catch {
			parsed = undefined;
		}
		if (!parsed) {
			// Say WHICH field broke. "frontmatter invalid" sends the user hunting;
			// the name is the one field a compile output gets wrong most often, and
			// it is cheap to read it out of the raw block.
			const raw = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
			const rawName = raw === undefined ? undefined : /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim().replace(/^["']|["']$/g, "");
			const nameOk = rawName !== undefined && SKILL_NAME.test(rawName);
			const reason = nameOk
				? "SKILL.md frontmatter invalid (a required field such as description is missing or empty)"
				: rawName === undefined
					? "SKILL.md frontmatter missing or invalid"
					: `name "${rawName}" does not match ^[a-z0-9]+(?:-[a-z0-9]+)*$`;
			results.push({ dir, name: basename(dir), valid: false, reason });
			return true;
		}
		const valid = SKILL_NAME.test(parsed.name);
		results.push({
			dir,
			name: parsed.name,
			description: parsed.description,
			valid,
			...(valid ? {} : { reason: `name "${parsed.name}" does not match ^[a-z0-9]+(?:-[a-z0-9]+)*$` })
		});
		return true;
	};
	if (await consider(outDir)) return results;
	let entries;
	try {
		entries = await readdir(outDir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		await consider(join(outDir, entry.name));
	}
	return results;
}

/** Copy compiled skills into a DSH skill root and record their provenance. */
export async function installCompiledSkills(options) {
	const { outDir, target = "user", cwd, config = {}, overwrite = false, sourceLabel, now = new Date() } = options;
	const root = resolveSkillRoot(target, cwd, config);
	const candidates = await findCompiledSkills(outDir);
	const valid = candidates.filter((candidate) => candidate.valid);
	const rejected = candidates.filter((candidate) => !candidate.valid);
	if (valid.length === 0) {
		const detail = rejected.length > 0 ? ` (${rejected.map((r) => `${r.name}: ${r.reason}`).join("; ")})` : "";
		throw new Error(`no installable skill found in ${outDir}${detail}`);
	}
	const conflicts = valid.filter((candidate) => existsSync(join(root, candidate.name)));
	if (conflicts.length > 0 && !overwrite) {
		throw new Error(
			`skill already exists: ${conflicts.map((c) => join(root, c.name)).join(", ")} — pass overwrite to replace it`
		);
	}
	const installed = [];
	for (const candidate of valid) {
		const dest = join(root, candidate.name);
		await rm(dest, { recursive: true, force: true });
		await cp(candidate.dir, dest, { recursive: true });
		await recordArtifact({
			skillDir: dest,
			origin: "cangjie-compile",
			tool: "distill_cangjie",
			source: { kind: "bundle", label: sourceLabel ?? outDir },
			note: `compiled (${options.variant ?? "single"}) and installed into ${root}`,
			now
		});
		installed.push({ name: candidate.name, dir: dest, description: candidate.description });
	}
	return { root, installed, rejected };
}

/**
 * Build the argv and hand it to a runner.
 *
 * The runner is injected so the host half can use `ctx.subprocess` (management, teardown,
 * execution-world resolution) while the standalone CLI uses `node:child_process`, without
 * duplicating any of the logic above.
 */
export async function runCangjieCompile(options) {
	const { runner, cli, bundleDir, outDir, variant = "single", purpose = "learning", cwd, timeoutMs, command = "uv" } = options;
	if (typeof runner !== "function") throw new Error("runCangjieCompile: a runner is required");
	if (typeof cli !== "string" || cli.length === 0) throw new Error("runCangjieCompile: a resolved cangjie CLI path is required");
	const args = buildCangjieCompileArgv({ cli, bundleDir, outDir, variant, purpose });
	const started = Date.now();
	const result = await runner({ command, args, cwd, timeoutMs });
	return { cli, command, args, elapsedMs: Date.now() - started, ...result };
}

/* ------------------------------------------------------------------ *
 * Tool registration
 * ------------------------------------------------------------------ */

