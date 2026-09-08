"use strict";

/**
 * backupManager.js
 * Runs a backup: validation, file name generation, saving the copy, updating
 * the project state and applying retention.
 *
 * Photoshop UXP APIs used:
 *   core.executeAsModal(fn, { commandName, timeOut })
 *   document.saveAs.psd(file, options, asCopy)
 *   document.saveAs.psb(file, options, asCopy)
 *
 * `asCopy = true` is the crucial part: Photoshop writes a copy and does NOT
 * re-associate the open document with the new file. The original project keeps
 * its name, path and state.
 */

const photoshop = require("photoshop");

const logger = require("./logger.js");
const storageManager = require("./storageManager.js");
const settingsManager = require("./settingsManager.js");
const documentManager = require("./documentManager.js");
const projectManager = require("./projectManager.js");
const retentionManager = require("./retentionManager.js");
const { BackupError, CODES, fromNative, describe: describeError } = require("./errors.js");

const core = photoshop.core;

const MAX_NAME_ATTEMPTS = 50;

/** Global lock: one backup at a time, whatever triggered it. */
const lock = { busy: false, since: 0, project: null };

const listeners = new Set();

const RESULT = { OK: "ok", SKIPPED: "skipped", ERROR: "error" };

function notify(event) {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch (err) {
            console.error("[AutoBackup] Backup listener failed:", err);
        }
    }
}

function pad(value) {
    return String(value).padStart(2, "0");
}

/** Local timestamp in the YYYY-MM-DD_HH-mm-ss format. */
function formatTimestamp(date) {
    const d = date || new Date();
    const datePart = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    const timePart = pad(d.getHours()) + "-" + pad(d.getMinutes()) + "-" + pad(d.getSeconds());
    return datePart + "_" + timePart;
}

function buildFileName(baseName, timestamp, format, attempt) {
    const suffix = attempt > 0 ? "_" + attempt : "";
    return baseName + "_" + timestamp + suffix + "." + format;
}

/**
 * Creates the destination file without ever overwriting anything.
 * When the name is taken a counter is appended (_1, _2, ...).
 */
async function createTargetFile(folder, baseName, format) {
    const timestamp = formatTimestamp(new Date());

    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
        const name = buildFileName(baseName, timestamp, format, attempt);
        const file = await storageManager.createFileExclusive(folder, name);
        if (file) {
            return { file: file, name: name };
        }
    }

    throw new BackupError(CODES.NAME_COLLISION, baseName);
}

/**
 * Saves the copy. It must run inside executeAsModal because saveAs changes
 * Photoshop state.
 */
async function saveCopy(doc, file, format) {
    const saveOptions = {
        alphaChannels: true,
        annotations: true,
        embedColorProfile: true,
        layers: true,
        spotColors: true
    };

    await core.executeAsModal(
        async () => {
            if (format === documentManager.FORMATS.PSB) {
                await doc.saveAs.psb(file, saveOptions, true);
            } else {
                await doc.saveAs.psd(file, saveOptions, true);
            }
        },
        { commandName: "Photoshop Auto Backup", timeOut: 20 }
    );
}

async function removeFailedPlaceholder(file, name) {
    try {
        await storageManager.deleteEntry(file);
    } catch (err) {
        console.warn("[AutoBackup] Could not remove the incomplete file:", name, err);
    }
}

/**
 * Runs one backup.
 * @param {{trigger?: string, force?: boolean, document?: object}} options
 *        trigger:  "manual" | "auto"
 *        force:    ignore the "only if changed" option
 *        document: a specific document (groundwork for multi-document backup)
 * @returns {Promise<object>} { status, code?, message?, fileName?, project? }
 */
async function runBackup(options) {
    const opts = options || {};
    const trigger = opts.trigger || "manual";

    if (lock.busy) {
        const suffix = lock.project ? " (" + lock.project + ")" : "";
        const message = "A backup is already running" + suffix + "; this run was skipped.";
        if (trigger === "manual") {
            logger.warn(message);
        } else {
            console.log("[AutoBackup] " + message);
        }
        return { status: RESULT.SKIPPED, code: CODES.BACKUP_IN_PROGRESS, message: message };
    }

    lock.busy = true;
    lock.since = Date.now();
    lock.project = null;
    notify({ type: "start", trigger: trigger });

    let descriptor = null;

    try {
        // 1. Reference document, captured ONCE: if the user switches the active
        //    document while saving, we keep working on this one.
        const doc = opts.document || documentManager.getActiveDocument();
        const info = documentManager.describe(doc);

        if (!info.supported) {
            const error = new BackupError(info.reason || CODES.NO_DOCUMENT);
            if (trigger === "manual") {
                logger.error(error.message);
            } else {
                console.log("[AutoBackup] Automatic backup skipped: " + error.message);
            }
            return { status: RESULT.SKIPPED, code: error.code, message: error.message };
        }

        descriptor = projectManager.getProjectDescriptor(info);
        lock.project = descriptor.name;

        const settings = settingsManager.get();
        const projectState = settingsManager.getProjectState(descriptor.key);

        // 2. Change detection.
        const signature = documentManager.getChangeSignature(info.document);
        if (
            settings.backupOnlyIfChanged &&
            opts.force !== true &&
            signature &&
            projectState &&
            projectState.lastSignature === signature
        ) {
            const message = "No changes since the last backup; nothing to do.";
            if (trigger === "manual") {
                logger.info(message, { project: descriptor.name });
            } else {
                console.log("[AutoBackup] " + message);
            }
            return {
                status: RESULT.SKIPPED,
                code: "NO_CHANGES",
                message: message,
                project: descriptor.name
            };
        }

        // 3. Destination folder (creates the project subfolder when needed).
        const folder = await projectManager.resolveBackupFolder(descriptor, settings);

        // 4. The document may have been closed while we resolved the folder.
        if (info.id !== null && !documentManager.isDocumentOpen(info.id)) {
            throw new BackupError(CODES.DOCUMENT_CLOSED, descriptor.name);
        }

        // 5. Collision-free destination file.
        const target = await createTargetFile(folder, descriptor.baseFileName, info.format);

        // 6. Save the copy.
        try {
            await saveCopy(info.document, target.file, info.format);
        } catch (err) {
            await removeFailedPlaceholder(target.file, target.name);
            throw fromNative(err, CODES.SAVE_FAILED);
        }

        // 7. Project state (one per project, never a shared variable).
        const folderPath = storageManager.getNativePath(folder);
        settingsManager.setProjectState(descriptor.key, {
            name: descriptor.name,
            folderName: descriptor.folderName,
            lastBackupAt: Date.now(),
            lastBackupFileName: target.name,
            lastBackupFolderPath: folderPath,
            lastSignature: signature || ""
        });

        logger.success("Backup created: " + target.name, { project: descriptor.name });

        // 8. Retention: a failure here does not invalidate the backup just made.
        let retention = { deleted: [], failed: [], total: 0 };
        try {
            retention = await retentionManager.applyRetention(
                folder,
                descriptor.baseFileName,
                settings.maxBackups
            );
            if (retention.failed.length > 0) {
                logger.warn(
                    "Could not delete " + retention.failed.length + " older backup(s).",
                    { project: descriptor.name }
                );
            }
        } catch (err) {
            logger.warn("Retention was not applied: " + describeError(err), {
                project: descriptor.name
            });
        }

        const result = {
            status: RESULT.OK,
            fileName: target.name,
            folderPath: folderPath,
            project: descriptor.name,
            deleted: retention.deleted.length
        };
        notify({ type: "success", result: result });
        return result;
    } catch (err) {
        const backupError = err instanceof BackupError ? err : fromNative(err, CODES.UNKNOWN);
        const project = descriptor ? descriptor.name : null;

        if (backupError.code === CODES.MODAL_BUSY) {
            // Not a real failure: Photoshop was busy. It is retried next cycle.
            logger.warn(backupError.message, { project: project });
            const skipped = {
                status: RESULT.SKIPPED,
                code: backupError.code,
                message: backupError.message,
                project: project
            };
            notify({ type: "skipped", result: skipped });
            return skipped;
        }

        logger.error(describeError(backupError), { project: project, error: backupError.cause });
        const failure = {
            status: RESULT.ERROR,
            code: backupError.code,
            message: backupError.message,
            project: project
        };
        notify({ type: "error", result: failure });
        return failure;
    } finally {
        lock.busy = false;
        lock.project = null;
        notify({ type: "end", trigger: trigger });
    }
}

function isBusy() {
    return lock.busy;
}

module.exports = {
    RESULT,
    runBackup,
    isBusy,
    formatTimestamp,
    buildFileName,
    onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
};
