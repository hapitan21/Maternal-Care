// Included by scripts/verify-patient-native-push-lifecycle.mjs without Deno or network.
// Direct Deno execution also runs the desired contracts; the known defect stays red.
// Firebase's invalid-registration example: https://firebase.google.com/docs/cloud-messaging/error-codes
import assert from "node:assert/strict";
import { sendFirebaseMessage } from "./firebaseMessaging.ts";

type TestCase = {
  name: string;
  expectedFailure?: string;
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
  expectedFailure?: string,
): TestCase {
  return {
    name,
    expectedFailure,
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
    message: "The registration token is not a valid FCM registration token",
    details: [fcmDetail("INVALID_ARGUMENT")],
  }, true, "Firebase parser misses the documented FcmError token response"),
  classificationCase("generic INVALID_ARGUMENT is not permanent", 400,
    { status: "INVALID_ARGUMENT" }, false),
  classificationCase("payload field violation is not permanent", 400, {
    status: "INVALID_ARGUMENT",
    details: [{
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ field: "message.data[0].value", description: "Invalid content value" }],
    }],
  }, false),
  classificationCase("FCM-specific INVALID_ARGUMENT without token evidence is not permanent", 400,
    { status: "INVALID_ARGUMENT", details: [fcmDetail("INVALID_ARGUMENT")] }, false),
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

if (typeof Deno !== "undefined") {
  for (const test of firebaseLifecycleTests) Deno.test(test.name, test.run);
}
