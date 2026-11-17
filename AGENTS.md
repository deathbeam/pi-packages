# pi-packages

Monorepo of pi extensions. Each `packages/<name>/` is published to npm on its own.

## Layout

- `index.ts` is the extension entry and the only file `pi.extensions` names. Put code in `src/` once it outgrows one file.
- List every shipped path in `package.json` `files`. Add `src`, `prompts` or `agents` there when you create them; `check.mjs` stays unpublished.
- Packages share no code. Copy a small helper into the package that needs it rather than importing across packages.
- Add a new package's `index.ts` to the root `package.json` `pi.extensions` too.
- Each package README documents its tools, config and env vars. Keep it current with user-visible changes.

## Commands

`node check.mjs` in a package, `npm test` for all of them, `npm run check` for `tsc --noEmit`, `npm run format` for prettier. There is no build: Node >= 22.19 strips types, and the published artifact is the TypeScript source.

## check.mjs

- A plain script: `node:assert/strict`, top-level awaits, a `console.log` per passing section, non-zero exit on the first failed assert.
- Call the default export with a hand-written stub of the ExtensionAPI methods the code uses, e.g. `{ registerTool: (t) => (tools[t.name] = t) }`. Add a stub member when the code starts calling a new one.
- Call `initTheme()` before exercising a renderer: the theme is a global singleton.
- Relative imports carry the `.ts` extension so plain Node can load them. pi-hashline is the exception: extensionless imports, loaded through `jiti` in its check.

## Code

- Order in every file: imports, types, constants, helpers, default export.
- Named helpers are `function` declarations; inline callbacks stay arrows.
- Comments explain a non-obvious why. Mark a deliberate limit `// shortcut: <limit>, <when to upgrade>`.

## pi dependencies

- `@earendil-works/pi-*` are `peerDependencies` at `"*"`, listed only for what the package imports at runtime: a package that imports `pi-tui` lists it.
- `typebox` is imported but never declared; pi supplies its copy. Declaring it installs a second one.

## Tools

- Strict models send the literal string `"null"` for optional params they omit. Drop `null` and `"null"` from the optionals before reading any (see `definedParams` in pi-keenable, `execute` in pi-archive). Required params keep their value: `grep` with `pattern: "null"` searches for that text.
- `content` is what the model reads; `details` is what the renderer reads. Render from `details` and keep `content` stable.
- Reuse pi's rendering. pi resolves `renderCall` and `renderResult` per slot: omit `renderCall` for the default `name key=value` line, omit `renderResult` for text with a 10-line cap, the expand hint and error styling. Write a renderer only for a genuinely custom view.
- Overriding a built-in tool name (pi-hashline's `read`/`grep`/`edit`) inherits the built-in renderer for any slot you omit.
- `formatToolCallWithArgs` and `getTextOutput` are not exported. Usable: `getMarkdownTheme`, `truncateToVisualLines`, and `context.keyHint` for hints.
- A "more lines" hint must match pi's string exactly: `` `${theme.fg("muted", `... (${n} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}` ``.

## Publishing

Bump `version` in the package's `package.json` in the same change and run `npm install` so `package-lock.json` follows. `publish.sh` skips versions already on npm, so an unbumped fix never ships.
