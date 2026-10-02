# Security Policy

## Supported Versions

Security fixes are applied to the latest released minor version. As the project is
pre-1.0, only the most recent `0.x` release is supported.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, report them privately via
[GitHub Security Advisories](https://github.com/doryski/appgraph/security/advisories/new).
This lets us discuss and fix the issue before it is publicly disclosed.

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The affected version(s)
- Any suggested mitigation, if known

You can expect an initial acknowledgement within a few days. Once the issue is
confirmed and fixed, a patched release will be published and the advisory disclosed
with appropriate credit, if desired.

## Threat model

`appgraph` is a **static analysis tool**. It reads source files with the TypeScript
parser and writes YAML and HTML into an output directory. It is useful to know what
that does and does not involve:

- **It never executes your application code.** Analysis is parser-only: source files
  are turned into ASTs via `ts.createSourceFile` and read. Your components, loaders
  and route modules are not imported or evaluated.
- **It does execute your `appgraph.config.*`.** A `.ts`/`.mts`/`.cts` config is transpiled
  to a temporary `.mjs` file next to the config file (removed afterwards) and loaded with
  a dynamic `import()`; a `.js`/`.mjs` config is imported directly. Either way it runs with
  the full privileges of the invoking user, like any other JavaScript config file. This
  applies to `analyze()` too, which loads the config itself when you pass no `config`
  object. Treat a config file from an untrusted source the same way you would treat an
  untrusted `vite.config.ts`.
- **It refuses to write through symlinks.** The CLI will not write an artifact whose path,
  or whose parent directory, is a symlink, so a planted link in the output directory cannot
  redirect a write elsewhere. Files are staged to a temporary sibling and renamed into
  place, and nothing is replaced until every file has been staged.
- **Text from your repository is sanitised before it reaches your terminal.** Control
  characters (C0 except newline and tab, DEL and C1) in diagnostic codes, messages, file
  names and traces are printed as `\xNN` escapes, so a crafted file name or string
  constant cannot inject escape sequences into the CLI output.
- **It makes no network requests** and sends no telemetry.
- **The generated HTML report embeds strings taken from your source** — route paths,
  component names, guard expressions, endpoint URLs, test-id values. Those values are
  escaped when rendered, and the YAML artifacts quote and escape any scalar containing
  control characters, line separators or other non-printable code points (then re-parse
  the result as a self-check), but the output is still a derivative of your code: if your
  routes or guard expressions contain sensitive information, so will the report.
  Review the output directory before publishing or committing it.
- **The generated artifacts describe your app's structure**, including which screens
  require authentication and which sit behind feature flags. This is reconnaissance
  material. Do not publish it for a private application.

If you believe any of the above statements is false for a given input, that is a
security report — please use the advisory link above.

Thank you for helping keep the project and its users safe.
