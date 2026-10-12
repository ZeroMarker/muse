// Package already-verified builds; --check validates release metadata only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const [tag, mode, ...extra] = process.argv.slice(2);
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag ?? "")
  || (mode !== undefined && mode !== "--check") || extra.length) {
  throw new Error("usage: node scripts/package-release.mjs vMAJOR.MINOR.PATCH[-prerelease] [--check]");
}
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const cargo = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], { encoding: "utf8" }));
const core = cargo.packages.find((pkg) => pkg.name === "muse-core");
if (tag !== `v${version}` || lock.version !== version || lock.packages[""].version !== version || core?.version !== version) {
  throw new Error("release tag, package.json, package-lock.json and muse-core version must match");
}
console.log(`release metadata verified: ${tag}`);
if (mode !== "--check") {
  const cliVersion = execFileSync(process.execPath, ["dist/cli/muse.cjs", "--version"], { encoding: "utf8" }).trim();
  if (cliVersion !== version) throw new Error("CLI build is stale: rebuild before packaging");
  // Fail before writing archives if the web build is absent or incomplete.
  for (const path of ["dist/web/index.html", "dist/web/muse_core.wasm"]) readFileSync(path);
  const staging = mkdtempSync(join(tmpdir(), "muse-release-"));
  const output = join(process.cwd(), "dist/release", tag);
  mkdirSync(output, { recursive: true });
  const archives = [];
  try {
    for (const kind of ["cli", "web"]) {
      const name = `muse-${tag}-${kind}`;
      const directory = join(staging, name);
      cpSync(`dist/${kind}`, directory, { recursive: true });
      for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json"]) {
        cpSync(file, join(directory, file));
      }
      if (kind === "cli") {
        for (const file of ["README.md", "docs", "examples"]) cpSync(file, join(directory, file), { recursive: true });
      }
      const filename = `${name}.tar.gz`;
      execFileSync("tar", ["-czf", join(output, filename), "-C", staging, name]);
      archives.push(filename);
    }
    const checksums = archives.map((name) => `${createHash("sha256").update(readFileSync(join(output, name))).digest("hex")}  ${name}\n`).join("");
    writeFileSync(join(output, "SHA256SUMS"), checksums);
    console.log(`release assets written to ${output}`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
