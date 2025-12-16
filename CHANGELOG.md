# Change Log

All notable changes to the "raven" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Manual verification trigger command: `Raven: Verify File` (`Cmd+Shift+R` / `Alt+Shift+R`).
  - Includes immediate visual feedback ("Verifying..." spinner) when triggered.
- Configuration setting `ravenServer.executablePath` to specify the path to the Raven binary.
- Robust URI handling using `vscode-uri` to ensure cross-platform compatibility (Windows/Linux/macOS).
- Syntax highlighting support
- Diagnostics via integration of the Raven verifier

### Fixed

- **Status Bar Cleanup**: Fixed "sticky" status bar issue where verification results persisted after switching files. The status bar now correctly listens to active editor changes and hides for non-Raven files.
- **Race Conditions**: Refactored status bar logic into a centralized update function to prevent `Verifying` and `Success` states from conflicting.
- **Hardcoded Paths**: Removed hardcoded executable paths in the server that caused crashes on non-author machines. The extension now uses the configured path or defaults to `raven` in PATH.
- Improved error handling for Raven execution.
