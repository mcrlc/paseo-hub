// Usage: node docs/qa/ac-s5g/check-links.mjs [docs-root]
// Resolves every relative markdown link and #anchor in SECURITY.md and docs/sprite-targets-guide.md
// against files in docs-root (default: this checkout), using GitHub's heading slug rules.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const here = resolve(import.meta.dirname, "../../..");
const root = resolve(process.argv[2] ?? here);
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
const anchors = (file) => {
  const text = readFileSync(file, "utf8").replace(/^```[\s\S]*?^```$/gm, "");
  return [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]));
};
let failures = 0;
for (const source of ["SECURITY.md", "docs/sprite-targets-guide.md"]) {
  const text = readFileSync(resolve(here, source), "utf8");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = m[1];
    if (/^[a-z]+:/i.test(href)) {
      console.log(`${source}: ${href} external, skipped`);
      continue;
    }
    const [path, anchor] = href.split("#");
    const sourceFile = resolve(root, source);
    const target = path === "" ? resolve(here, source) : resolve(dirname(sourceFile), path);
    const fileOk = existsSync(target);
    const anchorOk = anchor === undefined || (fileOk && anchors(target).includes(anchor));
    const ok = fileOk && anchorOk;
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${source}: (${href}) -> ${target}${anchor ? ` #${anchor} ${anchorOk ? "found" : "MISSING"}` : ""}`,
    );
  }
}
console.log(`result: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exitCode = failures === 0 ? 0 : 1;
