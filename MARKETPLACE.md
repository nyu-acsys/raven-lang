<p align="center">
  <img width="100%" src=".github/assets/banner.png" alt="Raven Verifier"/>
</p>

VS Code integration for the [Raven intermediate verification language](https://github.com/nyu-acsys/raven) and verification tool.

New to Raven? **[nyu-acsys.github.io/raven](https://nyu-acsys.github.io/raven/)** introduces the language and what it is for.

## Features

- **Syntax Highlighting**: Proper highlighting for `.rav` files.
- **Verification**: Automatic verification as you edit, with error diagnostics.
- **Manual Verification**: Run **Raven: Verify File**, or use `Cmd+Shift+R` (Mac) / `Alt+Shift+R` (Windows/Linux).
- **Strict Mode**: Warn about assumed termination, explicit `free` declarations and physically atomic blocks, with a yellow success indicator when warnings are present.
- **Diagnostics**: Errors and warnings shown in the editor and Problems panel, with related locations and optional gutter icons.
- **Inherited Contracts**: View inherited contracts above callable headers and on hover, and inherited module members on hover.
- **Hover and Go to Definition**: See the declaration of a name on hover, and jump to it, including into the standard library.
- **Outline**: Modules, members and named assertions and invariants in the Outline view, breadcrumbs and **Go to Symbol in Editor**, with their verification status.
- **Verification Status**: See above each procedure, lemma, function and module whether it verified, failed or timed out.

## Prerequisites

None. This extension bundles the Raven verifier and Z3 for your platform (Linux x64/arm64, macOS x64/arm64, Windows x64), so nothing needs to be installed separately.

## Installation

You can install this extension directly from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=nyu-acsys.raven-verifier), or run the following command in VS Code:

```bash
code --install-extension nyu-acsys.raven-verifier
```

## Usage

* **Verification**: Verification runs automatically as you edit — no need to save first.
* **Manual Verification**: Run **Raven: Verify File** from the Command Palette, or press `Cmd+Shift+R` (Mac) or `Alt+Shift+R` (Windows/Linux) when editing a `.rav` file.
* **Verify this**: Click **Verify this** above a member, module or named assertion (`assert a: ...`) to verify only it, now and after each edit, while you work on its proof; the status bar names it. Click **Verify all** above it, or run **Raven: Verify All Members (End Focus)**, to verify the whole file again. This needs a Raven verifier supporting LSP protocol 4 or later.

The status bar tracks the active file and its current version. Messages use the **Raven:** prefix: grey for not checked or outdated results, blue while verifying, green when verified, yellow when verified with strict warnings, red for errors, and orange when verification is unavailable. Editing a file marks its previous result as outdated and stops the old check.

With a recent Raven verifier, changes to saved included files also recheck the files that depend on them, including indirect includes and files outside the workspace.

### Strict verification

Set `ravenServer.strict` to `true` to enable strict mode for automatic verification and **Raven: Verify File**. It defaults to `false` and can be set per workspace or folder:

```json
{
  "ravenServer.strict": true
}
```

For a single strict check, run **Raven: Verify File in Strict Mode** from the Command Palette. This checks the active file regardless of the setting and leaves it unchanged; subsequent checks use the configured mode.

Strict warnings appear in the editor and Problems panel, with yellow gutter markers when gutter icons are enabled. Verification can succeed with warnings: the status reads **Raven: Verified with warnings** in yellow, with a tooltip explaining why. Verification errors still show a red failure indicator.

Strict-mode diagnostics and inherited-contract displays require a Raven verifier supporting LSP protocol 3 or later. An older verifier reports that strict-mode diagnostics are unavailable; use **Raven: Update Verifier** to check for a compatible update.

## Staying up to date

The extension ships with a working verifier, and also keeps up with new Raven releases on its own, so you get a new verifier without waiting for a new extension. It checks at most once a day and asks before downloading anything; `Raven: Show Verifier Version` says what is currently in use. Run **Raven: Update Verifier** to check for updates on demand.

To turn this off, set `ravenServer.updateChannel` to `bundled` (or run `Raven: Use Bundled Verifier`). To pin a particular Raven release, set the channel to `tag` and name it in `ravenServer.ravenVersion`.

## Opening `.rav` files from the file manager

Installing this extension teaches VS Code what a `.rav` file is, but it cannot tell your
operating system — nothing an extension installs is allowed to change your system's file
associations. So double-clicking a `.rav` file in Explorer, Finder or your file manager
won't open VS Code until you say so once.

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
```

With the type defined, either right-click a `.rav` file in your file manager and set
Visual Studio Code as the default application, or do it from the terminal:

```bash
xdg-mime default code.desktop text/x-raven
```

The name to use there depends on how VS Code was installed: `code.desktop` for the
official `.deb`/`.rpm`, `code_code.desktop` for the Snap, `com.visualstudio.code.desktop`
for the Flatpak, `code-insiders.desktop` or `codium.desktop` for those builds. Snap and
Flatpak keep their desktop files outside `/usr/share/applications`, so look everywhere
XDG does rather than in one directory:

```bash
for dir in "${XDG_DATA_HOME:-$HOME/.local/share}" ${XDG_DATA_DIRS//:/ }; do
    ls "$dir/applications" 2>/dev/null
done | grep -i code | sort -u
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

## Learning Raven

The [**Raven Tutorial**](https://nyu-acsys.github.io/raven/tutorial/) is a from-scratch introduction written around this extension: [Part 0](https://nyu-acsys.github.io/raven/tutorial/00-getting-started/) starts from the extension you have just installed and a first `.rav` file, and a single running example grows from a plain value into a concurrent data structure. Every listing in it is real, checked source.

## Configuration

This extension provides the following settings:

* `ravenServer.maxNumberOfProblems`: The maximum number of errors Raven reports per check; 0 for no limit. Needs a Raven verifier supporting LSP protocol 4 or later.
* `ravenServer.smtTimeout`: The time limit, in milliseconds, for each proof obligation the SMT solver checks. A member whose proof runs out of time is marked as timed out.
* `ravenServer.trace.server`: Traces the communication between VS Code and the language server.
* `ravenServer.strict`: Enable strict-mode warnings for automatic and ordinary manual verification. Defaults to `false`; see [Strict verification](#strict-verification).
* `ravenServer.executablePath`: Path to the Raven executable. Leave empty to let the extension choose one; overrides the update channel.
* `ravenServer.updateChannel`: `stable` (follow Raven releases), `tag` (use the release named by `ravenServer.ravenVersion`), or `bundled` (only ever use the shipped verifier).
* `ravenServer.ravenVersion`: The release tag to use on the `tag` channel, e.g. `v1.4.0`.
* `ravenServer.checkForUpdates`: Whether to check daily for a newer verifier.
* `ravenServer.showGutterIcons`: Show red error, yellow warning and blue information icons in the editor's gutter.
* `ravenServer.highlightRelatedLocations`: Underline a diagnostic's related locations in the editor.

## Developing Raven or This Extension

Working on Raven itself and want to verify against a local build instead of the bundled binary, or want to build this extension from source? See the [GitHub repo](https://github.com/nyu-acsys/raven-lang#first-usage).
