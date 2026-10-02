// Run: node scripts/verify-patient-login-errors.mjs
// Actual login components/helpers with mocked React state and auth/database APIs.
// Checks rendered error-box JSX; no production credentials or network calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { transformWithOxc } from "vite";

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", ...process.execArgv, ...process.argv.slice(1),
  ], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const root = new URL("../", import.meta.url);
const sources = new Map();
async function codeFor(file) {
  if (!sources.has(file)) {
    sources.set(file, (await transformWithOxc(await readFile(new URL(file, root), "utf8"), file, {
      jsx: { runtime: "automatic", development: false },
    })).code);
  }
  return sources.get(file);
}
const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const network = "Unable to connect. Check your internet connection and try again.";
const credentials = "Incorrect email or password.";
const unexpected = "We couldn't sign you in right now. Please try again.";
const inactive = "Your Patient account is inactive. Please contact the clinic.";
const pending = "Your Patient account is pending Admin activation.";
const unlinked = "No Patient record is linked to this account. Return to Patient Access and scan the clinic QR code.";

function hookRuntime() {
  const slots = [];
  let cursor = 0, dirty = true, render, tree;
  const effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, n) => Object.is(value, b[n]));
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[n].value, update => {
        slots[n].value = typeof update === "function" ? update(slots[n].value) : update;
        dirty = true;
      }];
    },
    useMemo(factory, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) slots[n] = { value: factory(), deps };
      return slots[n].value;
    },
    useEffect(effect, deps) {
      const n = cursor++;
      if (!slots[n] || !equal(slots[n].deps, deps)) {
        effects.push(() => {
          slots[n]?.cleanup?.();
          slots[n] = { deps, cleanup: effect() };
        });
      }
    },
  };
  return {
    react,
    mount(component) { render = component; },
    current() {
      if (dirty) {
        dirty = false; cursor = 0; tree = render();
        for (const effect of effects.splice(0)) effect();
      }
      return tree;
    },
    async settle() {
      for (let n = 0; n < 30; n++) {
        this.current(); await flush();
        if (!dirty) return tree;
      }
      throw Error("Login state did not settle");
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []),
    ...[node.props?.children].flat().flatMap(child => nodes(child, predicate))];
}

async function harness(screen, initial = {}, query = "") {
  const runtime = hookRuntime();
  let scenario = initial;
  const calls = [], routes = [];
  const context = vm.createContext({
    console: { info() {}, warn() {}, error() {}, log() {} },
    URLSearchParams, navigator: { onLine: false },
    window: { setTimeout: () => 1 },
    fetch: async () => { throw Error("Unmocked network is forbidden"); },
  });
  const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
  const workspace = synthetic({});
  await workspace.link(() => { throw Error("Unexpected workspace import"); });
  await workspace.evaluate();
  const load = async (file, imports = {}) => {
    const module = new vm.SourceTextModule(await codeFor(file), {
      context,
      initializeImportMeta(meta) { meta.env = { DEV: false }; },
      importModuleDynamically(spec) {
        assert.equal(spec, "../patient/Patient_PWA");
        return workspace;
      },
    });
    await module.link(spec => {
      if (!Object.hasOwn(imports, spec)) throw Error("Unexpected import: " + spec);
      return imports[spec] instanceof vm.Module ? imports[spec] : synthetic(imports[spec]);
    });
    await module.evaluate();
    return module;
  };
  const supabase = {
    auth: {
      async getUser() {
        if (scenario.initialThrow) throw scenario.initialThrow;
        return { data: { user: scenario.initialUser ? { id: "fixture-user" } : null }, error: null };
      },
      async signInWithPassword(args) {
        calls.push(["signin", args]);
        if (scenario.authThrow) throw scenario.authThrow;
        return { data: scenario.authError || scenario.missingUser ? {} : { user: { id: "fixture-user" } },
          error: scenario.authError || null };
      },
      async signOut() { calls.push(["signout"]); return { error: null }; },
      async resend() {
        calls.push(["resend"]);
        if (scenario.resendThrow) throw scenario.resendThrow;
        return { error: scenario.resendError || null };
      },
    },
    from(table) {
      assert.equal(table, "profiles");
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() {
          calls.push(["profile"]);
          return { data: { role: scenario.role ?? "patient", account_status: scenario.clinicStatus || "active" },
            error: scenario.profileError || null };
        },
      };
    },
    async rpc(name) {
      calls.push([name]);
      if (name === "get_current_patient_account_status") return {
        data: scenario.unlinked ? null : { id: "fixture-patient", patient_id: "fixture-record",
          account_status: scenario.status || "active" }, error: scenario.accountError || null,
      };
      if (name === "ensure_current_patient_profile") return {
        data: { profile_id: "fixture-user" }, error: scenario.ensureError || null,
      };
      if (name === "link_patient_auth_account") return {
        data: { linked: true, patient_id: "fixture-record", account_status: "active" },
        error: scenario.linkError || null,
      };
      throw Error("Unexpected RPC");
    },
  };
  const account = await load("src/lib/patientAccountStatus.js");
  const linking = await load("src/lib/patientAuthLinking.js", {
    "./patientAccountStatus": account, "./supabaseClient": { supabase },
  });
  const messages = await load("src/lib/loginErrorMessage.js", { "./patientAuthLinking": linking });
  const jsx = (type, props) => ({ type, props: props || {} });
  const router = { useNavigate: () => (path, options) => routes.push([path, options]),
    useSearchParams: () => [new URLSearchParams(query)], Link: () => null };
  // useNavigate has stable identity just as the mounted Router does.
  const navigate = (path, options) => routes.push([path, options]);
  router.useNavigate = () => navigate;
  const common = {
    react: runtime.react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "@iconify/react": { Icon: () => null }, "react-router-dom": router,
    "../../lib/supabaseClient": { supabase }, "../../lib/patientAccountStatus": account,
    "../../lib/loginErrorMessage": messages,
    "../../components/common/MaternalCareLogo": { default: () => null },
    "../../styles/patient-access.css": {},
  };
  const file = screen === "shared" ? "src/pages/auth/login.jsx" : "src/pages/patient/Patient_Login.jsx";
  const component = await load(file, screen === "shared" ? {
    ...common, "../../lib/clinicAccountStatus": await load("src/lib/clinicAccountStatus.js"),
    "../../lib/auditLog": { recordAuditEvent: async () => { calls.push(["audit"]); } },
    "../../lib/patientPwaSessionCache": { setPatientPwaStartupAuthorization: () => calls.push(["startup"]) },
    "../../styles/login.css": {},
  } : {
    ...common, "../../lib/patientAuthLinking": linking,
    "../../lib/patientPendingLink": {
      resolvePatientPendingLink: () => scenario.linkDetails ? { patientId: "fixture-record", controlNumber: "fixture-control" } : {},
      buildPatientPendingLinkSearch: () => "", clearPatientPendingLink: () => calls.push(["clear-link"]),
    },
  });
  runtime.mount(component.namespace.default);
  await runtime.settle();
  const input = kind => nodes(runtime.current(), node => node.type === "input" &&
    node.props.id === (screen === "shared" ? "login-" : "patient-login-") + kind)[0];
  const errors = () => nodes(runtime.current(), node => node.type === "p" &&
    (node.props.className === "login-error-message" || node.props.className?.startsWith("patient-access-message")));
  return {
    calls, routes, errors, runtime,
    replace(next) { scenario = next; context.navigator.onLine = true; },
    normalize: messages.namespace.getLoginErrorMessage,
    async fill() {
      input("email").props.onChange({ target: { value: "patient@example.test" } });
      input("password").props.onChange({ target: { value: "synthetic-password" } });
      await runtime.settle();
    },
    async submit() {
      const form = nodes(runtime.current(), node => node.type === "form")[0];
      const operation = form.props.onSubmit({ preventDefault() {} });
      assert.equal(nodes(runtime.current(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, true);
      await operation; await runtime.settle();
      assert.equal(nodes(runtime.current(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, false);
      assert.equal(input("email").props.value, "patient@example.test");
      assert.equal(input("password").props.value, "synthetic-password");
    },
    async resend() {
      const button = nodes(runtime.current(), node => node.type === "button" && node.props.className === "login-secondary-btn")[0];
      assert.ok(button, "confirmation response retains resend action");
      await button.props.onClick(); await runtime.settle();
    },
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const expectMessage = (h, message) => {
  assert.equal(h.errors().length, 1, "one useful error box");
  assert.equal(h.errors()[0].props.children, message);
  assert.equal(h.routes.length, 0, "failed login must not route to workspace");
};
for (const screen of ["shared", "patient"]) {
  for (const [name, scenario, expected] of [
    ["thrown TypeError fetch rejection", { authThrow: new TypeError("Failed to fetch") }, network],
    ["returned Supabase transport failure", { authError: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" } }, network],
    ["raw returned network string", { authError: "Network request failed" }, network],
    ["wrapped returned network failure", { authError: { error: { name: "AuthRetryableFetchError", status: 0, message: "Request rejected" } } }, network],
    ["invalid credential response", { authError: { code: "invalid_credentials", message: "Invalid login credentials" } }, credentials],
    ["credential response takes precedence", { authError: { code: "invalid_credentials", message: "Failed to fetch" } }, credentials],
    ["unknown thrown technical detail", { authThrow: new Error("some internal technical detail") }, unexpected],
    ["unknown returned provider details", { authError: { message: "Synthetic SQL, session and HTTP implementation details" } }, unexpected],
    ["retryable HTTP 503 is not transport evidence", { authError: { name: "AuthRetryableFetchError", status: 503, message: "Upstream unavailable" } }, unexpected],
    ["inactive Patient retains its message", { status: "inactive" }, inactive],
    ["pending Patient retains its message", { status: "pending_activation" }, pending],
    ["unlinked Patient retains existing behavior", { unlinked: true }, screen === "shared" ? pending : unlinked],
    ["confirmation remains actionable", { authError: { code: "email_not_confirmed", message: "Email not confirmed" } }, "Please verify your email address before logging in."],
  ]) test(screen + ": " + name, async () => {
    const h = await harness(screen, scenario);
    await h.fill(); await h.submit(); expectMessage(h, expected); h.runtime.unmount();
  });
  test(screen + ": restored connectivity retries the same mounted form", async () => {
    const h = await harness(screen, { authError: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" } });
    await h.fill(); await h.submit(); expectMessage(h, network);
    h.replace({}); await h.submit();
    assert.equal(h.errors().length, 0);
    assert.equal(h.calls.filter(call => call[0] === "signin").length, 2);
    assert.equal(h.routes.length, 1);
    assert.equal(h.routes[0][0], "/patient/dashboard");
    assert.equal(h.routes[0][1].replace, true);
    h.runtime.unmount();
  });
}
for (const error of [
  { name: "NetworkError", message: "Transport failure" }, { code: "ENOTFOUND" },
  { cause: { code: "ECONNRESET" } }, { message: "NetworkError when attempting to fetch resource." },
  { message: "TypeError: Load failed" }, { message: "fetch failed" }, { code: "ERR_NETWORK" },
]) test("network classification: " + (error.name || error.code || error.message || "cause"), async () => {
  const h = await harness("shared", { authError: error });
  await h.fill(); await h.submit(); expectMessage(h, network); h.runtime.unmount();
});
for (const [name, scenario, expected] of [
  ["profile returned network failure", { profileError: { message: "TypeError: Failed to fetch" } }, network],
  ["profile internal failure", { profileError: { code: "42501", message: "some internal technical detail" } }, unexpected],
  ["session-check failure", { initialUser: true, profileError: { message: "Failed to fetch" } }, network],
  ["thrown session-check failure", { initialThrow: new TypeError("Failed to fetch") }, network],
  ["untrusted initial reason is not echoed", {}, unexpected],
  ["Staff inactive behavior preserved", { role: "staff", clinicStatus: "inactive" }, "Your Staff account has been deactivated. Please contact the system administrator."],
  ["Doctor inactive behavior preserved", { role: "doctor", clinicStatus: "inactive" }, "Your Doctor account has been deactivated. Please contact the administrator."],
]) test("shared: " + name, async () => {
  const initial = name.includes("session-check") || name.includes("initial reason");
  const h = await harness("shared", scenario, name.includes("initial reason") ? "reason=some%20internal%20technical%20detail" : "");
  if (!initial) { await h.fill(); await h.submit(); }
  expectMessage(h, expected); h.runtime.unmount();
});
for (const [name, scenario, expected] of [
  ["account-status network failure", { accountError: { message: "Failed to fetch" } }, network],
  ["profile repair network failure", { ensureError: { message: "Failed to fetch" } }, network],
  ["known linking state preserved", { unlinked: true, linkDetails: true, linkError: { message: "Invalid Patient ID or control number." } }, "The Patient ID or one-time control number is incorrect."],
  ["unknown linking detail hidden", { unlinked: true, linkDetails: true, linkError: { message: "some internal technical detail" } }, unexpected],
  ["missing RPC detail hidden", { accountError: { code: "PGRST202", message: "Synthetic RPC implementation detail" } }, unexpected],
  ["archived Patient preserved", { status: "archived" }, "This Patient record is archived. Please contact the clinic."],
]) test("patient: " + name, async () => {
  const h = await harness("patient", scenario);
  await h.fill(); await h.submit(); expectMessage(h, expected); h.runtime.unmount();
});
for (const [error, expected] of [[{ message: "Failed to fetch" }, network], [{ message: "some internal technical detail" }, unexpected]]) {
  test("shared: verification errors use the same safe boundary (" + expected + ")", async () => {
    const h = await harness("shared", { authError: { message: "Email not confirmed" } });
    await h.fill(); await h.submit(); h.replace({ resendError: error }); await h.resend();
    expectMessage(h, expected); h.runtime.unmount();
  });
}
test("shared: Patient routing fallback for status RPC failure is unchanged", async () => {
  const h = await harness("shared", { accountError: { message: "Failed to fetch" } });
  await h.fill(); await h.submit();
  assert.equal(h.routes[0][0], "/patient/access");
  assert.equal(h.errors().length, 0); h.runtime.unmount();
});


for (const [role, destination] of [["patient", "/patient/dashboard"], ["doctor", "/doctor"], ["staff", "/staff"], ["admin", "/admin"]]) {
  test("shared: successful " + role + " routing is unchanged", async () => {
    const h = await harness("shared", { role });
    await h.fill(); await h.submit();
    assert.equal(h.errors().length, 0);
    assert.equal(h.routes[0][0], destination);
    assert.equal(h.routes[0][1].replace, true);
    assert.equal(h.calls.filter(call => call[0] === "audit").length, 1);
    assert.equal(h.calls.some(call => call[0] === "startup"), role === "patient");
    h.runtime.unmount();
  });
}
for (const [query, destination] of [["next=%2Fpatient%2Freminders%2Fmedications", "/patient/reminders/medications"], ["next=%2Fadmin", "/patient/dashboard"]]) {
  test("shared: Patient next route preserves role validation (" + destination + ")", async () => {
    const h = await harness("shared", {}, query);
    await h.fill(); await h.submit();
    assert.equal(h.errors().length, 0);
    assert.equal(h.routes[0][0], destination); h.runtime.unmount();
  });
}
for (const screen of ["shared", "patient"]) {
  test(screen + ": rate-limit response is not a network failure", async () => {
    const h = await harness(screen, { authError: { code: "over_request_rate_limit", message: "Too many requests" } });
    await h.fill(); await h.submit();
    expectMessage(h, "Too many login attempts. Please wait a moment and try again."); h.runtime.unmount();
  });
}
test("shared: missing account role retains its intentional message and sign-out", async () => {
  const h = await harness("shared", { role: "" });
  await h.fill(); await h.submit();
  expectMessage(h, "No account role is connected to this user. Please contact the administrator.");
  assert.equal(h.calls.filter(call => call[0] === "signout").length, 1); h.runtime.unmount();
});
test("shared: a raw fetch query reason is normalized before rendering", async () => {
  const h = await harness("shared", {}, "reason=Failed%20to%20fetch");
  expectMessage(h, network); h.runtime.unmount();
});

let failed = 0;
for (const entry of tests) {
  try { await entry.run(); console.log("PASS: " + entry.name); }
  catch { failed++; console.error("FAIL: " + entry.name); }
}
console.log("Login UI regression summary: " + (tests.length - failed) + " passed; " + failed + " failed.");
process.exitCode = failed ? 1 : 0;
