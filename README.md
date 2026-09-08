# Photoshop Auto Backup

A UXP plugin for modern Adobe Photoshop that automatically creates timestamped
backup copies of the open document, without ever touching the original file.

---

## What it does

- Saves a **copy** of the active document at a chosen interval (default: 5 minutes).
- Never modifies, renames, moves or replaces the original project.
- Keeps PSD as PSD and PSB as PSB.
- Organises backups either **per project** (one subfolder per document) or into a
  **single global folder**.
- Prunes old backups according to a retention limit.
- Can skip a backup when the document has not changed since the last one.
- Keeps separate state for every project (last backup time, last document state).

### File naming

```
ProjectName_YYYY-MM-DD_HH-mm-ss.psd
ProjectName_YYYY-MM-DD_HH-mm-ss.psb
```

If a file with that name already exists (two backups within the same second), a
counter is appended: `ProjectName_2026-09-08_10-30-00_1.psd`.

### Folder layout

**Per project** (default) — the plugin creates one subfolder per document inside
the root folder you picked:

```
D:\Photoshop Backups\
    Logo Project\
        Logo Porject_2026-09-08_10-30-00.psd
        Logo Project_2026-09-08_10-40-00.psd
    Character\
        Character_2026-09-08_10-30-00.psb
```

**Global folder** — every backup goes into the single folder you picked, still
prefixed with the project name:

```
D:\Photoshop Backups\
    Logo Project_2026-09-08_10-30-00.psd
    Character_2026-09-08_10-30-00.psb
```

The subfolder name is derived from the document name without its extension, with
characters that are illegal in file names replaced by `_`.

---

## Requirements

- **Photoshop 24.0 (2023) or newer.** The manifest declares
  `"minVersion": "24.0.0"`. Manifest v5 itself requires Photoshop 23.3+, but
  24.0 is the baseline this plugin is written and tested against.
- **UXP Developer Tools** (free, from Creative Cloud Desktop) to load the plugin
  in development mode.
- No network access, no CEP, no ExtendScript.

---

## Installing in development mode

1. Install **UXP Developer Tools** from the Creative Cloud desktop app.
2. Start Photoshop.
3. Open UXP Developer Tools → **Add Plugin…** → select this project's
   `manifest.json`.
4. In the plugin row, choose **Load**. Photoshop registers the panel.
5. In Photoshop: **Plugins ▸ Photoshop Auto Backup ▸ Auto Backup** to open the panel.
6. After editing the source, press **Reload** in UXP Developer Tools.

To package it for distribution, use **⋯ ▸ Package** in UXP Developer Tools, which
produces a `.ccx` file.

---

## First run

On first launch the panel shows a short onboarding screen:

1. It explains what the plugin does.
2. It asks for the main backup folder (UXP folder picker).
3. It sets the interval to 5 minutes.
4. It enables automatic backup.

You can postpone with **Set up later**; the plugin then stays idle until you pick
a folder with **Change**.

---

## Configuration

| Setting | Values | Default |
| --- | --- | --- |
| Automatic backup | ON / OFF | OFF (ON after onboarding) |
| Interval | 1, 2, 5, 10, 15, 30 minutes, or custom (1–1440) | 5 minutes |
| Mode | Per project / Single global folder | Per project |
| Backup folder | any folder you grant access to | — |
| Maximum backups | 1, 3, 5, 10, 20, Unlimited, or custom (1–10000) | 20 |
| Back up only if changed | on / off | on |

Each mode remembers its own folder: switching between "per project" and "global"
does not lose the other folder's permission.

**Back up now** always writes a copy, even when the document has not changed.

---

## How retention works

When a backup completes:

1. The plugin lists the files in the destination folder.
2. It keeps only the ones matching the exact backup pattern **for that project**:
   `<ProjectName>_YYYY-MM-DD_HH-mm-ss[_n].psd|psb`.
3. It sorts them chronologically (from the timestamp in the name).
4. It deletes the oldest ones beyond the limit.

Nothing else is ever deleted — not the original project file, not other
documents' backups, not unrelated files that happen to live in the same folder.
Setting the limit to **Unlimited** disables deletion entirely.

---

## Change detection

The "back up only if changed" option compares `document.activeHistoryState.id`
with the value stored at the previous backup for that project.

`document.saved` is deliberately **not** used as the criterion: a
`saveAs(..., asCopy = true)` does not (and must not) mark the original document
as saved, so `saved` would give the wrong answer in both directions.

**Known limits — please read:**

- Undoing back to a state that already existed reproduces an id that was already
  seen, so the document can look "unchanged" while differing from the last
  backup. A manual **Back up now** always overrides this.
- Operations that do not push a new history state are not detected.
- If the history state cannot be read at all, the plugin behaves conservatively
  and performs the backup.

If you want a guaranteed copy at every interval, turn this option off.

---

## Supported documents

| Document | Behaviour |
| --- | --- |
| Local PSD | Backed up as PSD |
| Local PSB | Backed up as PSB |
| Never saved (no path yet) | Skipped, with an explicit message asking you to save once first |
| Photoshop cloud document | Skipped, with an explicit message |
| Any other format (JPG, TIFF, PNG…) | Skipped as unsupported |

Nothing fails silently: every skip and every error is shown in the panel and
written to the log.

---

## UXP limitations you should know about

**File system access.** A UXP plugin has no arbitrary file system access. Every
folder must be granted by the user through the UXP picker. The grant is stored
as a *persistent token* (`createPersistentToken` / `getEntryForPersistentToken`)
so it survives Photoshop restarts, but a token can stop resolving when the folder
is moved or deleted, or the drive is unplugged. When that happens the plugin
reports "backup folder is no longer reachable" and you simply pick the folder
again.

**Unsaved documents.** A never-saved document has no path, so there is no
reliable project identity and no format to preserve. UXP offers no way to derive
one, so these documents are skipped with a clear message rather than guessed at.

**Cloud documents.** For a Photoshop cloud document, `document.path` returns a
cloud identifier rather than a file path, and `saveAs` to a local file is not a
supported round-trip for keeping the cloud document intact. These are skipped.

**Panel lifecycle and timers.** The interval is driven by a `setInterval` living
in a module, not in the panel DOM, so:

- hiding or collapsing the panel does **not** stop the timer;
- reopening the panel resynchronises the UI with the real state;
- but if Photoshop **unloads** the plugin, or the plugin is not loaded at all,
  no JavaScript runs and no backup happens.

**This is therefore not a true background service.** UXP does not guarantee code
execution while a plugin is unloaded, and this plugin does not pretend otherwise.
Keep the panel open (docked is fine) if you want the timer to be reliable.

**Modal state.** `saveAs` runs inside `executeAsModal`. If Photoshop is already
in a modal state — a dialog is open, a transform is in progress, a brush stroke
is being drawn — the request is refused with error number 9. The plugin treats
this as a *skip*, not a failure, and retries at the next interval.

---

## Multi-document behaviour

Photoshop can have several documents open. This version backs up **the document
that is active when the backup runs**, and the panel always shows which project
that is.

The architecture is ready for "back up all open documents":

- state is keyed per project (`settings.projects[projectKey]`), never global;
- `backupManager.runBackup({ document })` already accepts an explicit document;
- `documentManager.getOpenDocuments()` already enumerates them.

Adding the feature means looping over the open documents inside the timer runner;
no rewrite is required.

---

## Concurrency

`backupManager` holds an internal lock. If a save takes longer than the interval,
the next tick finds the lock held and skips that cycle instead of starting a
second save. `timerManager` additionally recomputes the next run time only after
the previous run has finished.

---

## Error handling

Handled explicitly, each with its own message in the panel:

no document open · document never saved · cloud document · unsupported format ·
no backup folder configured · backup folder unavailable · persistent token no
longer valid · subfolder creation failure · file creation failure · name
collision · `saveAs` failure · Photoshop busy in a modal state · not enough disk
space · document closed mid-backup · active document changed mid-backup ·
backup already running · plugin restarted · Photoshop restarted.

Errors surface in three places: the red status dot, the "Last error" box, and the
log list.

---

## Status indicator

| Indicator | Meaning |
| --- | --- |
| 🟢 Active | Automatic backup on, folder available, supported document |
| 🔵 Backing up… | A backup is running right now |
| 🟡 Idle | Automatic backup off, no folder configured, or no supported document |
| 🔴 Error | The last operation failed; details in "Last error" |

Successful backups are never announced with an intrusive dialog — they only
update the panel and the log.

---

## Where settings are stored

Settings live in `localStorage` under the key
`com.lusprite.photoshop.autobackup.settings.v1`:

```
enabled, intervalMinutes, backupMode, projectRootFolderToken,
globalBackupFolderToken, maxBackups, backupOnlyIfChanged, onboardingDone,
projects { <projectKey>: { name, folderName, lastBackupAt,
                           lastBackupFileName, lastBackupFolderPath,
                           lastSignature } }
```

Folder access is stored **only** as a persistent token; the readable path shown in
the panel is resolved from the token at runtime and is not the source of truth.

---

## Debugging

- Open the UXP Developer Tools console for this plugin (**⋯ ▸ Debug**). All log
  lines are prefixed with `[AutoBackup]`.
- The panel's own log list shows the last 60 events with timestamps and project
  names.
- To force a full reset, clear the storage key from the console:
  ```js
  localStorage.removeItem("com.lusprite.photoshop.autobackup.settings.v1");
  ```
  then reload the plugin.

---

## Project structure

```
photoshop-auto-backup/
├── manifest.json          manifest v5, panel entrypoint, permissions
├── index.html             panel markup (Spectrum UXP components)
├── style.css              compact panel styling
├── README.md
└── src/
    ├── main.js            entrypoint, wiring, UI handlers, lifecycle
    ├── backupManager.js   backup execution, file naming, lock, PSD/PSB
    ├── documentManager.js active document, state, format, change detection
    ├── projectManager.js  project identity, folder resolution, subfolders
    ├── storageManager.js  localStorage + UXP file system and persistent tokens
    ├── settingsManager.js defaults, validation, per-project state
    ├── retentionManager.js backup discovery, ordering, safe deletion
    ├── timerManager.js    interval, start/stop/restart, countdown
    ├── ui.js              DOM rendering only
    ├── logger.js          in-memory log and console forwarding
    └── errors.js          error codes and user-facing messages
```

---

## Photoshop UXP APIs used

| Purpose | API |
| --- | --- |
| Active document | `require("photoshop").app.activeDocument` |
| Open documents | `app.documents` |
| Name / path / format | `Document.title`, `Document.path` |
| Cloud document | `Document.cloudDocument` |
| Change detection | `Document.activeHistoryState.id` |
| Save a copy | `Document.saveAs.psd(file, options, true)` / `.psb(...)` |
| Modal execution | `require("photoshop").core.executeAsModal(fn, opts)` |
| Folder picker | `require("uxp").storage.localFileSystem.getFolder()` |
| Permission persistence | `createPersistentToken()` / `getEntryForPersistentToken()` |
| Folder contents | `Folder.getEntries()`, `Folder.createEntry(name, {type})` |
| File creation | `Folder.createFile(name, { overwrite: false })` |
| Deletion | `Entry.delete()` |
| Open folder in file explorer | `require("uxp").shell.openPath(path, developerText)` |
| Panel lifecycle | `require("uxp").entrypoints.setup({ panels })` |

`shell.openPath()` requires `requiredPermissions.launchProcess` to be declared
in the manifest. Opening a plain folder (no file extension) additionally
requires an empty string `""` in `launchProcess.extensions` — without it,
Photoshop rejects the call with `Extension "" is not accepted for the path
...`. The first call also shows the user a one-time native consent dialog.

`batchPlay` is not used: every operation this plugin needs is available through
the documented DOM API.

---

## Safety guarantees

The plugin does not, at any point:

- modify, rename or move the original document;
- change the document's path or its saved state (`asCopy = true`);
- make the backup the active document;
- overwrite any existing file (`overwrite: false`, plus a name counter);
- delete anything that does not match its own backup naming pattern for the
  project being backed up.
