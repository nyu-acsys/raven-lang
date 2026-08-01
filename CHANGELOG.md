# Change Log

All notable changes to the "raven" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Added

- Bundled `raven` and `z3` binaries: platform-specific packages (Linux x64/arm64, macOS x64/arm64, Windows x64) no longer require installing the verifier or Z3 separately. `ravenServer.executablePath` still overrides the bundled binary (e.g. to test a local development build).
- Manual verification trigger command: `Raven: Verify File` (`Cmd+Shift+R` / `Alt+Shift+R`).
  - Includes immediate visual feedback ("Verifying..." spinner) when triggered.
- Configuration setting `ravenServer.executablePath` to specify the path to the Raven binary.
- Setting `ravenServer.highlightRelatedLocations` (default on): underlines a diagnostic's related locations in the editor in the Information colour, so they are visibly distinct from the red of the error they explain. Applies to related locations in the file being edited; they remain listed under the diagnostic in the Problems panel either way.
- Robust URI handling using `vscode-uri` to ensure cross-platform compatibility (Windows/Linux/macOS).
- Syntax highlighting support
- Diagnostics via integration of the Raven verifier

### Fixed

- **Library Sources**: Related locations inside Raven's own standard library are now reachable. The library is embedded in the verifier rather than existing as files on disk, so these locations previously had nothing to open. They now open either the real source, when the verifier is running from a checkout that matches it, or a read-only virtual document (`raven-stdlib:` scheme) whose text comes straight from the verifier. The virtual document is syntax-highlighted like any `.rav` file and is never verified, which matters because a library source does not check on its own: they are verified as a set, each referring to declarations in the others.

- **Related Locations**: A diagnostic's related locations now point at the file they are actually in, making them a clickable jump to the declaration that was violated (e.g. the interface axiom a module fails to satisfy, in the file that declares it). They were previously built with the URI of the file being edited regardless of where Raven reported them, so a location in an included file was rendered at those coordinates in the wrong file. Related locations reported *before* the diagnostic they explain — as Raven does for the declaration a rule was inherited from — were also dropped entirely, and now survive. Needs the paired verifier change ("Keep related locations intact in `--lsp-mode`"); against a verifier without it these locations remain collapsed onto the `include` directive as before. where verification results persisted after switching files. The status bar now correctly listens to active editor changes and hides for non-Raven files.
- **Race Conditions**: Refactored status bar logic into a centralized update function to prevent `Verifying` and `Success` states from conflicting.
- **Hardcoded Paths**: Removed hardcoded executable paths in the server that caused crashes on non-author machines. The extension now uses the configured path or defaults to `raven` in PATH.
- Improved error handling for Raven execution.
