// Offline regression for the shared entry screen that precedes role routing.
// Actual JSX and the original logo render; effects/auth/network do not run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as router from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "espree";
import { transformWithOxc } from "vite";

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", ...process.argv.slice(1)], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const context = vm.createContext({ console });
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
  for (const [name, value] of Object.entries(values)) this.setExport(name, value);
}, { context });
const blocked = () => { throw new Error("Unexpected auth/network access in branding regression"); };

async function load(path, logo) {
  const source = await read(path);
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } });
  const imports = ast.body.filter(node => node.type === "ImportDeclaration");
  const code = (await transformWithOxc(source, path, { jsx: { runtime: "automatic", development: false } })).code;
  const module = new vm.SourceTextModule(code, { context, initializeImportMeta(meta) { meta.env = { DEV: false }; } });
  await module.link(spec => {
    if (spec === "react") return synthetic({ default: React, ...React });
    if (spec === "react/jsx-runtime") return synthetic(jsxRuntime);
    if (spec === "react-router-dom") return synthetic(router);
    if (spec.endsWith(".css")) return synthetic({});
    if (spec.endsWith("/MaternalCareLogo")) return logo;
    const declaration = imports.find(node => node.source.value === spec);
    assert.ok(declaration, "Known import: " + spec);
    return synthetic(Object.fromEntries(declaration.specifiers.map(item => [
      item.type === "ImportDefaultSpecifier" ? "default" : item.imported.name,
      item.imported?.name === "supabase" ? { auth: { getUser: blocked, signOut: blocked }, from: blocked, rpc: blocked } : blocked,
    ])));
  });
  await module.evaluate();
  return module;
}

const logo = await load("src/components/common/MaternalCareLogo.jsx");
const login = await load("src/pages/auth/login.jsx", logo);
const loading = await load("src/components/common/WorkspaceLoadingScreen.jsx", logo);
const render = (component, path) => renderToStaticMarkup(React.createElement(router.MemoryRouter, { initialEntries: [path] }, React.createElement(component)));

function verifyLogoOnly(html, label) {
  check((html.match(/<img\b/g) || []).length === 1, label + ": exactly one image");
  check(html.includes('src="/images/maternal-care-logo.png"'), label + ": original asset");
  check(!html.includes("<span") && !html.match(/<h[1-6]\b/), label + ": no duplicate label or heading");
  check(html.includes('role="status"') && html.includes('aria-label="Maternal Care"'), label + ": accessible status retained");
}

for (const path of ["/", "/login", "/login?logout=1", "/login?next=%2Fdoctor%2Fpatients", "/login?next=%2Fstaff%2Fsettings"]) {
  verifyLogoOnly(render(login.namespace.default, path), "Shared entry " + path);
}
for (const path of ["/admin", "/admin/dashboard", "/admin/user-management"]) {
  verifyLogoOnly(render(loading.namespace.default, path), "Admin loading " + path);
}
for (const role of ["doctor", "staff"]) {
  for (const section of ["", "/dashboard", "/patients", "/appointments", "/profile", "/settings"]) {
    verifyLogoOnly(render(loading.namespace.default, "/" + role + section), role + section);
  }
  const path = role === "doctor" ? "src/pages/doctor/Doctor_Dashboard.jsx" : "src/pages/staff/StaffDashboard.jsx";
  const source = await read(path);
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, range: true });
  const visit = node => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "JSXElement" && node.openingElement.attributes.some(attr => attr.name?.name === "className" && attr.value?.value === "doctor-brand maternal-care-brand")) return node;
    for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
      const found = visit(child); if (found) return found;
    }
    return null;
  };
  const brand = visit(ast);
  check(brand, role + ": sidebar brand exists");
  const children = brand.children.filter(node => node.type !== "JSXText" || node.value.trim());
  check(children.length === 1 && children[0].openingElement?.name?.name === "MaternalCareLogo", role + ": sidebar contains only the original logo component");
  const fragment = source.slice(...brand.range);
  check(fragment.includes('variant="sidebar"') && !fragment.includes("<span"), role + ": sidebar sizing retained, no duplicate text");
}

for (const path of ["/patient/dashboard"]) {
  check(render(loading.namespace.default, path).includes("<span>Maternal Care</span>"), path + ": existing shared-loader behavior preserved");
}
for (const path of ["src/styles/doctor-dashboard.css", "src/styles/staff-dashboard.css", "src/styles/staff-doctor-parity.css", "src/styles/maternal-care-logo.css"]) {
  check(!/\bcontent\s*:\s*["'][^"']*maternal\s+care/i.test(await read(path)), path + ": no CSS-generated duplicate");
}
check((await read("src/styles/login.css")).includes("align-content: center;"), "entry card keeps logo centered without a text row");
check((await read("src/styles/workspace-loading.css")).includes("place-items: center;"), "workspace card centering retained");
console.log(`PASS: ${checks} branding checks; actual shared-entry/workspace JSX, sidebar structure and CSS; no auth/network access. Browser layout is a separate check.`);
