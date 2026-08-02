<table>
<tr>
<td width="200"><img width="200" src=".github/assets/logo.png"/></td>
<td>

# Raven VS Code Extension

VS Code integration for the [Raven intermediate verification language](https://github.com/nyu-acsys/raven) and verification tool. This is the extension's source — for installation and day-to-day usage, see the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=nyu-acsys.raven-verifier); the docs below cover building and developing the extension itself.

New to Raven itself? Start at **[nyu-acsys.github.io/raven](https://nyu-acsys.github.io/raven/)** — the project page and an introduction to the language, including a [hands-on tutorial](https://nyu-acsys.github.io/raven/tutorial/) written around this extension.

</td>
</tr>
</table>

## Prerequisites

None. This extension bundles the Raven verifier and Z3 for your platform (Linux x64/arm64, macOS x64/arm64, Windows x64), so nothing needs to be installed separately.

If you're developing Raven itself and want to verify against a local build instead of the bundled binary, see [First Usage](#first-usage) below.

## First Usage

The extension works out of the box using its bundled verifier — no configuration needed.

To point it at a different `raven` build instead (e.g. a local development build), set the `ravenServer.executablePath` setting:
   - Go to Settings (`Cmd+,` / `Ctrl+,`)
   - Search for "Raven"
   - Set "Executable Path" to the absolute path of the `raven` binary you want to use
    (example: `/path/to/raven/_build/default/bin/raven.exe`).

This overrides the bundled binary for the current scope (e.g. per workspace), which is convenient for testing changes to Raven itself without reinstalling the extension. Z3 must still be reachable — either the bundled copy (found automatically) or one on your own `PATH`.

## Configuration

This extension provides the following settings:

* `ravenServer.maxNumberOfProblems`: Controls the maximum number of problems produced by the server.
* `ravenServer.trace.server`: Traces the communication between VS Code and the language server.
* `ravenServer.executablePath`: Path to the Raven executable. Leave empty to use the verifier bundled with the extension.

## Building from Source

To develop or build the extension locally:

```bash
$ npm install
$ npx @vscode/vsce package
$ code --install-extension raven-1.0.0.vsix
```

A plain `vsce package` like this produces an unbundled extension (no `raven`/`z3` included) — fine for extension development, but you'll need `ravenServer.executablePath` set (see First Usage) to actually verify anything. Platform-specific packages that bundle `raven`/`z3` are built by [`.github/workflows/package.yml`](.github/workflows/package.yml), which downloads binaries pinned in [`RAVEN_VERSION`](RAVEN_VERSION) and [`Z3_VERSION`](Z3_VERSION) and runs `vsce package --target <platform>`.
