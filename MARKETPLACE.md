<p align="center">
  <img width="100%" src=".github/assets/banner.png" alt="Raven Verifier"/>
</p>

VS Code integration for the [Raven intermediate verification language](https://github.com/nyu-acsys/raven) and verification tool.

## Features

- **Syntax Highlighting**: Proper highlighting for `.rav` files.
- **Verification**: Automatic verification on save, with error diagnostics.
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

* **Verification**: Verification runs automatically on save.
* **Manual Verification**: You can trigger verification manually by pressing `Cmd+Shift+R` (Mac) or `Alt+Shift+R` (Windows/Linux) when editing a `.rav` file.

## Configuration

This extension provides the following settings:

* `ravenServer.maxNumberOfProblems`: Controls the maximum number of problems produced by the server.
* `ravenServer.trace.server`: Traces the communication between VS Code and the language server.
* `ravenServer.executablePath`: Path to the Raven executable. Leave empty to use the verifier bundled with the extension.

## Developing Raven or This Extension

Working on Raven itself and want to verify against a local build instead of the bundled binary, or want to build this extension from source? See the [GitHub repo](https://github.com/nyu-acsys/raven-lang#first-usage).
