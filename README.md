# Raven VS Code Extension

**[Download on Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=eg3134.raven-ivl)**

VS Code integration for the [Raven intermediate verification language](https://github.com/nyu-acsys/raven) and verification tool.

## Prerequisites

This extension **requires** the Raven verifier to be installed on your system. It does not bundle the verifier itself.

Please follow the installation instructions at the [Raven repository](https://github.com/nyu-acsys/raven) to install the command-line tool.

## Installation

You can install this extension directly from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=eg3134.raven-ivl), or run the following command in VS Code:

```bash
code --install-extension eg3134.raven-ivl
```

## First Usage

1. **Install Raven**: Ensure `raven` is installed (see Prerequisites).
2. **Configure Path**: If `raven` is not in your system `PATH`, you **must** set the `ravenServer.executablePath` setting in VS Code to point to the `raven` executable.
   - Go to Settings (`Cmd+,` / `Ctrl+,`)
   - Search for "Raven"
   - Set "Executable Path" to the absolute path of your `raven` binary.

## Features

- **Syntax Highlighting**: Proper highlighting for `.rav` files.
- **Verification**: Automatic verification on save, with error diagnostics.
- **Manual Verification**: Trigger verification manually with `Cmd+Shift+R`.
- **Diagnostics**: Errors and warnings shown directly in the editor.

## Configuration

This extension provides the following settings:

* `ravenServer.maxNumberOfProblems`: Controls the maximum number of problems produced by the server.
* `ravenServer.trace.server`: Traces the communication between VS Code and the language server.
* `ravenServer.executablePath`: Path to the Raven executable. Defaults to 'raven' (assumed to be in your PATH).

## Usage

* **Verification**: Verification runs automatically on save.
* **Manual Verification**: You can trigger verification manually by pressing `Cmd+Shift+R` (Mac) or `Alt+Shift+R` (Windows/Linux) when editing a `.rav` file.

## Building from Source

To develop or build the extension locally:

```bash
$ npm install
$ npx @vscode/vsce package
$ code --install-extension raven-1.0.0.vsix
```