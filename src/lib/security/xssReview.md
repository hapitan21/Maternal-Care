# Cross-Site Scripting (XSS) Review

## Safe rendering rules

- Prefer ordinary React text rendering, which escapes text children by default.
- Do not pass untrusted content to `dangerouslySetInnerHTML`, DOM `innerHTML`, script evaluation, or dynamically constructed executable code.
- If a feature must render HTML, sanitize it with a maintained sanitizer and narrow allowlist first. Database content is not automatically trusted.
- Validate URL schemes before using user-controlled links, redirects, image sources, or navigation targets. Reject executable schemes such as `javascript:`.
- Validate and constrain upload type, size, and name at the server/storage boundary as well as in the UI.
- Keep dependencies current and review packages that parse Markdown, HTML, URLs, or files.

## Initial source scan

On 2026-10-22, a simple search of `src/` found no direct uses of `dangerouslySetInnerHTML`, `innerHTML =`, `eval()`, or `new Function()`. The local verifier repeats a limited version of this scan. Neither is proof that the app is free of XSS; review URL construction, third-party components, file handling, and display paths for user-controlled values too.

## Safe verification

Use local or preview deployments with synthetic accounts and data. Submit harmless HTML-like marker strings and confirm they display as text rather than being interpreted. Do not use tests that exfiltrate data, perform destructive actions, or target real users. Record the component and result in `securityTestPlan.md` without personal data.
