// PREPARED ONLY. No Docker/SQL action occurs on import, --help, or --check.
// An acknowledgement flag is an interlock, not a substitute for user approval.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const modes = ["create", "bootstrap", "rollback-trial", "guard-trial", "failure-trial", "apply", "test", "inspect"];
const approvals = {
  create: "CREATE_ISOLATED_REHEARSAL", bootstrap: "EXECUTE_SYNTHETIC_BASELINE",
  "rollback-trial": "EXECUTE_ROLLBACK_TRIAL", "guard-trial": "EXECUTE_GUARD_TRIAL",
  "failure-trial": "EXECUTE_FAILURE_TRIAL",
  apply: "APPLY_ISOLATED_CANDIDATE", test: "EXECUTE_SYNTHETIC_TESTS", inspect: "INSPECT_ISOLATED_REHEARSAL",
};
const hash = s => crypto.createHash("sha256").update(s).digest("hex");
const read = name => fs.readFileSync(path.join(dir, name), "utf8").replaceAll("\r\n", "\n");
export function checkPackage() {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.kind, "synthetic-production-audit-rehearsal");
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert(/^[a-z-]+\.(sql|mjs)$/.test(name), "Unexpected package path");
    assert.equal(hash(read(name)), expected, `Package changed: ${name}; stop for review`);
  }
  for (const name of ["run.mjs", "bootstrap.sql", "guard.sql", "migration.sql", "post-check.sql", "baseline-check.sql", "tests.sql", "inspect.sql"]) {
    assert(manifest.files[name], `Unsealed file: ${name}`);
  }
  return manifest;
}
export function parseOptions(argv) {
  assert(modes.includes(argv[0]), "Unknown rehearsal mode");
  const options = { mode: argv[0] };
  for (let i=1; i<argv.length; i+=2) {
    const key=argv[i]; assert(["--nonce","--image","--pg-major","--pg-version","--approval"].includes(key), `Refused argument ${key}`);
    assert(argv[i+1] && !options[key], "Missing/duplicate argument"); options[key]=argv[i+1];
  }
  assert(/^[a-f0-9]{32}$/.test(options["--nonce"] || ""), "A new 32-character hexadecimal nonce is required");
  assert(/^1[3-9]$/.test(options["--pg-major"] || ""), "Supply the independently verified production PostgreSQL major");
  const version=options["--pg-version"] || "";
  assert(/^(1[3-9])\.(0|[1-9][0-9]*)$/.test(version) && version.split(".")[0] === options["--pg-major"], "Supply the expected exact PostgreSQL version matching that major");
  const reference=(options["--image"] || "").match(/^postgres:(1[3-9])(?:\.(0|[1-9][0-9]*))?@sha256:[a-f0-9]{64}$/);
  assert(reference && reference[1] === options["--pg-major"] && (reference[2] === undefined || `${reference[1]}.${reference[2]}` === version), "Use an approved, locally cached, digest-pinned official postgres image matching the expected major/version");
  assert.equal(options["--approval"], approvals[options.mode], "No execution acknowledgement for this phase");
  const nonce=options["--nonce"];
  return { ...options, nonce, image:options["--image"], major:options["--pg-major"], version,
    container:`mc-audit-rehearsal-${nonce}`, database:`mc_audit_${nonce.slice(0,12)}` };
}
export function assertLocalDocker(endpoint, env = process.env) {
  assert(/^(npipe:\/\/|unix:\/\/)/.test(endpoint), "Remote/TCP/SSH Docker endpoints are refused");
  if (env.DOCKER_HOST) assert(/^(npipe:\/\/|unix:\/\/)/.test(env.DOCKER_HOST), "Remote DOCKER_HOST refused");
}
export function assertImageMetadata(value, o) {
  assert(value && value.Os === "linux", "Unexpected/non-Linux PostgreSQL image");
  const digest=o.image.split("@")[1];
  assert(Array.isArray(value.RepoDigests) && (value.RepoDigests.includes(`postgres@${digest}`)
    || value.RepoDigests.includes(`docker.io/library/postgres@${digest}`)), "Cached image repository/digest mismatch");
  const metadata = key => {
    const entries=value.Config?.Env?.filter(entry => entry.startsWith(`${key}=`));
    assert(entries?.length === 1, `Missing/ambiguous image ${key} metadata`);
    return entries[0].slice(key.length+1);
  };
  assert.equal(metadata("PG_MAJOR"),o.major,"Image PG_MAJOR mismatch");
  // Official Debian images include a packaging suffix, e.g. 17.6-2.pgdg13+1.
  const installed=metadata("PG_VERSION").match(/^(\d+\.\d+)(?:-[0-9][0-9A-Za-z.+~]*)?$/);
  assert(installed && installed[1] === o.version, "Image PG_VERSION does not match the expected exact PostgreSQL version");
}
export function assertContainer(value, o) {
  assert.equal(value.Name, `/${o.container}`, "Container identity mismatch");
  assert.equal(value.Config?.Labels?.["maternal.audit.rehearsal"], o.nonce, "Unmarked container refused");
  assert.equal(value.Config.Image,o.image,"Image mismatch");
  assert.equal(value.HostConfig?.NetworkMode,"none","Container must have no network");
  assert.equal(Object.keys(value.HostConfig?.PortBindings || {}).length,0,"Exposed ports refused");
  assert.equal((value.HostConfig?.Binds || []).length,0,"Host bind mounts refused");
  assert(!(value.Mounts || []).some(m => m.Type === "bind"),"Host bind mounts refused");
}
function sql(name) {
  return read(name).replace(/^\\ir guard\.sql\s*$/gm, () => read("guard.sql"));
}
export function planSQL(mode) {
  const guard=read("guard.sql"), candidate=read("migration.sql");
  assert(/\ncommit;\s*$/.test(candidate));
  const beforeCommit=candidate.replace(/\ncommit;\s*$/, "\n");
  switch(mode) {
    case "bootstrap": return sql("bootstrap.sql")+sql("baseline-check.sql");
    case "rollback-trial": return guard+sql("baseline-check.sql")+beforeCommit+sql("post-check.sql")+sql("tests.sql")+
      "\nrollback;\n"+sql("baseline-check.sql");
    case "guard-trial":
      // Existing read-only hash guard must fail after controlled drift in this transaction.
      // ON_ERROR_STOP closes the session and rolls back this change; no guard is removed.
      return guard+sql("baseline-check.sql")+"\nbegin;\n"+
        "alter function public.record_audit_event(text,text,text,text,text,jsonb,uuid) reset search_path;\n"+candidate;
    case "failure-trial": return guard+sql("baseline-check.sql")+beforeCommit+
      "\ndo $failure$ begin raise exception 'Synthetic late migration failure' using errcode='ZX002'; end $failure$;\n";
    case "apply": return guard+sql("baseline-check.sql")+candidate+sql("post-check.sql");
    case "test": return guard+sql("post-check.sql")+"\nbegin;\n"+sql("tests.sql")+sql("post-check.sql")+"\nrollback;\n"+sql("post-check.sql");
    case "inspect": return sql("inspect.sql");
    default: throw Error("No SQL for this mode");
  }
}
function docker(args, input) {
  return spawnSync("docker",args,{ input,encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024 });
}
function mustDocker(args,input,invoke=docker) {
  const result=invoke(args,input);
  assert.equal(result.status,0,`Docker operation failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}
function runSQL(o, text, invoke=docker) {
  // No URI, host, password or project-ref argument is accepted. Explicit local socket.
  const prefix=`set audit_rehearsal.nonce='${o.nonce}';\nset audit_rehearsal.major='${o.major}';\n`;
  return invoke(["exec","-i",o.container,"psql","--no-psqlrc","--no-password",
    "--host=/var/run/postgresql","--username=postgres",`--dbname=${o.database}`,"--set=ON_ERROR_STOP=1"],prefix+text);
}
export function execute(o, invoke=docker) {
  checkPackage();
  const must=(args,input)=>mustDocker(args,input,invoke);
  const endpoint=JSON.parse(must(["context","inspect","--format","{{json .Endpoints.docker.Host}}"]));
  assertLocalDocker(endpoint);
  if(o.mode === "create") {
    const exists=invoke(["container","inspect",o.container]);
    assert(exists.status !== 0 && /No such (container|object)/i.test(exists.stderr),"Existing container or inaccessible daemon: refusing creation");
    const images=JSON.parse(must(["image","inspect",o.image])); // Cached metadata only; never run an image to inspect it.
    assert(Array.isArray(images) && images.length === 1,"Expected exactly one cached image");
    assertImageMetadata(images[0],o);
    must(["run","--detach","--pull=never","--name",o.container,"--network=none",
      "--label",`maternal.audit.rehearsal=${o.nonce}`,"--env","POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",`POSTGRES_DB=${o.database}`,o.image]);
    console.log("Created isolated container. Wait for pg_isready before the separately approved bootstrap phase."); return;
  }
  assertContainer(JSON.parse(must(["container","inspect",o.container]))[0],o);
  const result=runSQL(o,planSQL(o.mode),invoke);
  if(["guard-trial","failure-trial"].includes(o.mode)) {
    assert.notEqual(result.status,0,"Expected preflight rejection did not occur");
    const expected=o.mode === "guard-trial" ? /Definition mismatch: public\.record_audit_event/ : /Synthetic late migration failure/;
    assert(expected.test(result.stderr),`Unexpected failure: ${result.stderr}`);
    const recovered=runSQL(o,sql("baseline-check.sql"),invoke);
    assert.equal(recovered.status,0,recovered.stderr);
    console.log("PASS: expected rejection/failure; connection-close rollback restored the exact baseline."); return;
  }
  assert.equal(result.status,0,`SQL phase failed; stop, preserve container for diagnosis: ${result.error?.message || result.stderr}`);
  console.log(result.stdout.trim());
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length===2 || process.argv[2]==="--help") console.log("Prepared rehearsal only. Read README.md and obtain approval for each phase. --check verifies files without Docker/SQL. Modes: "+modes.join(", "));
    else if(process.argv[2]==="--check") { checkPackage(); console.log("PASS: sealed package hashes; no Docker or SQL executed."); }
    else execute(parseOptions(process.argv.slice(2)));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
