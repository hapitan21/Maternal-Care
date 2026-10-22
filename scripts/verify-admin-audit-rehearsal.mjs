// Offline structural/runner tests only. No child process, network or SQL execution.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildGeneratedFiles, packageDir, functions } from "./prepare-admin-audit-rehearsal.mjs";
import { parseOptions, assertLocalDocker, assertImageMetadata, assertContainer, planSQL, checkPackage, execute } from "../docs/rehearsal/admin-audit-production/run.mjs";

let assertions = 0;
const check = (actual, expected) => { assert.deepEqual(actual,expected); assertions++; };
const rejects = fn => { assert.throws(fn); assertions++; };
const read = name => fs.readFileSync(path.join(packageDir,name),"utf8").replaceAll("\r\n","\n");
const generated = buildGeneratedFiles();
for (const [name,content] of Object.entries(generated)) check(read(name),content);
const manifest=checkPackage(); check(Object.keys(manifest.productionBodyMd5).length,4);
for(const [name,,hash] of functions) {
  const ddl=generated["bootstrap.sql"].slice(generated["bootstrap.sql"].indexOf(`create or replace function public.${name}(`));
  const body=ddl.match(/as \$function\$([\s\S]*?)\$function\$;/i)[1];
  check(crypto.createHash("md5").update(body).digest("hex"),hash);
}
const nonce="0123456789abcdef0123456789abcdef", image="postgres:17@sha256:"+"a".repeat(64);
const args=["--nonce",nonce,"--image",image,"--pg-major","17","--pg-version","17.6"];
const options=parseOptions(["create",...args,"--approval","CREATE_ISOLATED_REHEARSAL"]);
check(options.database,"mc_audit_0123456789ab");
for (const [before,after] of [[nonce,"Maternal-Care-Staging"],[image,"postgres:latest"],["17","16"]]) {
  rejects(()=>parseOptions(["create",...args.map(v=>v===before?after:v),"--approval","CREATE_ISOLATED_REHEARSAL"]));
}
const exactImage="postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929";
const exactOptions=parseOptions(["create",...args.map(v=>v===image?exactImage:v),"--approval","CREATE_ISOLATED_REHEARSAL"]);
check(exactOptions.version,"17.6"); check(exactOptions.major,"17"); check(exactOptions.image,exactImage);
for(const reference of [exactImage.replace("17.6@","17.11@"),exactImage.replace("17.6@","16.6@"),
  "postgres:17.6",exactImage.replace("postgres:","remote.example/postgres:"),exactImage.replace("17.6@","17.6-alpine@"),
  exactImage.replace("17.6@","17.6.0@")]) {
  rejects(()=>parseOptions(["create",...args.map(v=>v===image?reference:v),"--approval","CREATE_ISOLATED_REHEARSAL"]));
}
rejects(()=>parseOptions(["create",...args.slice(0,-2),"--approval","CREATE_ISOLATED_REHEARSAL"]));
rejects(()=>parseOptions(["create",...args.map(v=>v==="17.6"?"17.60-extra":v),"--approval","CREATE_ISOLATED_REHEARSAL"]));
const imageMetadata={Os:"linux",RepoDigests:[exactImage.replace(":17.6@","@")],Config:{Env:["PG_MAJOR=17","PG_VERSION=17.6-2.pgdg13+1"]}};
assertImageMetadata(imageMetadata,exactOptions); assertions++;
assertImageMetadata({...imageMetadata,Config:{Env:["PG_MAJOR=17","PG_VERSION=17.6"]}},exactOptions); assertions++;
assertImageMetadata({...imageMetadata,RepoDigests:[image.replace(":17@","@")]},options); assertions++;
const newerMajorImage="postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3";
const newerMajorOptions=parseOptions(["create",...args.map(v=>v===image?newerMajorImage:v),"--approval","CREATE_ISOLATED_REHEARSAL"]);
rejects(()=>assertImageMetadata({...imageMetadata,RepoDigests:[newerMajorImage.replace(":17@","@")],
  Config:{Env:["PG_MAJOR=17","PG_VERSION=17.11-1.pgdg13+2"]}},newerMajorOptions));
for(const mutate of [v=>v.Config.Env=["PG_MAJOR=17","PG_VERSION=17.11-1.pgdg13+2"],
  v=>v.Config.Env=["PG_MAJOR=16","PG_VERSION=17.6-2.pgdg13+1"],v=>v.Config.Env=["PG_MAJOR=17"],
  v=>v.Config.Env.push("PG_VERSION=17.6"),v=>v.Config.Env=["PG_MAJOR=17","PG_VERSION=17.60"],
  v=>v.Config.Env=["PG_MAJOR=17","PG_VERSION=17.6garbage"],v=>v.Os="windows",
  v=>v.RepoDigests=["remote.example/postgres@"+exactImage.split("@")[1]],v=>v.RepoDigests=["postgres@sha256:"+"f".repeat(64)]]) {
  const value=structuredClone(imageMetadata);mutate(value);rejects(()=>assertImageMetadata(value,exactOptions));
}
// Exercise the pre-create path with a mocked transport; never invoke real Docker.
function createFixture({metadata=imageMetadata,imageResult,endpoint="npipe:////./pipe/docker_engine",exists=false}={}) {
  const calls=[];
  const invoke=(command)=>{
    calls.push(command);
    if(command[0]==="context") return {status:0,stdout:JSON.stringify(endpoint)};
    if(command[0]==="container") return exists?{status:0,stdout:"[]"}:{status:1,stderr:"No such container"};
    if(command[0]==="image") return imageResult || {status:0,stdout:JSON.stringify([metadata])};
    assert.equal(command[0],"run"); return {status:0,stdout:"synthetic-new-container"};
  };
  return {calls,run:()=>execute(exactOptions,invoke)};
}
const accepted=createFixture(), originalLog=console.log;
try { console.log=()=>{}; accepted.run(); } finally { console.log=originalLog; }
check(accepted.calls.at(-1).at(-1),exactImage);
check(accepted.calls.at(-1).includes("--pull=never"),true);
check(accepted.calls.at(-1).includes("--network=none"),true);
check(accepted.calls.at(-1).includes("--publish"),false);
check(accepted.calls.at(-1).includes("--mount"),false);
check(accepted.calls.at(-1).includes("--volume"),false);
for(const setup of [{imageResult:{status:1,stderr:"No such image"}},
  {metadata:{...imageMetadata,Config:{Env:["PG_MAJOR=17","PG_VERSION=17.11-1.pgdg13+2"]}}},
  {metadata:{...imageMetadata,RepoDigests:[]}}, {imageResult:{status:0,stdout:"[]"}},
  {endpoint:"ssh://remote"},{exists:true}]) {
  const f=createFixture(setup);rejects(f.run);
  check(f.calls.some(command=>["run","pull","start","exec","stop","rm"].includes(command[0])),false);
}
for(const a of [[],["apply",...args],["apply",...args,"--approval","CREATE_ISOLATED_REHEARSAL"],
 ["create",...args,"--approval","CREATE_ISOLATED_REHEARSAL","--db-url","postgres://production"],
 ["create",...args,"--approval","CREATE_ISOLATED_REHEARSAL","--host","Maternal-Care-Staging"],
 ["create",...args,"--approval","CREATE_ISOLATED_REHEARSAL","--nonce",nonce]]) rejects(()=>parseOptions(a));
for(const value of ["http://production.supabase.co","https://Maternal-Care-Staging.supabase.co","tcp://localhost:2375","ssh://server"]) {
  rejects(()=>assertLocalDocker(value,{}));
}
assertLocalDocker("npipe:////./pipe/docker_engine",{}); assertions++;
assertLocalDocker("unix:///var/run/docker.sock",{}); assertions++;
rejects(()=>assertLocalDocker("unix:///var/run/docker.sock",{DOCKER_HOST:"ssh://remote"}));
const container={Name:`/${options.container}`,Config:{Image:image,Labels:{"maternal.audit.rehearsal":nonce}},
  HostConfig:{NetworkMode:"none",PortBindings:{},Binds:[]},Mounts:[]};
assertContainer(container,options); assertions++;
for(const mutate of [v=>v.Config.Labels={},v=>v.Config.Image="postgres:latest",v=>v.HostConfig.NetworkMode="bridge",
  v=>v.HostConfig.PortBindings={5432:[{}]},v=>v.HostConfig.Binds=["production:/data"],v=>v.Mounts=[{Type:"bind"}]]) {
  const value=structuredClone(container); mutate(value); rejects(()=>assertContainer(value,options));
}
const candidate=read("migration.sql");
check(planSQL("apply").includes(candidate),true);
const trial=planSQL("rollback-trial");
check(trial.includes(candidate.replace(/\ncommit;\s*$/,"\n")),true);
check(/\ncommit;/.test(trial),false);
check(trial.includes("rollback;"),true);
check(trial.includes("Expected exactly six validated production audit constraints."),true);
check(planSQL("guard-trial").includes("reset search_path;"),true);
check(planSQL("failure-trial").includes("Synthetic late migration failure"),true);
check(/\ncommit;/.test(planSQL("failure-trial")),false);
check(planSQL("test").includes("rollback;"),true);
const inspection=planSQL("inspect").replace(/--[^\n]*|'(?:''|[^'])*'/g, "");
check(/\b(?:insert|update|delete|truncate|alter|create|drop)\b/i.test(inspection),false);
for(const required of ["visit_records","appointment_management","patient_management","system_settings",
 "set local role anon", "set local role authenticated", "set local role service_role",
 "Synthetic outer failure", "rehearsal_reject_success", "sensitive metadata", "17 client receipts", "six status successes expected"]) {
  check(read("tests.sql").includes(required),true);
}
check(read("baseline-check.sql").includes("baseline function not restored"),true);
// Targeted static check for declared PL/pgSQL variables reused as SQL relation aliases.
// This is not a PostgreSQL parser/compilation test. The negative control recreates
// the production-shaped rehearsal's confirmed b.conname resolution failure.
function variableAliasCollisions(source) {
  const collisions=[];
  for(const block of source.matchAll(/\b(?:do|as)\s+(\$(?:[a-z_][a-z0-9_]*)?\$)([\s\S]*?)\1/gi)) {
    const body=block[2].replace(/--[^\n]*|'(?:''|[^'])*'/g,match=>match.startsWith("--")?" ":"'literal'")
      .replace(/\bis\s+(?:not\s+)?distinct\s+from\b/gi,"IS_DISTINCT_FROM");
    const declaration=body.match(/^\s*declare\b([\s\S]*?)\bbegin\b/i)?.[1];
    if(!declaration) continue;
    const variables=new Set(declaration.split(";").map(d=>d.trim().match(/^(\w+)\s/)?.[1]?.toLowerCase()).filter(Boolean));
    for(const alias of body.matchAll(/\b(?:from|join)\s+\w+(?:\.\w+)*\s+(?:as\s+)?(\w+)/gi)) {
      if(variables.has(alias[1].toLowerCase())) collisions.push(alias[1].toLowerCase());
    }
  }
  return collisions;
}
const baselineCheck=read("baseline-check.sql");
check(variableAliasCollisions(baselineCheck.replaceAll("saved_constraint","b")),["b"]);
check(variableAliasCollisions("do $scope$ declare v_role text; v_status text; begin if v_role is distinct from 'admin' or v_status is distinct from 'active' then null; end if; end $scope$;"),[]);
for(const file of fs.readdirSync(packageDir).filter(name=>name.endsWith(".sql"))) {
  check(variableAliasCollisions(read(file)),[]);
}
check(baselineCheck.includes("constraints_before saved_constraint where not exists("),true);
for(const predicate of ["c.conname=saved_constraint.conname","c.convalidated=saved_constraint.convalidated",
  "pg_get_constraintdef(c.oid)=saved_constraint.definition","'public.audit_logs'::regclass)<>6"]) {
  check(baselineCheck.includes(predicate),true);
}
const baselinePosition=trial.indexOf(baselineCheck.replace(/^\\ir guard\.sql\s*$/gm,()=>read("guard.sql")));
check(baselinePosition>=0,true);
check(baselinePosition<trial.indexOf(candidate.replace(/\ncommit;\s*$/,"\n")),true);
// Targeted guard for PostgreSQL 17 IF-condition scanning: a top-level CASE's
// first THEN can terminate the condition before its SQL expression is complete.
// Assignments and CASE inside parentheses do not have that delimiter collision.
// This models this specific risk; it is not a PostgreSQL compiler.
function topLevelIfCases(source) {
  const tokens=source.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g," ")
    .toLowerCase().match(/[a-z_][a-z0-9_]*|[()[\];]/g) || [];
  let condition=false, depth=0, previous="", risks=0;
  for(const token of tokens) {
    if((token==="if" && previous!=="end") || token==="elsif") { condition=true; depth=0; }
    else if(condition) {
      if(token==="(" || token==="[") depth++;
      else if(token===")" || token==="]") depth--;
      else if(token==="case" && depth===0) risks++;
      else if((token==="then" && depth===0) || token===";") condition=false;
    }
    previous=token;
  }
  return risks;
}
const statusBlock=read("tests.sql").match(/do \$status\$([\s\S]*?)end \$status\$;/)[1];
check(topLevelIfCases("if result->>'account_status'<>case when action_name='deactivate' then 'inactive' else 'active' end then null; end if;"),1);
check(topLevelIfCases("expected_status:=case when action_name='deactivate' then 'inactive' else 'active' end; if account_status<>expected_status then null; end if;"),0);
check(topLevelIfCases("if account_status<>(case when action_name='deactivate' then 'inactive' else 'active' end) then null; end if;"),0);
check(topLevelIfCases("if not exists(select 1 where previous_status=case when action_name='deactivate' then 'active' else 'inactive' end) then null; end if;"),0);
check(topLevelIfCases("if valid then null; elsif status<>case when valid then 'active' else 'inactive' end then null; end if;"),1);
check(topLevelIfCases(statusBlock),0);
check(statusBlock.includes("expected_status text;"),true);
const statusAssignment="expected_status:=case when action_name='deactivate' then 'inactive' else 'active' end;";
check(statusBlock.includes(statusAssignment),true);
check(statusBlock.indexOf(statusAssignment)<statusBlock.indexOf("execute format("),true);
check(statusBlock.includes("result->>'account_status'<>expected_status"),true);
check(statusBlock.includes("metadata->>'previous_status'=case when action_name='deactivate' then 'active' else 'inactive' end"),true);
check(read("post-check.sql").includes("Admin business body/grants changed"),true);
check(read("post-check.sql").includes("historical audit records changed"),true);
const runner=read("run.mjs");
check(runner.includes('"--pull=never"'),true);
check(runner.includes('"--host=/var/run/postgresql"'),true);
check(/\b(?:supabase|pg_restore)\s+(?:start|db|restore)/.test(runner),false);
console.log(`PASS: ${assertions} rehearsal package/identity/guard assertions; 0 failures. No PostgreSQL compilation, Docker or SQL execution performed.`);
