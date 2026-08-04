<p align="center">
  <img width="100%" src=".github/assets/banner.png" alt="Raven Verifier"/>
</p>

VS Code integration for the [Raven intermediate verification language](https://github.com/nyu-acsys/raven) and verification tool.

New to Raven? **[nyu-acsys.github.io/raven](https://nyu-acsys.github.io/raven/)** introduces the language and what it is for.

## Features

- **Syntax Highlighting**: Proper highlighting for `.rav` files.
- **Verification**: Automatic verification as you edit, with error diagnostics.
- **Manual Verification**: Trigger verification manually with `Cmd+Shift+R`.
- **Diagnostics**: Errors and warnings shown directly in the editor.

## Prerequisites

None. This extension bundles the Raven verifier and Z3 for your platform (Linux x64/arm64, macOS x64/arm64, Windows x64), so nothing needs to be installed separately.

## Installation

You can install this extension directly from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=nyu-acsys.raven-verifier), or run the following command in VS Code:

```bash
code --install-extension nyu-acsys.raven-verifier
```

## Usage

* **Verification**: Verification runs automatically as you edit — no need to save first.
* **Manual Verification**: You can trigger verification manually by pressing `Cmd+Shift+R` (Mac) or `Alt+Shift+R` (Windows/Linux) when editing a `.rav` file.

## Staying up to date

The extension ships with a working verifier, and also keeps up with new Raven releases on its own, so you get a new verifier without waiting for a new extension. It checks at most once a day and asks before downloading anything; `Raven: Show Verifier Version` says what is currently in use.

To turn this off, set `ravenServer.updateChannel` to `bundled` (or run `Raven: Use Bundled Verifier`). To pin a particular Raven release, set the channel to `tag` and name it in `ravenServer.ravenVersion`.

## Learning Raven

The [**Raven Tutorial**](https://nyu-acsys.github.io/raven/tutorial/) is a from-scratch introduction written around this extension: [Part 0](https://nyu-acsys.github.io/raven/tutorial/00-getting-started/) starts from the extension you have just installed and a first `.rav` file, and a single running example grows from a plain value into a concurrent data structure. Every listing in it is real, checked source.

## Configuration

This extension provides the following settings:

* `ravenServer.maxNumberOfProblems`: Controls the maximum number of problems produced by the server.
* `ravenServer.trace.server`: Traces the communication between VS Code and the language server.
* `ravenServer.executablePath`: Path to the Raven executable. Leave empty to let the extension choose one.
* `ravenServer.updateChannel`: `stable` (follow Raven releases), `tag` (use the release named by `ravenServer.ravenVersion`), or `bundled` (only ever use the shipped verifier).
* `ravenServer.ravenVersion`: The release tag to use on the `tag` channel, e.g. `v1.2.0`.
* `ravenServer.checkForUpdates`: Whether to check daily for a newer verifier.
* `ravenServer.highlightRelatedLocations`: Underline a diagnostic's related locations in the editor.

## Developing Raven or This Extension

Working on Raven itself and want to verify against a local build instead of the bundled binary, or want to build this extension from source? See the [GitHub repo](https://github.com/nyu-acsys/raven-lang#first-usage).
