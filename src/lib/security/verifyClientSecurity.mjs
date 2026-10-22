import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const sourceDirectory = path.join(repositoryRoot, "src");
const buildDirectory = path.join(repositoryRoot, "dist");
const verifierPath = path.resolve(fileURLToPath(import.meta.url));
const findings = [];
const scannedFiles = [];

const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const riskySourcePatterns = [
  ["Raw HTML injection sink", /dangerouslySetInnerHTML\s*[:=]|\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(/g],
  ["Dynamic script execution", /\beval\s*\(|\bnew\s+Function\s*\(/g],
  ["Privileged browser environment variable name", /import\.meta\.env\.(VITE_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|PRIVATE_KEY|ACCESS_TOKEN|PASSWORD|DATABASE_URL)[A-Z0-9_]*)/g],
];

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    findings.push(`Cannot read ${path.relative(repositoryRoot, directory)}: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) continue;
    if (path.resolve(entryPath) === verifierPath) continue;
    scannedFiles.push(entryPath);

    let content;
    try {
      content = await readFile(entryPath, "utf8");
    } catch (error) {
      findings.push(`Cannot read ${path.relative(repositoryRoot, entryPath)}: ${error.message}`);
      continue;
    }

    for (const [label, pattern] of riskySourcePatterns) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const line = content.slice(0, match.index).split("\n").length;
        findings.push(`${label}: ${path.relative(repositoryRoot, entryPath)}:${line}`);
      }
    }
  }
}

async function checkBuildSourceMaps() {
  let entries;
  try {
    entries = await readdir(buildDirectory, { withFileTypes: true });
  } catch {
    console.log("Build artifact check skipped: dist/ does not exist. Run npm run build first.");
    return;
  }

  const stack = entries.map((entry) => path.join(buildDirectory, entry.name));
  while (stack.length) {
    const entryPath = stack.pop();
    let entry;
    try {
      const children = await readdir(entryPath, { withFileTypes: true });
      stack.push(...children.map((child) => path.join(entryPath, child.name)));
      continue;
    } catch {
      entry = path.basename(entryPath);
    }

    if (entry.endsWith(".map")) {
      findings.push(`Production source map found: ${path.relative(repositoryRoot, entryPath)}`);
      continue;
    }
    if (!/\.m?js$/i.test(entry)) continue;

    try {
      const content = await readFile(entryPath, "utf8");
      if (/sourceMappingURL\s*=/.test(content)) {
        findings.push(`Source map reference found: ${path.relative(repositoryRoot, entryPath)}`);
      }
    } catch (error) {
      findings.push(`Cannot inspect build file ${path.relative(repositoryRoot, entryPath)}: ${error.message}`);
    }
  }
}

await walk(sourceDirectory);
await checkBuildSourceMaps();

console.log(`Scanned ${scannedFiles.length} source files for common unsafe sinks and privileged VITE_ variable names.`);

if (findings.length) {
  console.error("Client security checks found items requiring review:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("No configured static checks failed.");
}

console.log("This check is not a substitute for RLS tests, dependency review, or runtime security testing.");
