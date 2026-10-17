# Security policy

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting, not in a
public issue:

<https://github.com/vallabha717/Amiro/security/advisories/new>

That can also be reached from the repository's **Security** tab by choosing
**Report a vulnerability**. It opens a private advisory visible only to you and
the maintainers.

Please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, ideally a minimal proof of concept.
- The Amiro version (`package.json` and `src-tauri/tauri.conf.json`), your OS and
  architecture, and whether you ran from a release build or from source.
- Any relevant logs, with secrets removed.

Do not include real API keys, access tokens, private keys, or third-party
personal data in a report. Redact them. If a credential is required to
demonstrate the issue, say so and let a maintainer arrange a test credential.

## What to expect

This is a small project, so the following are aims rather than a guarantee:

- Acknowledgement of your report within 7 days.
- An initial assessment, including whether we consider it in scope, within 14
  days.
- Credit in the advisory and the `CHANGELOG.md` entry once a fix ships, unless
  you ask to stay anonymous.

Please give us a reasonable window to fix the issue before publishing details.

## Supported versions

There are no tagged releases yet. Security fixes are made on `main`, and only
the tip of `main` is supported. Once releases are tagged, this section will list
the supported release lines and their support windows.

The version field in `package.json` and `src-tauri/tauri.conf.json` is not a
support promise by itself.

## Preview restrictions are a policy, not an OS sandbox

This is the most important caveat in this document.

Amiro applies restrictions such as loopback-only binds, a sidecar token,
preview-port TLS termination, approval prompts, read-only workspace and memory
modes, and an admin-gated workspace view. Together these are a **policy layer**.
They are enforced by Amiro's own code and by the vendored runtime's permission
logic, running with the privileges of the user who started the app.

They are not an operating system sandbox. There is no kernel-enforced isolation
between the runtime, the tools it invokes, and the rest of your user account. Do
not treat the preview restrictions, the tool approval flow, or a read-only
workspace mode as a security boundary against untrusted code that you choose to
run.

What that means in practice:

- **In scope.** Bypassing an Amiro restriction without user intent, such as
  reaching an admin-only route as a non-admin, reading another user's threads or
  memory, escaping the intended workspace root, or having a prompt injection
  drive a tool call that Amiro claimed the user must approve. Also in scope:
  authentication or session flaws, leaks of stored provider credentials, and
  cross-user data exposure in the backend.
- **In scope, but expected.** A model or prompt influencing the runtime to
  perform an allowed action. Policy restrictions constrain what the runtime may
  do, not what a language model will ask for. Report it anyway if the resulting
  action crossed a boundary Amiro documented.
- **Out of scope by design.** Code you deliberately run with the runtime's own
  privileged or unrestricted modes, and anything that requires an attacker to
  already have code execution as your OS user. The OS user boundary is the real
  boundary.
- **Out of scope.** Vulnerabilities in a provider, a model, or the operating
  system itself. Report those upstream.

## Third-party components

- `runtime/` is a source fork of the MIT-licensed upstream project recorded in
  `THIRD-PARTY-NOTICES.md`, pinned to an immutable commit. If an issue exists in
  upstream code and reproduces in upstream builds, report it upstream as well,
  and tell us here so we can track the pinned revision.
- `adapter/` is a retired compatibility harness. It is not the backend and
  nothing starts it in production. Reports about it are accepted but are handled
  at lower priority than issues in `backend/`, `src-tauri/`, or `src/`.
- The adapter's optional dependency on the upstream `@1jehuang/jcode-sdk` package
  is a separately installed upstream component. It is not bundled with Amiro.

## Hardening advice for users

- Keep the app bound to loopback unless you have deliberately put a reverse proxy
  with TLS in front of it.
- Treat provider API keys as secrets. They are stored for the app's own use, not
  for sharing.
- Run Amiro as an unprivileged user, and point the workspace at a directory you
  would accept the runtime reading and writing.
- Review tool calls that ask for shell or filesystem access. The approval prompt
  is a speed bump, not a container.
