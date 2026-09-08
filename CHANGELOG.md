# Changelog

All notable changes to Photoshop Auto Backup are documented here.

## [1.5.1]

### Changed

- The "Exclude current from every backup" checkbox now sits right under the
  **Backup now** button (previously under **Automatic backup**), grouping it
  with the document-specific status section instead of the global settings
  above it.
- "Maximum backups" custom value is now capped at **100** (was 10,000) — a
  more realistic ceiling for a personal backup folder.

### Fixed

- The exclusion checkbox rendered broken (checkbox glyph and label stacked
  on separate lines) because a CSS rule forced `display: block` on the
  `sp-checkbox` host, overriding its internal layout. Removed the rule and
  wrapped the checkbox in a plain container instead.
- Section labels (Documents, Mode, Backup folder, Maximum backups, Interval,
  Document, Last backup, Next backup, Log) were too dim; brightened them.
  "Automatic backup" now uses its own brighter, bolder label style since a
  live toggle deserves more visual weight than a passive section heading.

## [1.5.0]

### Added

- Header now shows **"by KreNtal"** next to the plugin title and the
  installed version right-aligned (e.g. "v1.5.0"), read at runtime from the
  plugin's own `manifest.json` via `fs.getPluginFolder()` — never hardcoded,
  so it can't drift out of sync on a version bump.

### Changed

- **Breaking (settings):** "Back up only if the document changed" is no
  longer a toggle — change detection is always on. The dedicated checkbox
  was removed; a short "(if document changed)" note now sits next to
  **Automatic backup** instead. **Backup now** still overrides it, same as
  before. Old installs with `backupOnlyIfChanged: false` saved simply stop
  having that field read; behaviour becomes "always on" for everyone.
- Default **Maximum backups** changed from 20 to 5.

## [1.4.0]

### Added

- **Per-document exclusion**: an "Exclude this document from backups"
  checkbox, always targeting the currently active document. Unlike "only if
  changed", exclusion is an absolute block — not overridden by **Backup
  now** or `force`. Stored separately from backup history
  (`settings.excludedProjects`), keyed by the same per-project path, so a
  document can be excluded before it has ever been backed up.
- Warning line under the **Documents** dropdown, shown only when "All open
  documents" is selected, explaining that Photoshop briefly switches to
  each document's tab while saving it.

### Changed

- "All open documents" eligible-document counts and the status indicator
  now account for exclusions.
- Button relabelled **"Backup now"** (was "Back up now") consistently across
  the UI, code, and docs.

## [1.3.0]

### Added

- **Multi-document backup.** New **Documents** setting: "Active document
  only" (default, previous behaviour) or "All open documents" — backs up
  every open, eligible document in one cycle. A document that is unsaved,
  cloud-based, or an unsupported format is skipped individually and does
  not stop the others.
- A single cycle-level lock now covers the whole cycle (every document in
  it) rather than one document at a time, so a multi-document cycle can
  never overlap with another.

### Documented

- Photoshop's document engine must briefly activate each document's tab to
  save it — a long-standing Photoshop behaviour (predates UXP), not
  something the plugin triggers or can avoid. Focus returns to the
  originally active document once the cycle finishes.

## [1.2.0]

### Changed

- **Breaking (settings):** "Per project" and "Single global folder" modes
  now share a single backup folder (`backupFolderToken`) instead of two
  separate ones. Switching modes no longer changes or loses the selected
  folder. Existing installs are migrated automatically on first load after
  the update.
- **Mode** is now a dropdown (`sp-picker`) instead of a radio group; the
  first option reads "Per project (in subfolders)".

## [1.1.1]

### Fixed

- "Open backup folder" failed with a misleading "backup folder is no longer
  reachable" message. The real cause: `shell.openPath()` requires
  `requiredPermissions.launchProcess` to be declared in the manifest, and
  opening a plain folder (no file extension) specifically requires an empty
  string in `launchProcess.extensions`. Also stopped masking the real
  native error behind that unrelated message.

## [1.1.0]

### Added

- "Open" button next to "Change" in the Backup folder section, using
  `uxp.shell.openPath()` to reveal the configured folder in the OS file
  explorer.

## [1.0.3]

### Added

- First working build: manual and automatic backup, per-project or global
  backup folder, retention with a configurable limit, change-detection
  skip, onboarding flow, and persistent folder permission via UXP tokens.
