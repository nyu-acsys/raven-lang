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
$ code --install-extension raven-verifier-<version>.vsix
```

A plain `vsce package` like this produces an unbundled extension (no `raven`/`z3` included) — fine for extension development, but you'll need `ravenServer.executablePath` set (see First Usage) to actually verify anything. Platform-specific packages that bundle `raven`/`z3` are built by [`.github/workflows/package.yml`](.github/workflows/package.yml), which downloads binaries pinned in [`RAVEN_VERSION`](RAVEN_VERSION) and [`Z3_VERSION`](Z3_VERSION) and runs `vsce package --target <platform>`.

## Releasing to the Marketplace

The extension bundles a specific Raven build, so **a Raven release has to exist first** —
packaging downloads its binaries by tag and refuses to run against the placeholder
`unreleased`.

1. **Release Raven.** Tag `vX.Y.Z` in [nyu-acsys/raven](https://github.com/nyu-acsys/raven)
   and let its `release.yml` finish; it publishes `raven-<platform>.tar.gz` assets. Nothing
   here can proceed until those exist.

2. **Point this repo at it, and bump the extension's own version.** These are independent
   version numbers — the extension's `1.1.0` bundles Raven's `1.2.0`.

   - [`RAVEN_VERSION`](RAVEN_VERSION) — the Raven release *tag*, `v`-prefixed (`v1.2.0`).
   - [`Z3_VERSION`](Z3_VERSION) — only if the pinned Z3 is changing.
   - `version` in [`package.json`](package.json).
   - A dated section in [`CHANGELOG.md`](CHANGELOG.md).

3. **Commit and push to `main`.**

4. **Tag and push.** The tag is what triggers packaging:

   ```bash
   $ git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   [`package.yml`](.github/workflows/package.yml) then builds a `.vsix` for each of the
   five targets (Linux x64/arm64, macOS x64/arm64, Windows x64), each bundling `raven` and
   `z3`, and attaches them to the GitHub release for the tag.

5. **Publish.** Fetch the packages from the release and hand them to `vsce`:

   ```bash
   $ gh release download vX.Y.Z --repo nyu-acsys/raven-lang --pattern '*.vsix' -D dist
   $ npx @vscode/vsce publish --packagePath dist/*.vsix
   ```

   Publishing needs a Personal Access Token for the `nyu-acsys` publisher — either
   `vsce login nyu-acsys` once, or `VSCE_PAT` in the environment. Passing every `.vsix` in
   one command publishes all five platform packages under a single version; uploading them
   through the Marketplace UI works equally well.

Each `.vsix` is named `raven-verifier-<target>-<version>.vsix`, so packages from different
releases don't shadow each other.

### If something goes wrong mid-release

Nothing is public until step 5, so a tag can simply be moved: fix the problem on `main`,
then `git push --delete origin vX.Y.Z`, re-tag, and push again to rerun packaging. The
`release` job is skipped when the workflow is started manually (`workflow_dispatch`),
since there is no tag to attach anything to.
