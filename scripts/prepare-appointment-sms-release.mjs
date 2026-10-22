// Local files only. Never executes SQL, Docker, a provider, or a deployment command.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
export const runtimeFiles = [
  "supabase/functions/process-appointment-sms/index.ts",
  "supabase/functions/process-appointment-sms/deno.json",
  "supabase/functions/send-notification-sms/index.ts",
  "supabase/functions/send-notification-sms/deno.json",
  ...["appointmentSms", "appointmentEventSmsControl", "iprogSms", "semaphoreSms", "smsTransportReservation", "supabaseSecretAuth"]
    .map(name => `supabase/functions/_shared/${name}.ts`),
];
const reviewSource = "docs/sql-drafts/appointment-event-sms-control.sql";
const reviewTarget = "review-only/appointment-event-sms-control.sql";
export const packetFiles = [...runtimeFiles, "supabase/config.toml", reviewTarget];
const config = 'project_id = "appointment-sms-release"\n\n[functions.send-notification-sms]\nverify_jwt = false\n\n[functions.process-appointment-sms]\nverify_jwt = false\n';
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const read = (root, relative) => fs.readFileSync(path.join(root, relative), "utf8");

export function checkDependencies(root) {
  const typescript = runtimeFiles.filter(p => p.endsWith(".ts"));
  for (const relative of typescript) {
    const source = read(root, relative);
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
        assert(typescript.includes(dependency), `Unapproved runtime dependency: ${relative}`);
        assert(fs.existsSync(path.join(root, dependency)), "Missing runtime dependency");
      } else assert.equal(specifier, "@supabase/supabase-js", "Unapproved external dependency");
    }
    assert(!/\bimport\s*\(/.test(source), "Dynamic imports require separate release review");
  }
  for (const name of ["process-appointment-sms", "send-notification-sms"]) {
    const settings = JSON.parse(read(root, `supabase/functions/${name}/deno.json`));
    assert.deepEqual(settings.imports, { "@supabase/supabase-js": "npm:@supabase/supabase-js@2.105.3" });
  }
}

function listFiles(root, relative = "") {
  const result = [];
  for (const name of fs.readdirSync(path.join(root, relative))) {
    const p = path.posix.join(relative, name), stat = fs.lstatSync(path.join(root, p));
    assert(!stat.isSymbolicLink(), "Packet symlinks are forbidden");
    if (stat.isDirectory()) result.push(...listFiles(root, p));
    else { assert(stat.isFile(), "Unexpected packet object"); result.push(p); }
  }
  return result.sort();
}

export function verifyPacket(directory) {
  const absolute = path.resolve(directory);
  const canonical = p => {
    const resolved = fs.realpathSync.native(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  assert.equal(canonical(path.dirname(absolute)), canonical(os.tmpdir()), "Require the original temporary packet location");
  assert(/^maternal-sms-release-[a-zA-Z0-9]+$/.test(path.basename(absolute)), "Wrong packet identity");
  assert(!fs.lstatSync(absolute).isSymbolicLink(), "Packet root must not be a symlink");
  const manifestText = read(absolute, "release-manifest.json"), manifest = JSON.parse(manifestText);
  assert.equal(manifest.kind, "maternal-appointment-event-sms-release");
  assert.equal(manifest.deploymentApproved, false);
  assert.deepEqual(Object.keys(manifest.files).sort(), [...packetFiles].sort(), "Unexpected manifest paths");
  assert.deepEqual(listFiles(absolute), [...packetFiles, "release-manifest.json"].sort(), "Unexpected packet files");
  for (const [relative, hash] of Object.entries(manifest.files)) {
    assert(/^[a-f0-9]{64}$/.test(hash), "Invalid SHA-256");
    assert.equal(sha(fs.readFileSync(path.join(absolute, relative))), hash, `Packet hash mismatch: ${relative}`);
  }
  assert.equal(read(absolute, "supabase/config.toml"), config);
  checkDependencies(absolute);
  return { packet: absolute, files: packetFiles.length, manifestSha256: sha(manifestText), status: "REVIEW_REQUIRED" };
}

export function preparePacket() {
  checkDependencies(sourceRoot);
  const currentConfig = read(sourceRoot, "supabase/config.toml");
  for (const name of ["send-notification-sms", "process-appointment-sms"]) {
    assert(new RegExp(`\\[functions\\.${name}\\]\\s+verify_jwt = false`).test(currentConfig), "Source auth mode changed");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maternal-sms-release-"));
  const contents = new Map(runtimeFiles.map(p => [p, fs.readFileSync(path.join(sourceRoot, p))]));
  contents.set("supabase/config.toml", config);
  contents.set(reviewTarget, fs.readFileSync(path.join(sourceRoot, reviewSource)));
  for (const [relative, content] of contents) {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.writeFileSync(path.join(directory, relative), content, { flag: "wx" });
  }
  const manifest = {
    kind: "maternal-appointment-event-sms-release", createdAt: new Date().toISOString(),
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    deploymentApproved: false, credentialsIncluded: false,
    deployOrder: ["send-notification-sms", "process-appointment-sms"],
    sqlReviewSource: reviewSource,
    files: Object.fromEntries([...contents].map(([p, content]) => [p, sha(content)])),
  };
  fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return verifyPacket(directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === "--prepare") console.log(JSON.stringify(preparePacket()));
  else if (process.argv.length === 4 && process.argv[2] === "--check") console.log(JSON.stringify(verifyPacket(process.argv[3])));
  else throw new Error("Use --prepare OR --check <packet>; no deployment or SQL mode exists.");
}
