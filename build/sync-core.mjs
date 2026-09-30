/**
 * Keep every shipped copy of core.mjs byte-identical to the package root.
 *
 * The host plugin imports `./core.mjs` from the package root, while the bundled
 * `skill-distillation` CLI imports its own `./core.mjs` from inside engines/, so
 * the file can be updated from the shell without reinstalling the plugin. Two
 * copies that drift apart would make the tool and the CLI disagree about the
 * same skill.
 *
 *   node build/sync-core.mjs           # copy root core.mjs over every copy
 *   node build/sync-core.mjs --check   # fail if any copy differs
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const canonical = join(repoRoot, "core.mjs");

/** Every place a copy of core.mjs must exist. */
const COPIES = [join(repoRoot, "engines", "skill-distillation", "scripts", "core.mjs")];

const CHECK_ONLY = process.argv.includes("--check");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

if (!existsSync(canonical)) {
	console.error(`missing canonical core.mjs: ${canonical}`);
	process.exit(1);
}
const source = await readFile(canonical);
const sourceHash = sha(source);

let drifted = 0;
for (const target of COPIES) {
	const rel = relative(repoRoot, target).split("\\").join("/");
	if (CHECK_ONLY) {
		const same = existsSync(target) && sha(await readFile(target)) === sourceHash;
		if (!same) drifted++;
		console.log(`${same ? "ok   " : "DRIFT"}  ${rel}`);
		continue;
	}
	await copyFile(canonical, target);
	console.log(`copied  ${rel}`);
}

if (CHECK_ONLY) {
	console.log(`core.mjs sha256=${sourceHash.slice(0, 16)}  copies=${COPIES.length}  drift=${drifted}`);
	process.exit(drifted === 0 ? 0 : 1);
}
console.log(`core.mjs sha256=${sourceHash.slice(0, 16)} -> ${COPIES.length} copy(ies)`);
