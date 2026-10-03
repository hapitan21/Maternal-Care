import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPsqlSession } from "./verify-patient-native-push-retry-sql.mjs";

const root = new URL("../", import.meta.url);
export const appointmentMigrationPath = "supabase/migrations/20261003140000_appointment_reminder_reliability.sql";
export function verifyAppointmentReminderSql() {
  const sql = readFileSync(new URL(appointmentMigrationPath, root), "utf8");
  const baseline = readFileSync(new URL("supabase/tests/fixtures/appointment_reminder_deployed_baseline.sql", root), "utf8");
  const fallbackMarker = "  -- B. EXISTING AUTOMATIC FALLBACK";
  const extractFallback = source => source.slice(source.indexOf(fallbackMarker), source.indexOf("$function$;", source.indexOf(fallbackMarker)) + "$function$;".length);
  assert.equal(extractFallback(sql), extractFallback(baseline), "Entire deployed fallback body must remain byte-identical.");
  const notificationInsert = source => source.slice(source.indexOf("      insert into public.patient_notifications"), source.indexOf("      returning id into v_notification_id;") + "      returning id into v_notification_id;".length);
  assert.equal(notificationInsert(sql), notificationInsert(baseline), "Configured notification columns/copy/navigation must retain the deployed baseline.");
  for (const fragment of ["RETURNS TABLE(examined integer, claimed integer, notifications_created integer, skipped integer, failed integer)",
    "where public.appointment_reminder_dispatches.status = 'failed'", "appointment_reminder_dispatches_reminder_scheduled_key",
    "reminders_valid_status", "'expired'", "new.remind_at <= v_now", "new.remind_at > v_start - interval '10 minutes'",
    "new.next_trigger_at := new.remind_at", "for share nowait", "for update of reminder skip locked",
    "error_code = 'appointment_started_before_notification'", "when sqlstate 'P7501'", "clock_timestamp()",
    "while v_next_trigger <= v_delivery_now loop", "v_next_trigger >= v_candidate.repeat_until",
    "perform cron.alter_job(v_job.jobid, schedule := '* * * * *')", "if v_count <> 1 then"]) {
    assert.ok(sql.includes(fragment), "Missing reviewed SQL contract: " + fragment);
  }
  assert.equal((sql.match(/limit 200/gi) || []).length, 3, "Configured, runtime expiry and historical batches stay bounded.");
  assert.doesNotMatch(sql, /cron\.(schedule|unschedule)\s*\(|vault\.|patient_notification_native_push_deliveries|medication_reminders|create index|alter policy/i);
  const history = sql.slice(sql.indexOf("do $historical$"), sql.indexOf("-- Locate one exact existing identity"));
  assert.ok(history.includes("where dispatch.reminder_id = reminder.id"));
  assert.doesNotMatch(history, /insert into|sent_at\s*=|delete from/i);
  const timing = sql.slice(sql.indexOf("as $timing$"), sql.indexOf("$timing$;"));
  assert.doesNotMatch(timing, /old\.next_trigger_at|old\.sent_at|old\.status|repeat_mode|repeat_until/);
  assert.match(sql, /before insert or update of remind_at, schedule_id, reminder_type\non public\.reminders/);
  const preflight = sql.slice(sql.indexOf("do $preflight$"), sql.indexOf("$preflight$;"));
  assert.ok(preflight.includes("appointment_reminder_dispatches_status_check"));
  assert.ok(preflight.includes("v_states is distinct from v_contract.states"));
  assert.ok(preflight.includes("v_shape is distinct from v_contract.expression_shape"));
  return sql;
}

const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12,"0");
async function runRealPostgres() {
  const container = process.env.APPOINTMENT_REMINDER_TEST_CONTAINER;
  if (!/^maternal-reminder-reliability-[a-z0-9-]+$/.test(container || "")) {
    throw new Error("Set APPOINTMENT_REMINDER_TEST_CONTAINER to the explicitly disposable reminder-test container.");
  }
  const docker = process.env.APPOINTMENT_REMINDER_TEST_DOCKER || (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Programs/DockerDesktop/resources/bin/docker.exe") : "docker");
  const cwd = fileURLToPath(root);
  const dockerRun = (args, timeout = 20000) => {
    const result = spawnSync(docker, args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 150000 });
    if (result.error || result.status !== 0) throw new Error("Isolated Docker/psql command failed: " + (result.stderr || result.error?.message || "unknown error").slice(0,5000));
    return result.stdout.trim();
  };
  const metadata = JSON.parse(dockerRun(["inspect", container]))[0];
  assert.equal(metadata.Config.Image, "public.ecr.aws/supabase/postgres:17.6.1.104");
  assert.ok(metadata.Mounts.every(mount => mount.Type === "tmpfs"), "Refusing host/volume mounts in disposable fixture.");
  assert.equal(Object.keys(metadata.HostConfig.PortBindings || {}).length, 0, "Refusing a published host port.");
  const directory = "/tmp/reminder-reliability";
  dockerRun(["exec", container, "mkdir", "-p", directory + "/supabase/tests/fixtures", directory + "/supabase/migrations"]);
  for (const file of [appointmentMigrationPath, "supabase/tests/appointment_reminder_reliability_test.sql",
    "supabase/tests/fixtures/appointment_reminder_deployed_baseline.sql", "supabase/migrations/20260923140000_appointment_reminder_sms_bridge.sql"]) {
    dockerRun(["cp", fileURLToPath(new URL(file, root)), container + ":" + directory + "/" + file]);
  }
  const psqlArgs = ["--host=/var/run/postgresql", "--username=supabase_admin", "--dbname=maternal_appointment_reminder_test",
    "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--quiet"];
  const execArgs = ["exec", "-i", container, "psql"];
  const run = (sql, timeout = 10000) => dockerRun([...execArgs,...psqlArgs,"--command=" + sql],timeout);
  const serial = dockerRun([...execArgs,...psqlArgs,"--set=allow_isolated_test=true",
    "--file=" + directory + "/supabase/tests/appointment_reminder_reliability_test.sql"],30000);
  const count = /SQL_ASSERTIONS_PASSED=(\d+)/.exec(serial);
  assert.ok(count, "Serial fixture must reach its assertion summary.");
  console.log("PASS: real PostgreSQL serial contracts; assertions=" + count[1] + ". Real pg_cron metadata; offline SMS/native recorders.");
  const sessions = [], pids = [];
  const open = async () => {
    const session = createPsqlSession(psqlArgs, {
      cwd, env: process.env, timeoutMs: 30000,
      spawnProcess: (_command,args,options) => spawn(docker,[...execArgs,...args],options),
    });
    sessions.push(session);
    session.send("SELECT 'backend:' || pg_catalog.pg_backend_pid();");
    const marker = await session.waitFor(/^backend:\d+$/);
    pids.push(Number(marker.split(":")[1]));
    return session;
  };
  const reset = n => {
    run("UPDATE public.reminders SET status='cancelled' WHERE status='pending';"
      + "UPDATE public.schedule SET status='scheduled',start_time=clock_timestamp()+interval '20 minutes' WHERE id='" + uuid(n) + "';"
      + "UPDATE public.reminders SET status='pending',next_trigger_at=remind_at WHERE id='" + uuid(n) + "';");
  };
  const assertNoDelivery = n => assert.equal(run("SELECT NOT EXISTS(SELECT 1 FROM public.patient_notifications WHERE related_reminder_id='"
    + uuid(n) + "') AND NOT EXISTS(SELECT 1 FROM public.appointment_reminder_dispatches WHERE reminder_id='" + uuid(n) + "');"), "t");
  const proveLock = async (session,n,mode) => {
    session.send("DO $proof$ BEGIN BEGIN PERFORM 1 FROM public." + (mode === "reminder" ? "reminders" : "schedule")
      + " WHERE id='" + uuid(n) + "' FOR " + (mode === "reminder" ? "UPDATE" : "SHARE")
      + " NOWAIT; RAISE EXCEPTION 'Expected real row-lock conflict'; EXCEPTION WHEN lock_not_available THEN NULL; END; END $proof$;\n\\echo LOCK_PROVED");
    await session.waitFor("LOCK_PROVED");
  };
  let processSequence = 0;
  const runProcessor = async (session,expected) => {
    const sequence = ++processSequence;
    const prefix = "created:" + sequence + ":";
    const done = "PROCESS_DONE_" + sequence;
    session.send("SELECT '" + prefix + "' || notifications_created FROM public.process_due_appointment_reminders();\n\\echo " + done);
    assert.equal(await session.waitFor(new RegExp("^" + prefix + "\\d+$")), prefix + expected);
    await session.waitFor(done);
  };
  try {
    // A holds a REAL reminder row lock. B proves a NOWAIT conflict then invokes
    // the actual SKIP LOCKED processor while A's transaction remains open.
    reset(90);
    const a = await open(), b = await open();
    a.send("BEGIN; SELECT 1 FROM public.reminders WHERE id='" + uuid(90) + "' FOR UPDATE;\n\\echo A_HELD");
    await a.waitFor("A_HELD");
    await proveLock(b,90,"reminder");
    await runProcessor(b,0);
    await runProcessor(a,1);
    a.send("COMMIT;\n\\echo A_COMMITTED"); await a.waitFor("A_COMMITTED");
    assert.equal(run("SELECT count(*) FROM public.patient_notifications WHERE related_reminder_id='" + uuid(90) + "';"), "1");
    assert.equal(run("SELECT count(*) FROM net.test_calls WHERE body->>'reminder_id'='" + uuid(90) + "';"), "1");
    await a.finish(); await b.finish();
    console.log("PASS: two real PostgreSQL sessions overlap; reminder lock conflict proved; one delivery and SMS enqueue.");

    reset(91);
    run("UPDATE public.schedule SET start_time=clock_timestamp()-interval '1 second' WHERE id='" + uuid(91) + "';");
    const expireA = await open(), expireB = await open();
    expireA.send("BEGIN;"); await runProcessor(expireA,0);
    await proveLock(expireB,91,"reminder"); await runProcessor(expireB,0);
    expireA.send("COMMIT;\n\\echo EXPIRY_COMMITTED"); await expireA.waitFor("EXPIRY_COMMITTED");
    assert.equal(run("SELECT status FROM public.reminders WHERE id='" + uuid(91) + "';"), "expired");
    assertNoDelivery(91);
    await expireA.finish(); await expireB.finish();
    console.log("PASS: concurrent expiry wins without fabricated claim or notification.");

    reset(92);
    run("UPDATE public.schedule SET start_time=clock_timestamp()+interval '2 seconds' WHERE id='" + uuid(92) + "';");
    const deliverA = await open(), expireAfter = await open();
    deliverA.send("BEGIN;"); await runProcessor(deliverA,1);
    run("SELECT pg_sleep(2);",5000);
    await proveLock(expireAfter,92,"reminder"); await runProcessor(expireAfter,0);
    deliverA.send("COMMIT;\n\\echo DELIVERY_COMMITTED"); await deliverA.waitFor("DELIVERY_COMMITTED");
    assert.equal(run("SELECT status FROM public.reminders WHERE id='" + uuid(92) + "';"), "sent");
    assert.equal(run("SELECT count(*) FROM public.patient_notifications WHERE related_reminder_id='" + uuid(92) + "';"), "1");
    await deliverA.finish(); await expireAfter.finish();
    console.log("PASS: pre-cutoff delivery wins; concurrent post-cutoff reconciliation cannot overwrite its outcome.");

    for (const [n,state] of [[93,"cancelled"],[94,"completed"],[95,"rescheduled"]]) {
      reset(n);
      const changeA = await open(), processB = await open();
      changeA.send("BEGIN; UPDATE public.schedule SET status='" + state + "'"
        + (state === "rescheduled" ? ", start_time=clock_timestamp()-interval '1 second'" : "")
        + " WHERE id='" + uuid(n) + "';\n\\echo CHANGE_HELD");
      await changeA.waitFor("CHANGE_HELD");
      await proveLock(processB,n,"appointment"); await runProcessor(processB,0);
      changeA.send("COMMIT;\n\\echo CHANGE_COMMITTED"); await changeA.waitFor("CHANGE_COMMITTED");
      await runProcessor(processB,0); assertNoDelivery(n);
      if (state === "rescheduled") assert.equal(run("SELECT status FROM public.reminders WHERE id='" + uuid(n) + "';"),"expired");
      await changeA.finish(); await processB.finish();
      console.log("PASS: real concurrent " + state + " appointment change prevents stale delivery.");
    }
  } finally {
    // Docker CLI termination alone is not a promise that container psql died.
    // Explicitly terminate only PIDs opened by this runner in this dedicated DB.
    if (pids.length) run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='maternal_appointment_reminder_test'"
      + " AND pid=ANY(ARRAY[" + pids.join(",") + "]) AND pid<>pg_backend_pid();");
    await Promise.allSettled(sessions.map(session => session.stop()));
  }
  // Reconstruct the reviewed four-state baseline only inside rollback transactions.
  // The installed five-state contract is intentionally not accepted for reapplication.
  const reviewedStatusSetup = "UPDATE public.reminders SET status='cancelled' WHERE lower(status)='expired';"
    + "ALTER TABLE public.reminders DROP CONSTRAINT reminders_valid_status;"
    + "ALTER TABLE public.reminders ADD CONSTRAINT reminders_valid_status CHECK(lower(status) IN ('sent','pending','cancelled','completed'));";
  const snapshot = () => run("SELECT md5(jsonb_build_object("
    + "'functions',(SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY oid) FROM pg_proc WHERE oid IN ('public.process_due_appointment_reminders()'::regprocedure,'public.create_appointment_patient_reminder(uuid)'::regprocedure,'public.validate_appointment_reminder_timing()'::regprocedure)),"
    + "'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c WHERE conrelid IN ('public.reminders'::regclass,'public.appointment_reminder_dispatches'::regclass)),"
    + "'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY attrelid,attnum) FROM pg_attribute a WHERE attrelid IN ('public.reminders'::regclass,'public.appointment_reminder_dispatches'::regclass)),"
    + "'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgrelid IN ('public.reminders'::regclass,'public.appointment_reminder_dispatches'::regclass)),"
    + "'cron',(SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j),"
    + "'reminders',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.reminders r),"
    + "'dispatches',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.appointment_reminder_dispatches d))::text);");
  const refuse = (label,setup,expected) => {
    const before = snapshot();
    const refused = spawnSync(docker,[...execArgs,...psqlArgs],{
      cwd,windowsHide:true,encoding:"utf8",timeout:15000,maxBuffer:100000,
      input:"BEGIN; " + reviewedStatusSetup + setup + "\n\\ir " + directory + "/" + appointmentMigrationPath + "\n",
    });
    assert.equal(refused.error,undefined);
    assert.notEqual(refused.status,0,label + " must abort the actual migration");
    assert.match(refused.stderr,expected);
    assert.equal(snapshot(),before,label + ": function/schema/cron/data changes must all roll back");
    console.log("PASS: " + label + " fails safely; function/schema/cron/data snapshot unchanged after rollback.");
  };
  const remindersDrift = "ALTER TABLE public.reminders DROP CONSTRAINT reminders_valid_status;"
    + "ALTER TABLE public.reminders ADD CONSTRAINT reminders_valid_status CHECK(lower(status) IN ('pending','sent','completed','cancelled','unexpected'));";
  const dispatchDrop = "ALTER TABLE public.appointment_reminder_dispatches DROP CONSTRAINT appointment_reminder_dispatches_status_check;";
  for (const [label,setup,expected] of [
    ["drifted reminder states",remindersDrift,/status constraint reminders_valid_status differs from the reviewed contract/],
    ["reminder predicate drift","ALTER TABLE public.reminders DROP CONSTRAINT reminders_valid_status;ALTER TABLE public.reminders ADD CONSTRAINT reminders_valid_status CHECK(lower(status) IN ('pending','sent','completed','cancelled') OR status IS NOT NULL);",/status constraint reminders_valid_status differs from the reviewed contract/],
    ["missing dispatch constraint",dispatchDrop,/expected status constraint appointment_reminder_dispatches_status_check is missing/],
    ["extra dispatch state",dispatchDrop + "ALTER TABLE public.appointment_reminder_dispatches ADD CONSTRAINT appointment_reminder_dispatches_status_check CHECK(status IN ('processing','created','skipped','failed','unexpected'));",/status constraint appointment_reminder_dispatches_status_check differs from the reviewed contract/],
    ["dispatch lacks skipped","UPDATE public.appointment_reminder_dispatches SET status='failed' WHERE status='skipped';" + dispatchDrop + "ALTER TABLE public.appointment_reminder_dispatches ADD CONSTRAINT appointment_reminder_dispatches_status_check CHECK(status IN ('processing','created','failed'));",/status constraint appointment_reminder_dispatches_status_check differs from the reviewed contract/],
  ]) refuse(label,setup,expected);
  for (const [label,setup,expected] of [
    ["missing cron identity","SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='process-due-appointment-reminders';",/expected exactly one existing job/],
    ["duplicate cron identity","INSERT INTO cron.job(jobname,schedule,command,nodename,nodeport,database,username,active) SELECT jobname,schedule,command,nodename,nodeport,database,'service_role',active FROM cron.job WHERE jobname='process-due-appointment-reminders';",/expected exactly one existing job/],
    ["changed cron command","SELECT cron.alter_job(jobid, command := 'select 1;') FROM cron.job WHERE jobname='process-due-appointment-reminders';",/configuration differs from the reviewed job/],
  ]) refuse(label,setup,expected);
  console.log("REAL POSTGRES SUMMARY: serial assertions=" + count[1] + "; two-session race scenarios=6; status preflight rollback scenarios=5; cron rollback scenarios=3; unexpected failures=0.");

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyAppointmentReminderSql();
    console.log("PASS: deployed-baseline SQL/source contracts (not PostgreSQL execution).");
    if (process.argv.includes("--postgres")) await runRealPostgres();
    else console.log("REAL POSTGRES TESTS: NOT EXECUTED; use --postgres with the dedicated Docker fixture.");
  } catch (error) {
    console.error("REMINDER VERIFICATION FAILURE: " + error.message);
    process.exitCode=1;
  }
}
