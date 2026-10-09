import { createClient } from "@supabase/supabase-js";
import { getLogicalSessionIdentity } from "./roleInactivity";

function securityError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function requireFullOtp(value) {
  const token = String(value ?? "").trim();
  if (!/^\d{6}$/.test(token)) {
    throw securityError("Enter the complete 6-digit OTP code.", "invalid_otp");
  }
  return token;
}

// Capture the session before any asynchronous work. A refreshed token may keep
// its logical session; logout or a replacement session permanently cancels work.
export async function createAuthenticatedMutation(client, {
  signal,
  expectedUserId = "",
  expectedIdentity = "",
  isCurrent = () => true,
  makeClient = createClient,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = 45000,
} = {}) {
  let active = true;
  let captured = "";
  let observed = "";
  let changed = false;
  let credentialClient;
  const pending = new Set();
  const timers = new Map();
  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    const identity = getLogicalSessionIdentity(session);
    if (event === "SIGNED_OUT" || (captured ? identity !== captured : observed && identity !== observed)) {
      changed = true;
    }
    observed = identity;
  });
  const assertCurrent = () => {
    if (!active || changed || signal?.aborted || !isCurrent()) {
      throw securityError("Your session changed. Reopen this page and try again.", "mutation_cancelled");
    }
  };
  const dispose = () => {
    active = false;
    subscription.unsubscribe();
    signal?.removeEventListener("abort", dispose);
    for (const [id, reject] of timers) {
      clearTimer(id);
      reject(securityError("The operation was cancelled.", "mutation_cancelled"));
    }
    timers.clear();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    assertCurrent();
    const result = await client.auth.getSession();
    assertCurrent();
    if (result.error) throw result.error;
    const session = result.data?.session;
    captured = getLogicalSessionIdentity(session);
    if (!captured || (observed && observed !== captured) ||
        (expectedUserId && session.user.id !== expectedUserId) ||
        (expectedIdentity && captured !== expectedIdentity)) {
      throw securityError("Your session changed. Reopen this page and try again.", "mutation_cancelled");
    }
    const userId = session.user.id;
    const check = async () => {
      assertCurrent();
      const current = await client.auth.getSession();
      assertCurrent();
      if (current.error) throw current.error;
      if (getLogicalSessionIdentity(current.data?.session) !== captured) {
        changed = true;
        assertCurrent();
      }
    };
    const scopedClient = makeClient(client.supabaseUrl, client.supabaseKey, {
      accessToken: async () => { await check(); return session.access_token; },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const request = async (label, action) => {
      await check();
      if (pending.size) throw securityError("Wait for the pending request to finish before retrying.", "request_pending");
      let timerId;
      const work = Promise.resolve().then(() => { assertCurrent(); return action(); });
      pending.add(work);
      // Retain the lock until the actual request settles, even after UI timeout.
      void work.then(() => pending.delete(work), () => pending.delete(work));
      const timeout = new Promise((_, reject) => {
        timerId = setTimer(() => {
          timers.delete(timerId);
          reject(securityError(`${label} timed out. Its outcome is unknown. Wait for the request to finish before retrying.`, "auth_request_timeout"));
        }, timeoutMs);
        timers.set(timerId, reject);
      });
      try {
        const response = await Promise.race([work, timeout]);
        await check();
        if (response?.error) throw response.error;
        return response;
      } finally {
        clearTimer(timerId);
        timers.delete(timerId);
      }
    };
    const getUser = async () => {
      const response = await request("Account verification", () => client.auth.getUser(session.access_token));
      if (response.data?.user?.id !== userId) throw securityError("The account could not be verified.", "mutation_cancelled");
      return response.data.user;
    };
    const authRequest = (method, args, label) => request(label, async () => {
      // Auth operations use an isolated in-memory client. Password/OTP sign-in
      // responses cannot replace another account in the application's SDK store.
      if (!credentialClient) {
        credentialClient = makeClient(client.supabaseUrl, client.supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const seeded = await credentialClient.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
        await check();
        if (seeded.error) throw seeded.error;
        if (seeded.data?.user?.id !== userId) throw securityError("The account could not be verified.", "mutation_cancelled");
      }
      await check();
      const response = await credentialClient.auth[method](...args);
      assertCurrent();
      const user = response?.data?.user || response?.data?.session?.user;
      if (user?.id && user.id !== userId) throw securityError("The verification belongs to a different account.", "mutation_cancelled");
      if (!response?.error && ["signInWithPassword", "verifyOtp"].includes(method) &&
          !(method === "verifyOtp" && args[0]?.type === "email_change") &&
          (response?.data?.session?.user?.id !== userId || !response.data.session.access_token)) {
        throw securityError("Auth did not confirm the verification. Please request a new code and try again.", "invalid_otp");
      }
      if (!response?.error && method === "updateUser" && user?.id !== userId) {
        throw securityError("Auth did not confirm the account update.", "mutation_cancelled");
      }
      return response;
    });
    return {
      userId, identity: captured, client: scopedClient, assertCurrent, check,
      request, getUser, authRequest, dispose,
      async whenIdle() { await Promise.allSettled([...pending]); },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
