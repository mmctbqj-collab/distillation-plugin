/**
 * Minimal Electron ASAR reader (no dependencies).
 *
 *   node asar.mjs list  <asarPath> [substringFilter]
 *   node asar.mjs cat   <asarPath> <innerPath> [maxBytes]
 *   node asar.mjs extract <asarPath> <innerPrefix> <outDir>
 *
 * Why it exists: the shipped DSH packages (`@deepseek-ai/*`) live inside the
 * installation's app.asar, and the authoritative plugin-development rules are
 * shipped there as a preset skill. Reading them requires an ASAR reader, and a
 * plugin that refuses third-party dependencies cannot install one — so this is
 * it. Development tool only; it is not part of the published package.
 *
 * ASAR layout: 8-byte prefix, then a pickled header (4-byte payload size, 4-byte
 * string length, JSON), then the file data. File entries carry an `offset`
 * relative to the start of the data section.
 */
import { openSync, readSync, mkdirSync, writeFileSync } from "node:fs";
import { closeSync } from "node:fs";
import { join, dirname } from "node:path";

function readHeader(asarPath) {
  const fd = openSync(asarPath, "r");
  const sizeBuf = Buffer.alloc(8);
  readSync(fd, sizeBuf, 0, 8, 0);
  const headerPickleSize = sizeBuf.readUInt32LE(4);
  const headerBuf = Buffer.alloc(headerPickleSize);
  readSync(fd, headerBuf, 0, headerPickleSize, 8);
  const jsonLen = headerBuf.readUInt32LE(4);
  const json = headerBuf.subarray(8, 8 + jsonLen).toString("utf8");
  const header = JSON.parse(json);
  const dataStart = 8 + headerPickleSize;
  return { fd, header, dataStart };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? prefix + "/" + name : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: Number(entry.size ?? 0), offset: Number(entry.offset ?? 0) });
  }
}

function cat(asarPath, innerPath) {
  const { fd, header, dataStart } = readHeader(asarPath);
  try {
    const parts = innerPath.split("/").filter((s) => s.length > 0 && s !== ".");
    let node = header;
    for (const part of parts) {
      node = node.files?.[part];
      if (!node) throw new Error(`not found in asar: ${innerPath}`);
    }
    if (node.files) throw new Error(`is a directory: ${innerPath}`);
    const size = Number(node.size ?? 0);
    const buf = Buffer.alloc(size);
    if (size > 0) readSync(fd, buf, 0, size, dataStart + Number(node.offset ?? 0));
    return buf;
  } finally {
    closeSync(fd);
  }
}

const [cmd, asarPath, ...rest] = process.argv.slice(2);
if (!cmd || !asarPath) {
  console.error("usage: node asar.mjs <list|cat|extract> <asarPath> [...]");
  process.exit(1);
}

if (cmd === "list") {
  const { fd, header } = readHeader(asarPath);
  closeSync(fd);
  const all = [];
  walk(header, "", all);
  const filter = rest[0];
  const shown = filter ? all.filter((f) => f.path.includes(filter)) : all;
  for (const f of shown.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`${String(f.size).padStart(10)}  ${f.path}`);
  }
  console.error(`# ${shown.length} of ${all.length} files`);
} else if (cmd === "cat") {
  const [innerPath, maxBytes] = rest;
  const buf = cat(asarPath, innerPath);
  const cap = maxBytes ? Number(maxBytes) : buf.length;
  process.stdout.write(buf.subarray(0, cap).toString("utf8"));
} else if (cmd === "extract") {
  const [prefix, outDir] = rest;
  const { fd, header, dataStart } = readHeader(asarPath);
  const all = [];
  walk(header, "", all);
  const chosen = all.filter((f) => f.path.startsWith(prefix));
  let n = 0;
  for (const f of chosen) {
    const rel = f.path.slice(prefix.endsWith("/") ? prefix.length : prefix.length + 1);
    const target = join(outDir, rel.split("/").join("/"));
    mkdirSync(dirname(target), { recursive: true });
    const buf = Buffer.alloc(f.size);
    if (f.size > 0) readSync(fd, buf, 0, f.size, dataStart + f.offset);
    writeFileSync(target, buf);
    n++;
  }
  closeSync(fd);
  console.error(`# extracted ${n} files to ${outDir}`);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
