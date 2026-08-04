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

### Which verifier gets used

The bundled verifier is a floor, not a pin. Most Raven releases change nothing about the extension, so rather than waiting to be re-released with each one, the extension can install newer verifiers itself. In order of precedence:

1. `ravenServer.executablePath`, if set — the dev-build override, which always wins.
2. A verifier this extension downloaded, kept per-version under its global storage directory.
3. The verifier bundled with the extension. This is what makes the first run work offline.
4. `raven` on your `PATH`.

Updates are governed by `ravenServer.updateChannel` (`stable` by default) and `ravenServer.checkForUpdates`. On startup, at most once a day, the extension asks GitHub whether a newer Raven has been released and offers to install it; **nothing is downloaded without asking**. `Raven: Update Verifier` checks on demand, `Raven: Show Verifier Version` reports what is in use and where it came from, and `Raven: Use Bundled Verifier` goes back to the shipped one.

A release is only offered if this extension can actually drive it. Each Raven release publishes a `manifest.json` declaring its `lsp_protocol` — the version of the JSON diagnostic schema and CLI surface the extension talks to, which `raven --manifest` also reports — along with the oldest Z3 it works against. A release outside the range this extension supports (`SUPPORTED_PROTOCOL` in [`client/src/ravenBinary.ts`](client/src/ravenBinary.ts)), or needing a newer Z3 than the extension bundles, is declined with a message saying to update the extension instead. Downloads are checked against the release's `SHA256SUMS`, and a new verifier is only moved into place once it has been shown to run.

To point the extension at a different `raven` build instead (e.g. a local development build), set the `ravenServer.executablePath` setting:
   - Go to Settings (`Cmd+,` / `Ctrl+,`)
   - Search for "Raven"
   - Set "Executable Path" to the absolute path of the `raven` binary you want to use
    (example: `/path/to/raven/_build/default/bin/raven.exe`).

This overrides the bundled binary for the current scope (e.g. per workspace), which is convenient for testing changes to Raven itself without reinstalling the extension. Z3 must still be reachable — either the bundled copy (found automatically) or one on your own `PATH`.

## Configuration

This extension provides the following settings:

* `ravenServer.maxNumberOfProblems`: Controls the maximum number of problems produced by the server.
* `ravenServer.trace.server`: Traces the communication between VS Code and the language server.
* `ravenServer.executablePath`: Path to the Raven executable. Leave empty to let the extension choose one; overrides the update channel.
* `ravenServer.updateChannel`: `stable` (follow Raven releases), `tag` (use the release named by `ravenServer.ravenVersion`), or `bundled` (only ever use the shipped verifier).
* `ravenServer.ravenVersion`: The release tag to use on the `tag` channel, e.g. `v1.2.0`.
* `ravenServer.checkForUpdates`: Whether to check daily for a newer verifier.
* `ravenServer.showGutterIcons`: Mark lines carrying a diagnostic with an icon in the editor's gutter.
* `ravenServer.highlightRelatedLocations`: Underline a diagnostic's related locations in the editor.

## Opening `.rav` files from the file manager

Installing this extension teaches VS Code what a `.rav` file is; it does not tell the
operating system, so double-clicking one in Explorer/Finder/Nautilus won't open VS Code
until you say so once. That step can't be automated from here: a VSIX has no install
hook, and there is no contribution point for OS file association — that belongs to the
VS Code installer, which registers a fixed list of extensions that `.rav` isn't on.

Doing it by hand is a one-time job.

### Windows

Right-click any `.rav` file → **Open with** → **Choose another app** → pick Visual Studio
Code → tick **Always use this app to open .rav files**.

Equivalently, in PowerShell. This writes under `HKCU`, so there is no administrator
prompt; adjust the path if VS Code is installed system-wide, where it lives under
`C:\Program Files\Microsoft VS Code`:

```powershell
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
New-Item 'HKCU:\Software\Classes\.rav' -Force -Value 'VSCode.rav' | Out-Null
New-Item 'HKCU:\Software\Classes\VSCode.rav' -Force -Value 'Raven source file' | Out-Null
New-Item 'HKCU:\Software\Classes\VSCode.rav\shell\open\command' -Force `
    -Value "`"$code`" `"%1`"" | Out-Null
```

### macOS

Select a `.rav` file in Finder → **File ▸ Get Info** (`Cmd+I`) → under **Open with:**
choose Visual Studio Code → click **Change All…**.

If VS Code isn't in the dropdown, pick **Other…**, set the **Enable:** filter to *All
Applications*, and select it from `/Applications`.

### Linux

`.rav` is not a MIME type any distribution knows, so it needs defining first — otherwise
the only type a file manager can offer to reassign is `text/plain`, and changing that
would redirect every plain-text file to VS Code.

```bash
mkdir -p ~/.local/share/mime/packages
cat > ~/.local/share/mime/packages/raven.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/x-raven">
    <comment>Raven source file</comment>
    <sub-class-of type="text/plain"/>
    <glob pattern="*.rav"/>
  </mime-type>
</mime-info>
EOF
update-mime-database ~/.local/share/mime
xdg-mime default code.desktop text/x-raven
```

`code.desktop` is the name the official `.deb`/`.rpm` packages install. Other builds
differ — `code-insiders.desktop`, `codium.desktop`, `code_code.desktop` (Snap),
`com.visualstudio.code.desktop` (Flatpak) — so check yours first:

```bash
ls /usr/share/applications ~/.local/share/applications | grep -i code
```

Then confirm it took, and restart your file manager if it is still showing the old
association:

```bash
xdg-mime query filetype some-file.rav   # text/x-raven
xdg-mime query default text/x-raven     # code.desktop
```

Check the first one against a file with something in it. Content sniffing outranks the
glob for empty files, so a `.rav` you just created with `touch` reports as
`application/x-zerosize` even when everything is set up correctly.

## Building from Source

To develop or build the extension locally:

```bash
$ npm install
$ npm test                       # compile, then run the verifier-updater checks
$ npx @vscode/vsce package
$ code --install-extension raven-verifier-<version>.vsix
```

`npm test` covers the code that installs verifiers — version ordering, compatibility gating, checksum verification, and a full install against a release fixture served over local HTTPS. Set `RAVEN_TEST_NETWORK=1` to also query the real GitHub releases API, as [CI](.github/workflows/ci.yml) does.

A plain `vsce package` like this produces an unbundled extension (no `raven`/`z3` included) — fine for extension development, but you'll need `ravenServer.executablePath` set (see First Usage) to actually verify anything. Platform-specific packages that bundle `raven`/`z3` are built by [`.github/workflows/package.yml`](.github/workflows/package.yml), which downloads binaries pinned in [`RAVEN_VERSION`](RAVEN_VERSION) and [`Z3_VERSION`](Z3_VERSION) and runs `vsce package --target <platform>`.

## When a Raven release needs an extension release

Usually it doesn't. Users on the default `stable` channel are offered a new Raven the day
it is released, without this repo being touched — that is what
[`RAVEN_VERSION`](RAVEN_VERSION) being a floor rather than a pin buys.

Cut an extension release when:

- **The extension itself changed** — new features, fixes, settings.
- **A Raven release bumped `lsp_protocol`.** The extension declines to install anything
  outside `SUPPORTED_PROTOCOL` in [`client/src/ravenBinary.ts`](client/src/ravenBinary.ts),
  so until the extension is taught the new protocol and released, users stay where they
  are. This is the intended behaviour, not a failure: an old extension driving a verifier
  it does not understand is the thing the protocol number exists to prevent.
- **A Raven release raised `min_z3` above the bundled Z3.** Same story: bump
  [`Z3_VERSION`](Z3_VERSION) and release, or users cannot take the update.
- **The offline floor has drifted too far.** A fresh install should not have to download a
  verifier before it is useful. Refreshing `RAVEN_VERSION` every few Raven releases keeps
  the bundled one reasonably current; there is no need to do it every time.

## Releasing to the Marketplace

Packaging bundles a specific Raven build, so **the Raven release named in `RAVEN_VERSION`
has to exist first** — packaging downloads its binaries by tag and refuses to run against
the placeholder `unreleased`.

1. **Release Raven**, if you are also refreshing the bundled verifier. Tag `vX.Y.Z` in
   [nyu-acsys/raven](https://github.com/nyu-acsys/raven) and let its `release.yml` finish;
   it publishes `raven-<platform>.tar.gz` assets alongside `manifest.json` and
   `SHA256SUMS`. Skip this step when releasing the extension against a Raven that is
   already out.

2. **Point this repo at it, and bump the extension's own version.** These are independent
   version numbers — the extension's `1.1.0` bundles Raven's `1.2.0`.

   - [`RAVEN_VERSION`](RAVEN_VERSION) — the Raven release *tag*, `v`-prefixed (`v1.2.0`).
     Only the bundled verifier, i.e. the version a fresh offline install gets. Users on
     the `stable` channel may already be running something newer.
   - [`Z3_VERSION`](Z3_VERSION) — only if the bundled Z3 is changing.
   - `SUPPORTED_PROTOCOL` in [`client/src/ravenBinary.ts`](client/src/ravenBinary.ts) —
     only if this release adapts to a new Raven `lsp_protocol`.
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
