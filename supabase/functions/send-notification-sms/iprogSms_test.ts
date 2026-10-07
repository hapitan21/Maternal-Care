import {
  IPROGSMS_MESSAGES_ENDPOINT,
  IprogSmsError,
  parseIprogSmsResponse,
  sendIprogSms,
} from "../_shared/iprogSms.ts";
import { normalizePhilippinePhoneNumber } from "../_shared/semaphoreSms.ts";

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Assertion failed");
}

const TOKEN = "synthetic-adapter-token";
const input = {
  phoneNumber: "639171234567",
  message: "Test appointment reminder",
};
const accepted = {
  status: 200,
  message: "SMS successfully queued for delivery.",
  message_id: "iSms-abc123",
  message_status_link: `https://example.test/status?api_token=${TOKEN}`,
  message_status_request_mode: "GET",
  sms_rate: 1,
};
const readEnvironment = (name: string) =>
  name === "IPROGSMS_API_TOKEN" ? TOKEN : undefined;

async function expectError(action: () => unknown, code: string) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof IprogSmsError);
    assert(error.publicCode === code && error.message === code);
    assert(!JSON.stringify(error).includes(TOKEN));
    return;
  }
  throw new Error("Expected a safe provider error");
}

Deno.test("iProgSMS request uses fixed endpoint, JSON and server environment token", async () => {
  const names: string[] = [];
  const result = await sendIprogSms(input, {
    readEnvironment: (name) => {
      names.push(name);
      return readEnvironment(name);
    },
    fetch: (url, options) => {
      assert(url === IPROGSMS_MESSAGES_ENDPOINT);
      assert(url === "https://www.iprogsms.com/api/v1/sms_messages");
      assert(options?.method === "POST");
      assert(
        new Headers(options.headers).get("content-type") === "application/json",
      );
      assert(
        JSON.stringify(JSON.parse(String(options.body))) === JSON.stringify({
          api_token: TOKEN,
          phone_number: input.phoneNumber,
          message: input.message,
        }),
      );
      return Promise.resolve(Response.json(accepted));
    },
  });
  assert(names.join() === "IPROGSMS_API_TOKEN");
  assert(result.messageId === "iSms-abc123");
  assert(
    result.dispatchStatus === "sent" && result.providerStatus === "queued",
  );
});

Deno.test("accepted status 200 discards receipt URL, raw text and pricing metadata", () => {
  const result = parseIprogSmsResponse(accepted);
  assert(
    JSON.stringify(result) === JSON.stringify({
      messageId: "iSms-abc123",
      providerStatus: "queued",
      dispatchStatus: "sent",
    }),
  );
  assert(!JSON.stringify(result).includes(TOKEN));
  assert(!("delivered_at" in result));
});

for (
  const messageId of [
    undefined,
    "",
    " ",
    123,
    "https://example.test/?api_token=x",
    "id\nsecret",
    "a".repeat(256),
  ]
) {
  Deno.test(`invalid iProgSMS message ID case ${String(messageId).length}`, async () => {
    await expectError(
      () => parseIprogSmsResponse({ status: 200, message_id: messageId }),
      "iprogsms_missing_message_id",
    );
  });
}
for (const status of [400, 500, "200", undefined]) {
  Deno.test(`non-200 provider body status ${String(status)} is safely rejected`, async () => {
    await expectError(
      () => parseIprogSmsResponse({ ...accepted, status, message: TOKEN }),
      "iprogsms_rejected",
    );
  });
}
for (const payload of [null, [], "text"]) {
  Deno.test(`non-object provider response ${JSON.stringify(payload)}`, async () => {
    await expectError(
      () => parseIprogSmsResponse(payload),
      "iprogsms_invalid_response",
    );
  });
}
for (const status of [401, 429, 500]) {
  Deno.test(`HTTP ${status} safely rejects provider text`, async () => {
    await expectError(() =>
      sendIprogSms(input, {
        readEnvironment,
        fetch: () => Promise.resolve(new Response(TOKEN, { status })),
      }), `iprogsms_http_${status}`);
  });
}

Deno.test("malformed JSON never exposes its body", async () => {
  await expectError(() =>
    sendIprogSms(input, {
      readEnvironment,
      fetch: () => Promise.resolve(new Response(`invalid:${TOKEN}`)),
    }), "iprogsms_invalid_json");
});

Deno.test("network errors are normalized without leaking provider details", async () => {
  await expectError(() =>
    sendIprogSms(input, {
      readEnvironment,
      fetch: () => Promise.reject(new Error(TOKEN)),
    }), "iprogsms_network_error");
});

Deno.test("request timeout maps safely and invokes transport exactly once", async () => {
  let calls = 0;
  await expectError(() =>
    sendIprogSms(input, {
      readEnvironment,
      timeoutMs: 1,
      fetch: (_url, options) => {
        calls++;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error(TOKEN)), { once: true });
        });
      },
    }), "iprogsms_timeout");
  assert(calls === 1);
});

Deno.test("timeout also covers a stalled response body", async () => {
  await expectError(() =>
    sendIprogSms(input, {
      readEnvironment,
      timeoutMs: 1,
      fetch: (_url, options) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                options?.signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error(TOKEN)),
                  { once: true },
                );
              },
            }),
          ),
        ),
    }), "iprogsms_timeout");
});

Deno.test("missing server token never invokes provider", async () => {
  let calls = 0;
  await expectError(() =>
    sendIprogSms(input, {
      readEnvironment: () => undefined,
      fetch: () => {
        calls++;
        throw new Error("Unexpected provider request");
      },
    }), "iprogsms_missing_api_token");
  assert(calls === 0);
});

Deno.test("all existing Philippine mobile formats normalize before provider request", async () => {
  for (
    const value of [
      "09171234567",
      "+639171234567",
      "639171234567",
      "9171234567",
      "(0917) 123-4567",
      "0917.123.4567",
    ]
  ) {
    const phoneNumber = normalizePhilippinePhoneNumber(value);
    assert(phoneNumber === input.phoneNumber);
    await sendIprogSms({ ...input, phoneNumber }, {
      readEnvironment,
      fetch: (_url, options) => {
        assert(
          JSON.parse(String(options?.body)).phone_number === input.phoneNumber,
        );
        return Promise.resolve(Response.json(accepted));
      },
    });
  }
});

Deno.test("invalid normalized phone is rejected before provider call", async () => {
  await expectError(
    () =>
      sendIprogSms({ ...input, phoneNumber: "09171234567" }, {
        readEnvironment,
        fetch: () => {
          throw new Error("Unexpected provider request");
        },
      }),
    "patient_phone_invalid",
  );
});
