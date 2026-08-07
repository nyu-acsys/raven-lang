# Change Log

All notable changes to the "raven" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-06

### Added

- The extension now keeps up with Raven releases on its own, so a new verifier no longer requires a new extension release. The bundled verifier becomes a floor rather than a pin: on startup, at most once a day, the extension checks whether a newer Raven has been released and offers to install it, keeping installed verifiers per version under its global storage. Nothing is downloaded without asking, and the bundled copy is still what makes a fresh, offline first run work. New settings `ravenServer.updateChannel` (`stable` by default, or `tag`/`bundled`), `ravenServer.ravenVersion` and `ravenServer.checkForUpdates`, and new commands `Raven: Update Verifier`, `Raven: Show Verifier Version` and `Raven: Use Bundled Verifier`. `ravenServer.executablePath` continues to override everything.
- A release is only installed if this extension can actually drive it. Raven releases publish a `manifest.json` declaring an `lsp_protocol` — the version of the JSON diagnostic schema and CLI surface the extension talks to, versioned separately from Raven itself — and the oldest Z3 they work against. A release outside the supported protocol range, or needing a newer Z3 than the extension bundles, is declined with a message to update the extension, rather than installed and left to fail later. Downloads are checked against the release's `SHA256SUMS`, extracted into a staging directory, and moved into place only after the verifier has been shown to run; installs are per version, so nothing is written over a binary that may be executing.

- Gutter markers for diagnostics: a line carrying a failure gets an error icon in the editor's glyph margin, one carrying only related locations gets an information icon, in the same colours VS Code draws their squiggles. VS Code marks diagnostics with a squiggle and an overview-ruler tick, both of which need the line on screen (or the Problems panel open) to be noticed; a gutter marker makes a file scannable, which matters most for related locations, whose underline is deliberately quiet. Hovering a marker shows every message reported against that line. A line is marked where its diagnostic *starts*, so one spanning a whole procedure body gets a single marker rather than striping the gutter. Controlled by `ravenServer.showGutterIcons` (default on); needs `editor.glyphMargin` to be visible.

### Changed

- The language server no longer decides which `raven` to run: the client resolves it and tells the server, at startup and again whenever the answer changes. That is what lets a newly installed verifier take effect without restarting anything, and it removes a fallback chain that existed in both halves of the extension and would now have drifted.
- Syntax highlighting: `choose`, `is`, `in`, `subseteq` now highlight as built-ins.

## [1.1.0] - 2026-08-01

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
