# Raven VSCode Extension

This VSCode extension provides language support for the [Raven language and verifier](https://github.com/nyu-acsys/raven).


## Features

* Syntax highlighting
* Diagnostics via integration of the Raven verifier

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