// Isolated actual delivery helper + source-bound SQL model; not PostgreSQL concurrency.
import assert from "node:assert/strict";
import type { FirebaseSendResult } from "./firebaseMessaging.ts";
import { deliverPatientNativePushDevice, type NativeDeliveryStore, type DeliveryClaim, type Finalization, type FinalizationArguments } from "./patientNativePushDelivery.ts";
import { createDeliveryLedger, verifyRetrySql } from "../../../scripts/verify-patient-native-push-retry-sql.mjs";
import { recoverStaleLedger, verifyStaleRecoverySql } from "../../../scripts/verify-patient-native-push-stale-recovery.mjs";

const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const success = { ok: true as const, httpStatus: 200, providerMessageId: "synthetic-message" };
const transient = { ok: false as const, httpStatus: 503, errorCode: "UNAVAILABLE", errorMessage: "safe",
  permanentTokenFailure: false, failureClass: "confirmed_transient" as const, retryAfterMs: null };
const permanent = { ...transient, httpStatus: 404, errorCode: "UNREGISTERED", permanentTokenFailure: true, failureClass: "permanent_device" as const };
function fixture() {
  let now = Date.parse("2026-10-03T00:00:00Z");
  const notification = { id: uuid(1), patient_id: uuid(3), type: "general", route: "/patient/dashboard" };
  const device = { id: uuid(2), patient_id: uuid(3), platform: "android", enabled: true,
    push_token: "synthetic-sensitive-target", updated_at: new Date(now).toISOString() };
  const model = createDeliveryLedger({ notifications: new Map([[notification.id, notification]]), devices: new Map([[device.id, device]]), now: () => now });
  const sends: unknown[] = [], records: FinalizationArguments[] = [], waits: number[] = [], logs: string[] = [];
  let outcome: FirebaseSendResult = success;
  let failures = 0, nonTransient = false, throws = false;
  const options = {
    authorization: { projectId: "synthetic-project", accessToken: "synthetic-server-authorization" }, notification, device,
    mode: "notification" as "notification" | "retry",
    send: async () => { sends.push(outcome); if (throws) throw new TypeError("synthetic transport detail"); return outcome; },
    wait: async (milliseconds: number) => { waits.push(milliseconds); },
    log: (event: string) => logs.push(event),
    store: {
      claim: async (n: string, d: string, mode: "notification" | "retry") => ({ data: model.claim(n, d, mode) as DeliveryClaim | null, error: null }),
      finalize: async (args: FinalizationArguments) => {
        records.push({ ...args });
        if (failures-- > 0) return { data: null, error: { code: nonTransient ? "42501" : "08006" } };
        return { data: model.finalize(args) as Finalization, error: null };
      },
    } satisfies NativeDeliveryStore,
  };
  return { model, device, notification, options, sends, records, waits, logs,
    setOutcome(value: FirebaseSendResult) { outcome = value; }, failRecording(count: number, permanentError = false) { failures = count; nonTransient = permanentError; },
    throwSend() { throws = true; }, advance(ms: number) { now += ms; }, row() { return [...model.rows.values()][0]; },
    send: () => deliverPatientNativePushDevice(options), retry() { options.mode = "retry"; return deliverPatientNativePushDevice(options); } };
}
const tests: Array<{name: string; run: () => Promise<void>}> = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });
test("retry SQL model is explicitly bound to guarded source", async () => { verifyRetrySql(); });
test("delivery initial claim is attempt one and successful finalization", async () => {
  const h = fixture(); assert.equal((await h.send()).result, "sent");
  assert.equal(h.row().attempt_count, 1); assert.equal(h.sends.length, 1);
});
for (const state of ["processing", "sent", "failed", "disabled_token"]) test("webhook never retries existing " + state, async () => {
  const h = fixture(); h.model.claim(h.notification.id,h.device.id,"notification"); h.row().status=state;
  h.row().last_failure_class="confirmed_transient"; h.row().next_attempt_at="2026-10-02T23:59:59Z";
  assert.equal((await h.send()).result,"skipped"); assert.equal(h.sends.length,0);
});
for (const state of ["processing", "sent", "disabled_token"]) test("retry mode skips " + state, async () => {
  const h=fixture(); h.model.claim(h.notification.id,h.device.id,"notification"); h.row().status=state;
  assert.equal((await h.retry()).result,"skipped"); assert.equal(h.sends.length,0);
});
for (const category of ["unknown_outcome","non_retryable",null]) test("retry refuses failure class " + category, async () => {
  const h=fixture(); h.model.claim(h.notification.id,h.device.id,"notification"); h.row().status="failed";
  h.row().last_failure_class=category; h.row().next_attempt_at="2026-10-02T23:59:59Z";
  assert.equal((await h.retry()).result,"skipped");
});
test("retry cannot insert a missing delivery", async () => { const h=fixture(); assert.equal((await h.retry()).result,"skipped"); assert.equal(h.model.rows.size,0); });
test("retry before due does not send or increment", async () => {
  const h=fixture(); h.setOutcome(transient); await h.send(); await h.retry();
  assert.equal(h.sends.length,1); assert.equal(h.row().attempt_count,1);
});
test("due retry rotates fence, increments once, preserves creation and clears every result", async () => {
  const h=fixture(); h.setOutcome(transient); await h.send(); const old={...h.row()}; h.advance(61000);
  const claim=h.model.claim(h.notification.id,h.device.id,"retry");
  assert.ok(claim);
  assert.equal(claim.attempt_count,2); assert.notEqual(claim.claim_token,old.claim_token); assert.equal(h.row().created_at,old.created_at);
  for(const field of ["last_failure_class","next_attempt_at","fcm_http_status","error_code","error_message","provider_message_id","sent_at"]) assert.equal(h.row()[field],null);
});
test("competing model initial claims give one winner (not a PostgreSQL concurrency proof)", async () => {
  const h=fixture(); const results=await Promise.all([h.send(),h.send()]);
  assert.equal(results.filter(value=>value.attempted).length,1); assert.equal(h.sends.length,1);
});
test("competing model retries give one winner (not a PostgreSQL concurrency proof)", async () => {
  const h=fixture(); h.setOutcome(transient); await h.send(); h.advance(61000); h.setOutcome(success);
  await Promise.all([h.retry(),h.retry()]); assert.equal(h.sends.length,2); assert.equal(h.row().attempt_count,2);
});
test("four total attempts exhaust scheduling without a fifth send", async () => {
  const h=fixture(); h.setOutcome(transient); await h.send();
  for(const delay of [61000,121000,241000]) { h.advance(delay); await h.retry(); }
  assert.equal(h.row().attempt_count,4); assert.equal(h.row().last_failure_class,"confirmed_transient");
  assert.equal(h.row().next_attempt_at,null); await h.retry(); assert.equal(h.sends.length,4);
});
test("thirty-minute expiry refuses retry", async () => {
  const h=fixture(); h.setOutcome(transient); await h.send(); h.advance(1800000); await h.retry(); assert.equal(h.sends.length,1);
});
test("long provider delay terminates scheduling", async () => {
  const h=fixture(); h.setOutcome({...transient,retryAfterMs:1800000}); await h.send(); assert.equal(h.row().next_attempt_at,null);
});
test("provider delay dominates local backoff", async () => {
  const h=fixture(); h.setOutcome({...transient,retryAfterMs:300000}); await h.send();
  assert.equal(Date.parse(h.row().next_attempt_at)-Date.parse(h.row().attempted_at),300000);
});
test("permanent failure disables only matching version", async () => {
  const h=fixture(); h.setOutcome(permanent); assert.equal((await h.send()).result,"disabled_token"); assert.equal(h.device.enabled,false); assert.equal(h.row().next_attempt_at,null);
});
test("changed registration is not disabled by older permanent outcome", async () => {
  const h=fixture(); const selected={...h.device}; h.options.device=selected; h.device.updated_at="2026-10-03T00:00:01Z";
  h.setOutcome(permanent); await h.send(); assert.equal(h.device.enabled,true); assert.equal(h.row().error_code,"DEVICE_DISABLE_FAILED");
});
test("cleanup failure is terminal without scheduling", async () => {
  const h=fixture(); h.model.setDisableFailure(true); h.setOutcome(permanent); await h.send();
  assert.equal(h.row().status,"failed"); assert.equal(h.device.enabled,true); assert.equal(h.row().next_attempt_at,null);
});
test("unknown send exception is terminal and never replayed", async () => {
  const h=fixture(); h.throwSend(); await h.send(); h.advance(61000); await h.retry();
  assert.equal(h.row().last_failure_class,"unknown_outcome"); assert.equal(h.row().next_attempt_at,null); assert.equal(h.sends.length,1);
});
test("temporary recording failure retries same result without resending FCM", async () => {
  const h=fixture(); h.failRecording(3); assert.equal((await h.send()).result,"sent");
  assert.equal(h.sends.length,1); assert.equal(h.records.length,4); assert.deepEqual(h.waits,[250,1000,2000]);
  for(const args of h.records) assert.deepEqual(args,h.records[0]);
});
test("exhausted recording retries leave processing and never resend", async () => {
  const h=fixture(); h.failRecording(10); await h.send(); assert.equal(h.sends.length,1); assert.equal(h.records.length,4);
  assert.equal(h.row().status,"processing"); assert.deepEqual(h.logs,["finalization_exhausted"]);
});
test("recording authorization error does not spin through transport retries", async () => {
  const h=fixture(); h.failRecording(10,true); await h.send(); assert.equal(h.records.length,1); assert.equal(h.waits.length,0);
});
test("committed finalization with lost response is safely acknowledged", async () => {
  const h=fixture(); const original=h.options.store.finalize; let calls=0;
  h.options.store.finalize=async args=> { const response=await original(args); if(!calls++) return {data:null,error:{code:"08006"}}; return response; };
  assert.equal((await h.send()).result,"sent"); assert.equal(h.sends.length,1); assert.equal(h.row().attempt_count,1);
});
test("old claim cannot finalize or disable after a new claim", async () => {
  const h=fixture(); h.setOutcome(transient); await h.send(); const old=h.records[0]; h.advance(61000);
  h.model.claim(h.notification.id,h.device.id,"retry");
  const result=h.model.finalize({...old,p_failure_class:"permanent_device",p_http_status:404,p_error_code:"UNREGISTERED"});
  assert.equal(result.result,"stale_claim"); assert.equal(h.device.enabled,true); assert.equal(h.row().status,"processing");
});
test("identical terminal finalization does not repeat cleanup or mutate success", async () => {
  const h=fixture(); await h.send(); const before=JSON.stringify(h.row());
  const result=h.model.finalize({...h.records[0],p_failure_class:"permanent_device"});
  assert.equal(result.result,"already_finalized"); assert.equal(JSON.stringify(h.row()),before); assert.equal(h.device.enabled,true);
});
for(const change of ["disabled","owner","platform"]) test("retry blocks changed device " + change, async () => {
  const h=fixture(); h.setOutcome(transient); await h.send(); h.advance(61000);
  if(change==="disabled") h.device.enabled=false;
  if(change==="owner") h.device.patient_id=uuid(9);
  if(change==="platform") h.device.platform="ios";
  await h.retry(); assert.equal(h.sends.length,1); assert.equal(h.model.due().length,0);
});
test("historical failed and processing rows are never promoted", async () => {
  const h=fixture(); h.model.claim(h.notification.id,h.device.id,"notification"); Object.assign(h.row(),{claim_token:null,status:"failed",last_failure_class:null,next_attempt_at:null});
  const before=JSON.stringify(h.row()); await h.retry(); await h.send(); assert.equal(JSON.stringify(h.row()),before);
  h.row().status="processing"; const active=JSON.stringify(h.row()); h.advance(3600000); await h.retry(); assert.equal(JSON.stringify(h.row()),active);
});
test("operational logs contain no recipient, claim token, authorization or provider body", async () => {
  const h=fixture(); h.failRecording(10); await h.send(); const text=JSON.stringify(h.logs);
  for(const value of [h.device.push_token,h.row().claim_token,h.options.authorization.accessToken,"synthetic transport detail"]) assert.equal(text.includes(value),false);
});

test("Phase 8C source protects terminal recovery and unchanged Phase 8B",async()=>{verifyStaleRecoverySql();});
for(const state of ["delivery_unknown"]) test("Phase 8C terminal row blocks webhook/retry/discovery",async()=>{
  const h=fixture();h.model.claim(h.notification.id,h.device.id,"notification");h.advance(600000);
  assert.equal(recoverStaleLedger(h.model,Date.parse("2026-10-03T00:00:00Z")+600000),1);
  assert.equal(h.row().status,state);await h.send();await h.retry();assert.equal(h.sends.length,0);assert.equal(h.model.due().length,0);
});
for(const provider of [success,transient,permanent]) test("Phase 8C late "+(provider.ok?"success":provider.failureClass)+" observes terminal recovery once",async()=>{
  const h=fixture();h.setOutcome(provider);const original=h.options.store.finalize;
  let calls=0;
  h.options.store.finalize=async args=>{
    calls++;h.advance(600000);recoverStaleLedger(h.model,Date.parse("2026-10-03T00:00:00Z")+600000);
    return original(args);
  };
  const device=JSON.stringify(h.device);
  assert.deepEqual(await h.send(),{attempted:true,result:"skipped"});
  assert.equal(calls,1);assert.equal(h.sends.length,1);assert.equal(h.records.length,1);assert.equal(h.waits.length,0);
  assert.equal(h.row().status,"delivery_unknown");assert.equal(JSON.stringify(h.device),device);
  assert.deepEqual(h.logs,["delivery_unknown_acknowledged"]);
  await h.send();await h.retry();assert.equal(h.sends.length,1);assert.equal(calls,1);
  for(const value of [h.device.push_token,h.row().claim_token,h.options.authorization.accessToken,h.notification.id])assert.equal(JSON.stringify(h.logs).includes(value),false);
});
for(const scenario of ["claim committed crash","crash immediately before FCM","network timeout","FCM accepted finalization lost",
  "429 known only in memory","500 INTERNAL known only in memory","503 UNAVAILABLE known only in memory","success and persistent DB outage"])
  test("Phase 8C fault: "+scenario,async()=>{
    const h=fixture();const beforeSend=scenario.startsWith("claim")||scenario.startsWith("crash");
    if(beforeSend)h.model.claim(h.notification.id,h.device.id,"notification");
    else{
      h.failRecording(10);
      if(scenario==="network timeout")h.throwSend();
      if(scenario.startsWith("429"))h.setOutcome({...transient,httpStatus:429,errorCode:"QUOTA_EXCEEDED"});
      if(scenario.startsWith("500"))h.setOutcome({...transient,httpStatus:500,errorCode:"INTERNAL"});
      if(scenario.startsWith("503"))h.setOutcome(transient);
      await h.send();
    }
    assert.equal(h.row().status,"processing");const snapshot={...h.row()};const devices=JSON.stringify(h.device);
    h.advance(599000);assert.equal(recoverStaleLedger(h.model,Date.parse("2026-10-03T00:00:00Z")+599000),0);
    h.advance(1000);assert.equal(recoverStaleLedger(h.model,Date.parse("2026-10-03T00:00:00Z")+600000),1);
    for(const key of ["id","notification_id","device_id","attempt_count","claim_token","attempted_at","created_at","sent_at","fcm_http_status","error_code","error_message","provider_message_id","last_failure_class"])assert.equal(h.row()[key],snapshot[key]);
    assert.equal(h.row().status,"delivery_unknown");assert.equal(h.row().next_attempt_at,null);assert.equal(JSON.stringify(h.device),devices);
    assert.equal(recoverStaleLedger(h.model,Date.parse("2026-10-03T00:00:00Z")+1200000),0);
    await h.send();await h.retry();assert.equal(h.sends.length,beforeSend?0:1);assert.equal(h.row().attempt_count,1);assert.equal(h.model.due().length,0);
  });
test("Phase 8C temporary DB outage still finalizes known success without recovery",async()=>{
  const h=fixture();h.failRecording(3);assert.equal((await h.send()).result,"sent");h.advance(600000);
  assert.equal(recoverStaleLedger(h.model,Date.parse("2026-10-03T00:00:00Z")+600000),0);assert.equal(h.sends.length,1);
});

export const patientNativeDeliveryTests=tests;
if(typeof Deno!=="undefined") for(const entry of tests) Deno.test(entry.name,entry.run);
