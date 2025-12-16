# Raven VS Code Extension

VS Code integration for the **Raven** language and verification tool.

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

## Installation

Run

```bash
$ npm install
$ npx @vscode/vsce package
$ code --install-extension raven-1.0.0.vsix
```