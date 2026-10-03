// Included by scripts/verify-patient-native-push-lifecycle.mjs without Deno or network.
// Direct Deno execution also runs these normal passing contracts.
// Firebase's invalid-registration example: https://firebase.google.com/docs/cloud-messaging/error-codes
import assert from "node:assert/strict";
import { sendFirebaseMessage } from "./firebaseMessaging.ts";

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

type ErrorFixture = {
  status: string;
  message?: string;
  details?: unknown[];
};

const fcmDetail = (errorCode: string) => ({
  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  errorCode,
});

function classificationCase(
  name: string,
  httpStatus: number,
  error: ErrorFixture,
  permanent: boolean,
): TestCase {
  return {
    name,
    async run() {
      const originalFetch = globalThis.fetch;
      // Only a synthetic target and authorization are used; no credentials are loaded.
      globalThis.fetch = async () => new Response(JSON.stringify({ error }), {
        status: httpStatus,
        headers: { "content-type": "application/json" },
      });
      try {
        const result = await sendFirebaseMessage(
          { projectId: "synthetic-project", accessToken: "synthetic-authorization" },
          {
            token: "synthetic-registration-value",
            notificationId: "synthetic-notification",
            notificationType: "general",
            route: "/patient/dashboard",
          },
        );
        assert.equal(result.ok, false, "fixture must exercise an unsuccessful send");
        if (result.ok) throw new Error("unexpected successful fixture");
        assert.equal(result.httpStatus, httpStatus, "HTTP status must be preserved");
        assert.ok(result.permanentTokenFailure === permanent,
          "contract: " + name);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  };
}

function classificationGroup(name: string, cases: TestCase[]): TestCase {
  return { name, async run() { for (const test of cases) await test.run(); } };
}

const invalidRegistrationMessage =
  "The registration token is not a valid FCM registration token";

export const firebaseLifecycleTests: TestCase[] = [
  classificationCase("UNREGISTERED is permanent", 404,
    { status: "NOT_FOUND", details: [fcmDetail("UNREGISTERED")] }, true),
  classificationCase("token-specific BadRequest is permanent", 400, {
    status: "INVALID_ARGUMENT",
    details: [{
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ field: "message.token", description: "Invalid registration token" }],
    }],
  }, true),
  classificationCase("documented invalid-registration FcmError is permanent", 400, {
    status: "INVALID_ARGUMENT",
    message: invalidRegistrationMessage,
    details: [fcmDetail("INVALID_ARGUMENT")],
  }, true),
  classificationCase("generic INVALID_ARGUMENT is not permanent", 400,
    { status: "INVALID_ARGUMENT" }, false),
  classificationGroup("payload field violation is not permanent",
    ["message.notification.title", "message.notification.body", "message.data[0].value"]
      .map(field => classificationCase(field + " content error is not permanent", 400, {
        status: "INVALID_ARGUMENT",
        details: [{
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [{ field, description: "Invalid content value" }],
        }],
      }, false))),
  classificationGroup("FCM-specific INVALID_ARGUMENT without token evidence is not permanent", [
    classificationCase("typed code alone is not permanent", 400,
      { status: "INVALID_ARGUMENT", details: [fcmDetail("INVALID_ARGUMENT")] }, false),
    classificationCase("typed code with payload error message is not permanent", 400,
      { status: "INVALID_ARGUMENT", message: "Invalid notification content",
        details: [fcmDetail("INVALID_ARGUMENT")] }, false),
    classificationCase("documented message without typed FcmError is not permanent", 400,
      { status: "INVALID_ARGUMENT", message: invalidRegistrationMessage }, false),
    classificationCase("documented message with wrong detail type is not permanent", 400, {
      status: "INVALID_ARGUMENT", message: invalidRegistrationMessage,
      details: [{ "@type": "synthetic.unknown.Error", errorCode: "INVALID_ARGUMENT" }],
    }, false),
    classificationCase("documented message with sender error is not permanent", 400,
      { status: "INVALID_ARGUMENT", message: invalidRegistrationMessage,
        details: [fcmDetail("SENDER_ID_MISMATCH")] }, false),
    classificationCase("documented message in transient response is not permanent", 503,
      { status: "INVALID_ARGUMENT", message: invalidRegistrationMessage,
        details: [fcmDetail("INVALID_ARGUMENT")] }, false),
    classificationCase("documented message with inconsistent status is not permanent", 400,
      { status: "INTERNAL", message: invalidRegistrationMessage,
        details: [fcmDetail("INVALID_ARGUMENT")] }, false),
    classificationCase("documented message with conflicting payload violation is not permanent", 400, {
      status: "INVALID_ARGUMENT", message: invalidRegistrationMessage,
      details: [fcmDetail("INVALID_ARGUMENT"), {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [{ field: "message.notification.title", description: "Invalid content value" }],
      }],
    }, false),
  ]),
  classificationCase("unrelated message-token violation is not permanent", 400, {
    status: "INVALID_ARGUMENT",
    details: [{
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ field: "message.token", description: "Request validation failed" }],
    }],
  }, false),
  classificationCase("INTERNAL 500 is not permanent", 500,
    { status: "INTERNAL" }, false),
  classificationCase("UNAVAILABLE 503 is not permanent", 503,
    { status: "UNAVAILABLE" }, false),
  classificationCase("quota 429 is not permanent", 429,
    { status: "RESOURCE_EXHAUSTED", details: [fcmDetail("QUOTA_EXCEEDED")] }, false),
  classificationCase("authentication failure is not permanent", 401,
    { status: "UNAUTHENTICATED" }, false),
  classificationCase("sender mismatch is not permanent", 403,
    { status: "PERMISSION_DENIED", details: [fcmDetail("SENDER_ID_MISMATCH")] }, false),
  {
    name: "FCM data contains only opaque notification navigation metadata",
    async run() {
      const originalFetch = globalThis.fetch;
      let requestBody: Record<string, unknown> | undefined;
      globalThis.fetch = async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ name: "synthetic-provider-message" }), { status: 200 });
      };
      try {
        const target = "synthetic-registration-value";
        const result = await sendFirebaseMessage(
          { projectId: "synthetic-project", accessToken: "synthetic-authorization" },
          { token: target, notificationId: "synthetic-notification",
            notificationType: "general", route: "/patient/dashboard" },
        );
        assert.equal(result.ok, true);
        const message = requestBody?.message as Record<string, unknown>;
        assert.equal(message.token, target, "registration is only the transport recipient");
        const data = message.data as Record<string, unknown>;
        assert.deepEqual(Object.keys(data).sort(), ["notification_id", "notification_type", "route"]);
        assert.equal(JSON.stringify(data).includes(target), false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "unknown network outcome is not permanent",
    async run() {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("synthetic network failure"); };
      try {
        const result = await sendFirebaseMessage(
          { projectId: "synthetic-project", accessToken: "synthetic-authorization" },
          { token: "synthetic-registration-value", notificationId: "synthetic-notification",
            notificationType: "general", route: "/patient/dashboard" },
        );
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("unexpected successful fixture");
        assert.equal(result.permanentTokenFailure, false);
        assert.equal(result.errorCode, "FCM_OUTCOME_UNKNOWN");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];


// Phase 8B adds scheduling classification without changing permanent-token contracts.
async function withResponse(response: Response, check: (result: Awaited<ReturnType<typeof sendFirebaseMessage>>) => void) {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>response;
  try { check(await sendFirebaseMessage({projectId:"synthetic-project",accessToken:"synthetic-authorization"},
    {token:"synthetic-target",notificationId:"synthetic-notification",notificationType:"general",route:"/patient/dashboard"})); }
  finally { globalThis.fetch=originalFetch; }
}
const responseFor=(http: number, status?: string, headers: Record<string,string>={}, details: unknown[]=[])=>
  new Response(JSON.stringify(status ? {error:{code:http,status,details}} : {}),{status:http,headers});
for(const [http,status,category] of [
  [429,"RESOURCE_EXHAUSTED","confirmed_transient"], [500,"INTERNAL","confirmed_transient"],
  [503,"UNAVAILABLE","confirmed_transient"], [400,"INVALID_ARGUMENT","non_retryable"],
  [401,"UNAUTHENTICATED","non_retryable"], [403,"PERMISSION_DENIED","non_retryable"],
  [404,"NOT_FOUND","non_retryable"], [409,"ABORTED","non_retryable"],
  [502,undefined,"unknown_outcome"], [504,undefined,"unknown_outcome"],
  [500,undefined,"unknown_outcome"], [503,"INTERNAL","unknown_outcome"],
] as const) firebaseLifecycleTests.push({name:"Phase 8B HTTP "+http+"/"+(status||"unstructured")+" classification",run:()=>
  withResponse(responseFor(http,status),result=>{assert.equal(result.ok,false);if(result.ok)return;
    assert.equal(result.failureClass,category);assert.equal(result.permanentTokenFailure,false);})});
for(const http of [500,503]) firebaseLifecycleTests.push({name:"Phase 8B unreadable "+http+" body is unknown",run:()=>
  withResponse(new Response("not JSON",{status:http}),result=>{if(result.ok)throw Error("Unexpected success");
    assert.equal(result.failureClass,"unknown_outcome");assert.equal(result.retryAfterMs,null);})});
firebaseLifecycleTests.push({name:"Phase 8B conflicting transient HTTP code is unknown",run:()=>
  withResponse(new Response(JSON.stringify({error:{code:500,status:"UNAVAILABLE"}}),{status:503}),result=>{
    if(result.ok)throw Error("Unexpected success");assert.equal(result.failureClass,"unknown_outcome");})});
firebaseLifecycleTests.push({name:"Phase 8B successful status with unreadable body remains accepted",run:()=>
  withResponse(new Response("not JSON",{status:200}),result=>{assert.equal(result.ok,true);if(result.ok)assert.equal(result.providerMessageId,null);})});
for(const [name,header,details,expected] of [
  ["numeric header","120",[],120000], ["typed RetryInfo",null,[{"@type":"type.googleapis.com/google.rpc.RetryInfo",retryDelay:"150.5s"}],150500],
  ["longest delay wins","90",[{"@type":"type.googleapis.com/google.rpc.RetryInfo",retryDelay:"180s"}],180000],
  ["wrong RetryInfo type ignored",null,[{"@type":"synthetic.RetryInfo",retryDelay:"150s"}],null],
  ["negative delay ignored","-1",[{"@type":"type.googleapis.com/google.rpc.RetryInfo",retryDelay:"-10s"}],null],
  ["oversized valid delay terminates scheduling","999999999999999999999999999",[],1800000],
  ["malformed header ignored","tomorrow",[],null],
] as const) firebaseLifecycleTests.push({name:"Phase 8B Retry-After "+name,run:()=>
  withResponse(responseFor(429,"RESOURCE_EXHAUSTED",header?{"retry-after":header}:{},[...details]),result=>{
    if(result.ok)throw Error("Unexpected success");assert.equal(result.retryAfterMs,expected);assert.equal(result.failureClass,"confirmed_transient");})});
firebaseLifecycleTests.push({name:"Phase 8B payload rejection ignores retry hints",run:()=>
  withResponse(responseFor(400,"INVALID_ARGUMENT",{"retry-after":"60"}),result=>{
    if(result.ok)throw Error("Unexpected success");assert.equal(result.failureClass,"non_retryable");assert.equal(result.retryAfterMs,null);})});
firebaseLifecycleTests.push({name:"Phase 8B fetch exception is unknown and contains no provider raw detail",run:async()=>{
  const original=globalThis.fetch;globalThis.fetch=async()=>{throw new TypeError("synthetic-private-body");};
  try{const result=await sendFirebaseMessage({projectId:"synthetic-project",accessToken:"synthetic-authorization"},
    {token:"synthetic-target",notificationId:"synthetic-notification",notificationType:"general",route:"/patient/dashboard"});
    if(result.ok)throw Error("Unexpected success");assert.equal(result.failureClass,"unknown_outcome");
    assert.equal(result.retryAfterMs,null);assert.equal(JSON.stringify(result).includes("synthetic-private-body"),false);
  }finally{globalThis.fetch=original;}
}});
for(const http of [200,503]) firebaseLifecycleTests.push({name:"Phase 8B response-body deadline settles hung HTTP "+http,run:async()=>{
  const savedTimeout=globalThis.setTimeout,savedClear=globalThis.clearTimeout;
  globalThis.setTimeout=((callback: ()=>void)=>{(async()=>{for(let i=0;i<64;i++)await Promise.resolve();callback();})();return 1;}) as typeof setTimeout;
  globalThis.clearTimeout=(()=>{}) as typeof clearTimeout;
  const response=new Response(null,{status:http});response.json=()=>new Promise(()=>{});
  try{await withResponse(response,result=>{
    assert.equal(result.ok,http===200);
    if(!result.ok)assert.equal(result.failureClass,"unknown_outcome");
  });}finally{globalThis.setTimeout=savedTimeout;globalThis.clearTimeout=savedClear;}
}});

// Malformed/contradictory 5xx evidence must never authorize automatic replay.
const unrelatedDetail = { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" };
for (const [name, http, status, details, expected] of [
  ["conflicting INTERNAL last", 500, "INTERNAL", [fcmDetail("INVALID_ARGUMENT"), fcmDetail("INTERNAL")], "unknown_outcome"],
  ["conflicting INTERNAL first", 500, "INTERNAL", [fcmDetail("INTERNAL"), fcmDetail("INVALID_ARGUMENT")], "unknown_outcome"],
  ["details object", 503, "UNAVAILABLE", {}, "unknown_outcome"],
  ["details string", 503, "UNAVAILABLE", "UNAVAILABLE", "unknown_outcome"],
  ["details null", 503, "UNAVAILABLE", null, "unknown_outcome"],
  ["numeric typed code", 503, "UNAVAILABLE", [{ ...fcmDetail("UNAVAILABLE"), errorCode: 503 }], "unknown_outcome"],
  ["null typed code", 503, "UNAVAILABLE", [{ ...fcmDetail("UNAVAILABLE"), errorCode: null }], "unknown_outcome"],
  ["empty typed code", 503, "UNAVAILABLE", [fcmDetail("")], "unknown_outcome"],
  ["missing typed code", 503, "UNAVAILABLE", [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError" }], "unknown_outcome"],
  ["null detail entry", 500, "INTERNAL", [null, fcmDetail("INTERNAL")], "unknown_outcome"],
  ["primitive detail entry", 500, "INTERNAL", [fcmDetail("INTERNAL"), 500], "unknown_outcome"],
  ["untyped detail entry", 503, "UNAVAILABLE", [{ retryDelay: "90s" }, fcmDetail("UNAVAILABLE")], "unknown_outcome"],
  ["invalid detail type", 503, "UNAVAILABLE", [{ "@type": 123 }, fcmDetail("UNAVAILABLE")], "unknown_outcome"],
  ["valid typed INTERNAL", 500, "INTERNAL", [fcmDetail("INTERNAL")], "confirmed_transient"],
  ["valid typed UNAVAILABLE", 503, "UNAVAILABLE", [fcmDetail("UNAVAILABLE")], "confirmed_transient"],
  ["identical typed duplicates", 500, "INTERNAL", [fcmDetail("INTERNAL"), fcmDetail("INTERNAL")], "confirmed_transient"],
  ["unrelated typed detail first", 503, "UNAVAILABLE", [unrelatedDetail, fcmDetail("UNAVAILABLE")], "confirmed_transient"],
  ["unrelated typed detail last", 503, "UNAVAILABLE", [fcmDetail("UNAVAILABLE"), unrelatedDetail], "confirmed_transient"],
  ["top-level INTERNAL conflicts with typed UNAVAILABLE", 500, "INTERNAL", [fcmDetail("UNAVAILABLE")], "unknown_outcome"],
  ["top-level UNAVAILABLE conflicts with typed INTERNAL", 503, "UNAVAILABLE", [fcmDetail("INTERNAL")], "unknown_outcome"],
  ["BadRequest first", 500, "INTERNAL", [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }, fcmDetail("INTERNAL")], "unknown_outcome"],
  ["BadRequest last", 500, "INTERNAL", [fcmDetail("INTERNAL"), { "@type": "type.googleapis.com/google.rpc.BadRequest" }], "unknown_outcome"],
] as const) firebaseLifecycleTests.push({
  name: "Phase 8B complete 5xx evidence: " + name,
  run: () => withResponse(new Response(JSON.stringify({ error: { code: http, status, details } }),
    { status: http, headers: { "retry-after": "90" } }), result => {
    if (result.ok) throw Error("Unexpected success");
    assert.equal(result.failureClass, expected);
    assert.equal(result.permanentTokenFailure, false);
    assert.equal(result.retryAfterMs, expected === "confirmed_transient" ? 90000 : null);
  }),
});
for (const code of [null, "503", 500]) firebaseLifecycleTests.push({
  name: "Phase 8B malformed/conflicting top-level code " + String(code),
  run: () => withResponse(new Response(JSON.stringify({
    error: { code, status: "UNAVAILABLE", details: [fcmDetail("UNAVAILABLE")] },
  }), { status: 503 }), result => {
    if (result.ok) throw Error("Unexpected success");
    assert.equal(result.failureClass, "unknown_outcome");
  }),
});
firebaseLifecycleTests.push({
  name: "Phase 8B malformed top-level message is unknown",
  run: () => withResponse(new Response(JSON.stringify({
    error: { code: 503, status: "UNAVAILABLE", message: {}, details: [fcmDetail("UNAVAILABLE")] },
  }), { status: 503 }), result => {
    if (result.ok) throw Error("Unexpected success");
    assert.equal(result.failureClass, "unknown_outcome");
  }),
});

const retryClock = Date.UTC(2026, 9, 3);
for (const [name, header, retryInfo, expected] of [
  ["IMF-fixdate", "Sat, 03 Oct 2026 00:05:00 GMT", null, 300000],
  ["RFC 850", "Saturday, 03-Oct-26 00:05:00 GMT", null, 300000],
  ["asctime", "Sat Oct  3 00:05:00 2026", null, 300000],
  ["asctime two-digit day", "Sat Oct 03 00:05:00 2026", null, 300000],
  ["past IMF date", "Fri, 02 Oct 2026 00:00:00 GMT", null, 0],
  ["past RFC 850 date", "Friday, 02-Oct-26 00:00:00 GMT", null, 0],
  ["past asctime date", "Fri Oct  2 00:00:00 2026", null, 0],
  ["RFC 850 century rule", "Sunday, 06-Nov-94 08:49:37 GMT", null, 0],
  ["malformed date", "Sat 03 Oct 2026 00:05:00 GMT", null, null],
  ["impossible calendar date", "Mon, 30 Feb 2026 00:05:00 GMT", null, null],
  ["impossible RFC 850 date", "Monday, 30-Feb-26 00:05:00 GMT", null, null],
  ["impossible asctime date", "Mon Feb 30 00:05:00 2026", null, null],
  ["invalid hour", "Sat, 03 Oct 2026 24:05:00 GMT", null, null],
  ["invalid minute", "Sat, 03 Oct 2026 00:60:00 GMT", null, null],
  ["invalid month", "Sat, 03 Xxx 2026 00:05:00 GMT", null, null],
  ["invalid year", "Sat, 03 Oct 0000 00:05:00 GMT", null, null],
  ["inconsistent weekday", "Sun, 03 Oct 2026 00:05:00 GMT", null, null],
  ["HTTP leap second", "Sat, 03 Oct 2026 00:04:60 GMT", null, 300000],
  ["future delay beyond retry window", "Sat, 03 Oct 2026 01:00:00 GMT", null, 1800000],
  ["RetryInfo longer than HTTP date", "Saturday, 03-Oct-26 00:05:00 GMT", "420s", 420000],
  ["HTTP date longer than RetryInfo", "Sat Oct  3 00:05:00 2026", "90s", 300000],
] as const) firebaseLifecycleTests.push({
  name: "Phase 8B deterministic Retry-After " + name,
  async run() {
    const savedNow = Date.now, savedParse = Date.parse;
    Date.now = () => retryClock;
    Date.parse = () => { throw Error("HTTP-date parser must not use Date.parse"); };
    try {
      await withResponse(responseFor(429, "RESOURCE_EXHAUSTED", { "retry-after": header },
        retryInfo ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retryInfo }] : []), result => {
        if (result.ok) throw Error("Unexpected success");
        assert.equal(result.retryAfterMs, expected);
      });
    } finally {
      Date.now = savedNow;
      Date.parse = savedParse;
    }
  },
});

if (typeof Deno !== "undefined") {
  for (const test of firebaseLifecycleTests) Deno.test(test.name, test.run);
}
