# Change Log

All notable changes to the "raven" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Code lenses show the verification status of each member and module (LSP protocol 4).
- `ravenServer.smtTimeout` sets the time limit of the SMT solver.

### Changed

- `ravenServer.maxNumberOfProblems` limits the errors Raven reports (LSP protocol 4).

## [1.3.0] - 2026-10-16

### Added

- Add **Raven: Verify File in Strict Mode** for a one-off strict check, and `ravenServer.strict` for strict-mode warnings, with yellow warning gutter markers and a yellow success indicator when warnings are present. Requires Raven LSP protocol 3 or later.
- With a verifier reporting `lsp_protocol` 3 or newer, a member that inherits its contract from an interface shows it in a code lens above its header and in full on hover, as soon as the file is type-checked. Hovering over the name of a module or interface shows the members it inherits from its interfaces, with their headers and contracts.

### Changed

- Bundle Raven 1.5.0.
- Reverify affected documents when included files change.
- Cancel obsolete verification processes and limit concurrent verifier runs.
- Track verification state per document and version, with consistent `Raven:` labels and colors.
- `inline`, `opens` and `:>` are highlighted.

### Fixed

- Opening a file checks it once rather than three times.

## [1.2.1] - 2026-09-06

### Fixed

- Files using the eris extension are checked in the right mode instead of showing false errors, with a verifier reporting `lsp_protocol` 2 or newer.

## [1.2.0] - 2026-08-06

### Added

- The extension keeps the verifier up to date: at most once a day, it checks for a newer Raven release and offers to install it. New settings `ravenServer.updateChannel`, `ravenServer.ravenVersion` and `ravenServer.checkForUpdates`, and new commands `Raven: Update Verifier`, `Raven: Show Verifier Version` and `Raven: Use Bundled Verifier`.
- A Raven release is installed only if the extension supports its protocol version and has a recent enough Z3, and only after its download is checked against the release's checksums.
- A line with errors or related locations is marked in the gutter, and hovering over the marker shows its messages. Controlled by `ravenServer.showGutterIcons`.

### Changed

- A newly installed verifier takes effect without restarting the extension.
- `choose`, `is`, `in` and `subseteq` are highlighted as built-ins.

## [1.1.0] - 2026-08-01

### Added

- Platform-specific packages bundle `raven` and `z3`, so neither has to be installed separately.
- The command `Raven: Verify File` (`Cmd+Shift+R` / `Alt+Shift+R`) verifies the current file.
- The setting `ravenServer.executablePath` selects the Raven binary to use, such as a local development build.
- With `ravenServer.highlightRelatedLocations` (on by default), a diagnostic's related locations are underlined in the editor.
- File paths are handled correctly on Windows, Linux and macOS.
- Syntax highlighting, and diagnostics from the Raven verifier.

### Fixed

- Related locations in Raven's standard library can be opened, either as the source in a Raven checkout or as a read-only document provided by the verifier.
- Related locations in other files point to the right file, and those reported before their diagnostic are no longer dropped.
- The status bar updates when switching editors, is hidden for files other than Raven's, and no longer shows conflicting states.
- The extension no longer depends on fixed paths to the verifier: it uses the configured one, or `raven` on the PATH.
- Failures to run Raven are handled better.
