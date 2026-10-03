import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPsqlSession, verifyRetrySql } from "./verify-patient-native-push-retry-sql.mjs";

const root = new URL("../", import.meta.url);
export const staleMigrationPath = "supabase/migrations/20261003150000_patient_native_push_stale_processing_recovery.sql";
const read = file => readFileSync(new URL(file,root),"utf8");
export function verifyStaleRecoverySql() {
  verifyRetrySql();
  const sql = read(staleMigrationPath);
  const recovery = sql.slice(sql.indexOf("as $recovery$"),sql.indexOf("$recovery$;"));
  for (const fragment of ["security definer set search_path = ''","order by delivery.attempted_at,delivery.id",
    "limit 50","for update of delivery skip locked","delivery.status='processing'",
    "delivery.attempted_at <= pg_catalog.clock_timestamp()-interval '10 minutes'",
    "status='delivery_unknown',next_attempt_at=null,recovery_at=pg_catalog.clock_timestamp()",
    "recovery_reason='stale_processing_unknown_outcome'"]) assert.ok(recovery.includes(fragment) || sql.includes(fragment),fragment);
  assert.equal((recovery.match(/attempted_at <= pg_catalog.clock_timestamp\(\)-interval '10 minutes'/g)||[]).length,2);
  assert.doesNotMatch(recovery,/created_at|updated_at|next_attempt_at\s*[<>]|last_failure_class\s*=|claim_token\s*=|attempt_count\s*=|sent_at\s*=|provider_message_id\s*=|error_code\s*=|error_message\s*=|fcm_http_status\s*=/);
  assert.doesNotMatch(sql,/firebase|https?:|net\.|vault\.|patient_native_push_devices|patient_notifications|medication_reminders|grant\s+(?:insert|update)|create or replace function public\.(?:claim|finalize|list_due)|cron\.alter_job\([^;]*active\s*:=\s*true/i);
  const scheduler = sql.slice(sql.indexOf('do $scheduler$'),sql.indexOf('$scheduler$;'));
  assert.match(scheduler,/select username into strict v_username from cron\.job where jobid=v_job/);
  assert.match(scheduler,/cron\.alter_job\(v_job,active:=false\)/);
  assert.doesNotMatch(scheduler,/cron\.alter_job\([^;]*username\s*:=/i);
  assert.match(scheduler,/username=v_username/);
  assert.equal((sql.match(/create function public\./g)||[]).length,1);
  assert.match(sql,/from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute[^;]*to postgres/);
  assert.match(sql,/on public\.patient_notification_native_push_deliveries\(attempted_at,id\) where status='processing'/);
  const outsideRecovery = sql.replace(recovery,"").replace(/'(?:''|[^'])*'/g,"''");
  assert.doesNotMatch(outsideRecovery,/update public\.patient_notification_native_push_deliveries|perform public\.recover_stale|select public\.recover_stale[^']*;/i);
  const protectedSources = {
    "supabase/migrations/20261003130000_patient_native_push_bounded_retries.sql":"76fead0f66c859def1108becc1d84d4432036b4c13d30781f14b5dfd2de4f0a5",
    "supabase/functions/_shared/firebaseMessaging.ts":"fa47ece4b187cba3d106460a022d2351f1157b923b86e8c12e925ae8e8ee89a4",
    "supabase/functions/send-patient-native-push/index.ts":"dbaefaeaea6e7133c99b6953bfc30088018fba101d95613fedaaba34d60f46a0",
  };
  for (const [file,digest] of Object.entries(protectedSources)) assert.equal(createHash("sha256").update(read(file)).digest("hex"),digest,
    "Reviewed Phase 8B retries/classification/sender must remain unchanged: " + file);
  const baseline = read("supabase/migrations/20261003130000_patient_native_push_bounded_retries.sql");
  for (const hash of baseline.matchAll(/as \$function\$([\s\S]*?)\$function\$/g)) {
    const digest=createHash("md5").update(hash[1].replaceAll("\r\n","\n")).digest("hex");
    if (hash[1].includes("vault.decrypted_secrets")) continue;
    assert.ok(sql.includes(digest),"Preflight must pin each reviewed Phase 8B RPC body");
  }
  return sql;
}
// Source-bound fault model only; real PostgreSQL contracts below prove SQL behavior.
export function recoverStaleLedger(model,now) {
  const rows=[...model.rows.values()].filter(row=>row.status==="processing" && Date.parse(row.attempted_at)<=now-600000)
    .sort((a,b)=>a.attempted_at.localeCompare(b.attempted_at)||a.id.localeCompare(b.id)).slice(0,50);
  for (const row of rows) Object.assign(row,{status:"delivery_unknown",next_attempt_at:null,
    recovery_at:new Date(now).toISOString(),recovery_reason:"stale_processing_unknown_outcome",updated_at:new Date(now).toISOString()});
  return rows.length;
}
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12,"0");
async function realPostgres() {
  const container=process.env.NATIVE_PUSH_STALE_TEST_CONTAINER;
  assert.match(container||"",/^maternal-native-stale-[a-z0-9-]+$/,"Explicitly name the disposable stale-test container.");
  const docker=process.env.NATIVE_PUSH_STALE_TEST_DOCKER || (process.platform==="win32"
    ? path.join(process.env.LOCALAPPDATA||"","Programs/DockerDesktop/resources/bin/docker.exe") : "docker");
  const cwd=fileURLToPath(root);
  const dockerRun=(args,timeout=20000)=>{
    const result=spawnSync(docker,args,{cwd,encoding:"utf8",windowsHide:true,timeout,maxBuffer:150000});
    if(result.error || result.status!==0) throw Error("Isolated Docker/psql failure: "+(result.stderr||result.error?.message||"unknown").slice(0,5000));
    return result.stdout.trim();
  };
  const metadata=JSON.parse(dockerRun(["inspect",container]))[0];
  assert.equal(metadata.Config.Image,"public.ecr.aws/supabase/postgres:17.6.1.104");
  assert.ok(metadata.Mounts.every(m=>m.Type==="tmpfs"));
  assert.equal(Object.keys(metadata.HostConfig.PortBindings||{}).length,0);
  const directory="/tmp/stale";
  dockerRun(["exec",container,"mkdir","-p",directory+"/supabase/tests",directory+"/supabase/migrations"]);
  for (const file of [staleMigrationPath,"supabase/tests/patient_native_push_stale_processing_recovery_test.sql",
    "supabase/migrations/20261002120000_patient_notification_native_push_deliveries.sql",
    "supabase/migrations/20261003130000_patient_native_push_bounded_retries.sql"]) {
    dockerRun(["cp",fileURLToPath(new URL(file,root)),container+":"+directory+"/"+file]);
  }
  const args=["--host=/var/run/postgresql","--username=supabase_admin","--dbname=maternal_native_push_stale_test",
    "--no-psqlrc","--set=ON_ERROR_STOP=1","--tuples-only","--no-align","--quiet"];
  const execArgs=["exec","-i",container,"psql"];
  const run=(sql,timeout=10000)=>dockerRun([...execArgs,...args,"--command="+sql],timeout);
  const serial=dockerRun([...execArgs,...args,"--set=allow_isolated_test=true","--file="+directory+"/supabase/tests/patient_native_push_stale_processing_recovery_test.sql"],30000);
  const summary=/STALE_SQL_ASSERTIONS_PASSED=(\d+)/.exec(serial);
  assert.ok(summary,"Serial SQL must reach its assertion summary.");
  console.log("PASS: real PostgreSQL serial assertions="+summary[1]+"; real inactive pg_cron metadata; offline transport.");
  const sessions=[],pids=[];
  const open=async()=>{
    const session=createPsqlSession(args,{cwd,env:process.env,timeoutMs:45000,
      spawnProcess:(_command,argv,options)=>spawn(docker,[...execArgs,...argv],options)});
    sessions.push(session);session.send("SELECT 'backend:'||pg_backend_pid();");
    const marker=await session.waitFor(/^backend:\d+$/);pids.push(Number(marker.split(":")[1]));return session;
  };
  const row=n=>"notification_id='"+uuid(n)+"'";
  const seed=n=>run("SELECT public.test_seed("+n+",interval '11 minutes');");
  const status=n=>run("SELECT status FROM public.patient_notification_native_push_deliveries WHERE "+row(n)+";");
  const recover=async(session,expected,marker)=>{
    session.send("SELECT 'recover:"+marker+":'||public.recover_stale_patient_native_push_deliveries();");
    await session.waitFor("recover:"+marker+":"+expected);
  };
  const commit=async(session,marker)=>{session.send("COMMIT;\n\\echo "+marker);await session.waitFor(marker);};
  const finalizeSql=(n,permanent=false,wrongToken=false)=>"SELECT 'finalize:'||result||':'||coalesce(status,'') FROM public.finalize_patient_native_push_delivery("
    + "(SELECT id FROM public.patient_notification_native_push_deliveries WHERE "+row(n)+"),"
    + (wrongToken?"gen_random_uuid()":"(SELECT claim_token FROM public.patient_notification_native_push_deliveries WHERE "+row(n)+")")
    + ",1,'"+(permanent?"permanent_device":"success")+"',"+(permanent?"404,'UNREGISTERED',null":"200,null,'synthetic-message'")
    + ",(SELECT updated_at FROM public.patient_native_push_devices WHERE id='"+uuid(2)+"'),null);";
  const proveRowLock=async(session,n)=>{
    session.send("DO $proof$ BEGIN BEGIN PERFORM 1 FROM public.patient_notification_native_push_deliveries WHERE "+row(n)
      + " FOR UPDATE NOWAIT; RAISE EXCEPTION 'Expected real row conflict'; EXCEPTION WHEN lock_not_available THEN NULL; END; END $proof$;\n\\echo ROW_CONFLICT_PROVED");
    await session.waitFor("ROW_CONFLICT_PROVED");
  };
  const proveBlocking=async(a,b)=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      if(run("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid="+b+" AND wait_event_type='Lock' AND "+a+"=ANY(pg_blocking_pids("+b+")));",2000)==="t")return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.fail("Expected real overlapping finalizer/recovery lock wait");
  };
  try {
    // 1. A live database transaction owns the processing row: SKIP LOCKED.
    seed(500);const live=await open(),sweep=await open();
    live.send("BEGIN; SELECT id IS NOT NULL FROM public.patient_notification_native_push_deliveries WHERE "+row(500)+" FOR UPDATE;\n\\echo LIVE_HELD");
    await live.waitFor("LIVE_HELD");await proveRowLock(sweep,500);await recover(sweep,0,"live");assert.equal(status(500),"processing");
    live.send(finalizeSql(500));await live.waitFor("finalize:finalized:sent");await commit(live,"LIVE_DONE");
    await live.finish();await sweep.finish();console.log("PASS race 1: live locked processing/finalization is skipped.");
    // 2/3. Recovery wins; real late success/permanent finalizers wait and acknowledge unknown.
    for(const [n,permanent] of [[501,false],[502,true]]){
      seed(n);const a=await open(),b=await open();a.send("BEGIN;");await recover(a,1,"winner"+n);
      b.send(finalizeSql(n,permanent));await proveBlocking(pids.at(-2),pids.at(-1));await commit(a,"RECOVERY_DONE"+n);
      await b.waitFor("finalize:already_finalized:delivery_unknown");assert.equal(status(n),"delivery_unknown");
      assert.equal(run("SELECT enabled FROM public.patient_native_push_devices WHERE id='"+uuid(2)+"';"),"t");
      await a.finish();await b.finish();console.log("PASS race "+(permanent?3:2)+": recovery precedes late "+(permanent?"permanent cleanup":"success")+" finalization; no overwrite/device change.");
    }
    // 4. Finalization wins before recovery, including overlap before its commit.
    seed(503);const final=await open(),later=await open();final.send("BEGIN;"+finalizeSql(503));await final.waitFor("finalize:finalized:sent");
    await proveRowLock(later,503);await recover(later,0,"finalizer");await commit(final,"FINAL_DONE");await recover(later,0,"finalizer_committed");
    assert.equal(status(503),"sent");await final.finish();await later.finish();console.log("PASS race 4: committed finalizer result is preserved.");
    // 5. Two actual recovery workers overlap; one owns the row.
    seed(504);const one=await open(),two=await open();one.send("BEGIN;");await recover(one,1,"one");
    await proveRowLock(two,504);await recover(two,0,"two");await commit(one,"ONE_DONE");await recover(two,0,"two_after");
    await one.finish();await two.finish();console.log("PASS race 5: two recovery workers perform one terminal transition.");
    // 6. Retry mode cannot claim processing or its terminal resolution.
    seed(505);const r=await open(),retry=await open();r.send("BEGIN;");await recover(r,1,"retryrace");
    const retrySql="SELECT 'retryclaims:'||count(*) FROM public.claim_patient_native_push_delivery('"+uuid(505)+"','"+uuid(2)+"','retry');";
    retry.send(retrySql);await retry.waitFor("retryclaims:0");await commit(r,"RETRY_RECOVERY_DONE");retry.send(retrySql);await retry.waitFor("retryclaims:0");
    assert.equal(run("SELECT count(*) FROM public.list_due_patient_native_push_deliveries();"),"0");await r.finish();await retry.finish();console.log("PASS race 6: retry claims/discovery never replay recovery.");
    // 7. A wrong old fence fails before cleanup; correct preserved fence still acknowledges terminal.
    seed(506);const oldA=await open(),oldB=await open();oldA.send("BEGIN;");await recover(oldA,1,"old");
    oldB.send(finalizeSql(506,true,true));await proveBlocking(pids.at(-2),pids.at(-1));await commit(oldA,"OLD_DONE");
    await oldB.waitFor("finalize:stale_claim:");assert.equal(status(506),"delivery_unknown");await oldA.finish();await oldB.finish();console.log("PASS race 7: old claim token cannot overwrite or clean up.");
    // 8/9. Device changes commit independently while recovery holds the delivery row.
    for(const [n,disabled] of [[507,false],[508,true]]){
      seed(n);const a=await open(),b=await open();a.send("BEGIN;");await recover(a,1,"device"+n);
      b.send("UPDATE public.patient_native_push_devices SET "+(disabled?"enabled=false,disabled_at=clock_timestamp()":"push_token='synthetic-rotated-target'")
        + ",updated_at=clock_timestamp() WHERE id='"+uuid(2)+"';\n\\echo DEVICE_CHANGED");await b.waitFor("DEVICE_CHANGED");
      const before=run("SELECT md5(to_jsonb(d)::text) FROM public.patient_native_push_devices d WHERE id='"+uuid(2)+"';");
      await commit(a,"DEVICE_RECOVERY_DONE"+n);assert.equal(run("SELECT md5(to_jsonb(d)::text) FROM public.patient_native_push_devices d WHERE id='"+uuid(2)+"';"),before);
      assert.equal(status(n),"delivery_unknown");await a.finish();await b.finish();console.log("PASS race "+(disabled?9:8)+": concurrent device "+(disabled?"disable":"rotation")+" remains untouched by recovery.");
    }
  } finally {
    if(pids.length)run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='maternal_native_push_stale_test' AND pid=ANY(ARRAY["+pids.join(",")+"]) AND pid<>pg_backend_pid();");
    await Promise.allSettled(sessions.map(session=>session.stop()));
  }
  // Failures execute the entire actual migration inside a rollback transaction.
  const snapshot=()=>run("SELECT md5(jsonb_build_object('rows',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.patient_notification_native_push_deliveries d),"
    + "'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) FROM pg_attribute a WHERE attrelid='public.patient_notification_native_push_deliveries'::regclass),"
    + "'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c WHERE conrelid='public.patient_notification_native_push_deliveries'::regclass),"
    + "'functions',(SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY oid) FROM pg_proc WHERE proname IN ('claim_patient_native_push_delivery','finalize_patient_native_push_delivery','list_due_patient_native_push_deliveries','recover_stale_patient_native_push_deliveries')),"
    + "'cron',(SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j))::text);");
  const reset="SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='patient-native-push-stale-recovery';"
    + "DROP FUNCTION public.recover_stale_patient_native_push_deliveries();DROP INDEX public.patient_native_push_stale_processing_idx;"
    + "ALTER TABLE public.patient_notification_native_push_deliveries DROP CONSTRAINT patient_native_push_recovery_metadata_check,"
    + "DROP CONSTRAINT patient_native_push_deliveries_status_check,DROP CONSTRAINT patient_native_push_failure_class_check,DROP CONSTRAINT patient_native_push_deliveries_sent_state_check;"
    + "UPDATE public.patient_notification_native_push_deliveries SET status='processing',sent_at=null,last_failure_class=null WHERE status='delivery_unknown';"
    + "ALTER TABLE public.patient_notification_native_push_deliveries DROP COLUMN recovery_at,DROP COLUMN recovery_reason;"
    + "DO $reset$ DECLARE c record; BEGIN FOR c IN SELECT * FROM public.test_constraint_snapshot LOOP EXECUTE 'ALTER TABLE public.patient_notification_native_push_deliveries ADD CONSTRAINT '||quote_ident(c.name)||' '||c.definition; END LOOP; END $reset$;";
  const driftCases=[
    ["status states","ALTER TABLE public.patient_notification_native_push_deliveries DROP CONSTRAINT patient_native_push_deliveries_status_check;ALTER TABLE public.patient_notification_native_push_deliveries ADD CONSTRAINT patient_native_push_deliveries_status_check CHECK(status IN ('processing','sent','failed','disabled_token','unexpected'));",/status constraint differs/],
    ["attempt check","ALTER TABLE public.patient_notification_native_push_deliveries DROP CONSTRAINT patient_native_push_deliveries_attempt_count_check;ALTER TABLE public.patient_notification_native_push_deliveries ADD CONSTRAINT patient_native_push_deliveries_attempt_count_check CHECK(attempt_count>=0);",/attempt_count_check differs/],
    ["uniqueness","ALTER TABLE public.patient_notification_native_push_deliveries DROP CONSTRAINT patient_native_push_deliveries_notification_device_key;",/uniqueness differs/],
    ...["claim_token","attempted_at","created_at","next_attempt_at","last_failure_class","provider_message_id"].map(column=>[column,"ALTER TABLE public.patient_notification_native_push_deliveries RENAME COLUMN "+column+" TO stale_test_changed;",/ledger column .* differs/]),
    ["failure literal drift","ALTER TABLE public.patient_notification_native_push_deliveries DROP CONSTRAINT patient_native_push_failure_class_check;ALTER TABLE public.patient_notification_native_push_deliveries ADD CONSTRAINT patient_native_push_failure_class_check CHECK(last_failure_class IS NULL OR (status IN ('failed','disabled_token') AND last_failure_class IN ('permanent_device','confirmed_transient','non_ retryable','unknown_outcome')));",/failure_class_check differs/],
    ["direct writes","GRANT UPDATE ON public.patient_notification_native_push_deliveries TO service_role;",/privilege boundary differs/],
    ["updated trigger","ALTER TABLE public.patient_notification_native_push_deliveries DISABLE TRIGGER patient_native_push_deliveries_set_updated_at;",/updated_at trigger differs/],
  ];
  const baseline=read("supabase/migrations/20261003130000_patient_native_push_bounded_retries.sql");
  for(const name of ["claim_patient_native_push_delivery","finalize_patient_native_push_delivery","list_due_patient_native_push_deliveries"]){
    const start=baseline.indexOf("create function public."+name);const end=baseline.indexOf("$function$;",start)+"$function$;".length;
    const altered=baseline.slice(start,end).replace("create function","create or replace function").replace("as $function$","as $function$\n-- injected reviewed-body drift");
    driftCases.push([name,altered,/RPC .* differs/]);
  }
  for(const [label,setup,expected] of driftCases){
    const before=snapshot();const refused=spawnSync(docker,[...execArgs,...args],{cwd,encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:100000,
      input:"BEGIN;"+reset+setup+"\n\\ir "+directory+"/"+staleMigrationPath+"\n"});
    assert.equal(refused.error,undefined);assert.notEqual(refused.status,0);assert.match(refused.stderr,expected);
    assert.equal(snapshot(),before,label+" preflight must roll back all schema/function/cron/data changes");
  }
  console.log("PASS: actual full-migration preflight rollback cases="+driftCases.length+".");
  const scheduler=read(staleMigrationPath).slice(read(staleMigrationPath).indexOf("do $scheduler$"),read(staleMigrationPath).indexOf("$scheduler$;")+"$scheduler$;".length);
  assert.equal(run("BEGIN;SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='patient-native-push-stale-recovery';"
    + "ALTER FUNCTION cron.alter_job(bigint,text,text,text,text,boolean) RENAME TO stale_test_alter_job;"+scheduler
    + "SELECT 'fallback:'||count(*) FROM cron.job WHERE jobname='patient-native-push-stale-recovery';ROLLBACK;").split("\n").at(-1),"fallback:0");
  console.log("PASS: actual scheduler block with inactive capability unavailable installs no job; fixture rolled back.");
  assert.equal(run("SELECT count(*) FROM cron.job WHERE jobname='patient-native-push-stale-recovery' AND active;"),"0");
  assert.equal(run("BEGIN;"+"DO $activate$\nDECLARE v_job record;\nBEGIN\n  SELECT * INTO STRICT v_job FROM cron.job WHERE jobname='patient-native-push-stale-recovery';\n  IF v_job.database<>current_database() OR v_job.username<>current_user OR v_job.active\n     OR v_job.schedule<>'* * * * *'\n     OR v_job.command<>'select public.recover_stale_patient_native_push_deliveries();' THEN\n    RAISE EXCEPTION 'Recovery cron configuration differs from reviewed inactive job.';\n  END IF;\n  PERFORM cron.alter_job(v_job.jobid,active:=true);\nEND;\n$activate$;"+"SELECT 'activation:'||active FROM cron.job WHERE jobname='patient-native-push-stale-recovery';ROLLBACK;").split("\n").at(-1),"activation:true");
  console.log("PASS: documented guarded activation works on real pg_cron inside a rolled-back test transaction.");
  // Production-like capability check: the caller owns jobs but is NOT a superuser.
  const cronRole="stale_test_cron_caller";
  run("SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='patient-native-push-stale-recovery';"
    + "CREATE ROLE "+cronRole+" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"
    + "GRANT USAGE ON SCHEMA cron TO "+cronRole+";GRANT SELECT ON cron.job TO "+cronRole+";"
    + "GRANT EXECUTE ON FUNCTION cron.schedule(text,text,text),cron.alter_job(bigint,text,text,text,text,boolean) TO "+cronRole+";");
  const caller=await open();
  try {
    caller.send("BEGIN;SET LOCAL ROLE "+cronRole+";"
      + "SELECT 'restricted:'||(NOT rolsuper) FROM pg_roles WHERE rolname=current_user;");
    await caller.waitFor("restricted:true");
    caller.send(scheduler+"SELECT 'owner:'||username||':'||jobid FROM cron.job WHERE jobname='patient-native-push-stale-recovery';");
    const owner=await caller.waitFor(/^owner:stale_test_cron_caller:\d+$/);
    const jobId=Number(owner.split(":")[2]);
    assert.equal(run("SELECT count(*) FROM cron.job WHERE jobname='patient-native-push-stale-recovery';"),"0",
      "An independent session must not see an uncommitted active job");
    await commit(caller,"RESTRICTED_SCHEDULER_COMMITTED");
    assert.equal(run("SELECT count(*) FROM cron.job WHERE jobid="+jobId+" AND jobname='patient-native-push-stale-recovery'"
      + " AND NOT active AND username='"+cronRole+"' AND database=current_database() AND schedule='* * * * *'"
      + " AND command='select public.recover_stale_patient_native_push_deliveries();';"),"1");
    assert.equal(run("SELECT count(*) FROM cron.job WHERE jobname='patient-native-push-stale-recovery' AND active;"),"0");
    // Exercise the documented activation guard as that same owner, then roll back.
    caller.send("BEGIN;SET LOCAL ROLE "+cronRole+";DO $activate$ DECLARE v_job record; BEGIN "
      + "SELECT * INTO STRICT v_job FROM cron.job WHERE jobname='patient-native-push-stale-recovery';"
      + "IF v_job.username<>current_user OR v_job.active THEN RAISE EXCEPTION 'Unexpected scheduler owner/state'; END IF;"
      + "PERFORM cron.alter_job(v_job.jobid,active:=true);END $activate$;"
      + "SELECT 'restricted_activation:'||active FROM cron.job WHERE jobid="+jobId+";ROLLBACK;");
    await caller.waitFor("restricted_activation:true");
    await caller.finish();
    assert.equal(run("SELECT count(*) FROM cron.job WHERE jobid="+jobId+" AND NOT active AND username='"+cronRole+"';"),"1");
  } finally {
    await caller.stop();
  }
  console.log("PASS: non-superuser scheduler creates and commits an inactive job with unchanged caller ownership; independent observer sees no active job; owner activation rolled back.");
  console.log("REAL POSTGRES SUMMARY: serial assertions="+summary[1]+"; overlapping concurrency scenarios=9; preflight rollback cases="+driftCases.length+"; scheduler fallback cases=1; non-superuser scheduler cases=1; unexpected failures=0.");
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    verifyStaleRecoverySql();console.log("PASS: Phase 8C static safety and pinned Phase 8B compatibility.");
    const focused=spawnSync(process.execPath,[fileURLToPath(new URL("scripts/verify-patient-native-push-lifecycle.mjs",root)),"--recovery"],
      {cwd:fileURLToPath(root),encoding:"utf8",windowsHide:true,timeout:30000,maxBuffer:100000});
    assert.equal(focused.status,0,"Focused actual-helper/fault-model tests must pass.");console.log(focused.stdout.trim());
    if(process.argv.includes("--postgres"))await realPostgres();
    else console.log("REAL POSTGRES: NOT EXECUTED; use --postgres with the dedicated disposable container.");
  }catch(error){console.error("STALE RECOVERY VERIFICATION FAILURE: "+error.message);process.exitCode=1;}
}
