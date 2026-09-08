"use strict";

/**
 * errors.js
 * Application error codes and their translation into human readable messages.
 * Everything the panel shows to the user goes through here so the wording
 * stays consistent.
 */

const CODES = {
    NO_DOCUMENT: "NO_DOCUMENT",
    UNSAVED_DOCUMENT: "UNSAVED_DOCUMENT",
    CLOUD_DOCUMENT: "CLOUD_DOCUMENT",
    UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
    NO_FOLDER_CONFIGURED: "NO_FOLDER_CONFIGURED",
    FOLDER_UNAVAILABLE: "FOLDER_UNAVAILABLE",
    SUBFOLDER_FAILED: "SUBFOLDER_FAILED",
    FILE_CREATION_FAILED: "FILE_CREATION_FAILED",
    NAME_COLLISION: "NAME_COLLISION",
    SAVE_FAILED: "SAVE_FAILED",
    MODAL_BUSY: "MODAL_BUSY",
    DOCUMENT_CLOSED: "DOCUMENT_CLOSED",
    BACKUP_IN_PROGRESS: "BACKUP_IN_PROGRESS",
    DISK_FULL: "DISK_FULL",
    RETENTION_FAILED: "RETENTION_FAILED",
    UNKNOWN: "UNKNOWN"
};

const MESSAGES = {
    NO_DOCUMENT: "No document is open in Photoshop.",
    UNSAVED_DOCUMENT:
        "This document has never been saved to disk. Save it once (File > Save As) so backups can be created.",
    CLOUD_DOCUMENT:
        "This is a Photoshop cloud document. UXP cannot write a local copy of it with saveAs: save it as a local PSD/PSB file to use automatic backups.",
    UNSUPPORTED_FORMAT: "Unsupported format. This version backs up PSD and PSB documents only.",
    NO_FOLDER_CONFIGURED: 'No backup folder configured. Press "Change" and pick a folder.',
    FOLDER_UNAVAILABLE:
        'The backup folder is no longer reachable (drive disconnected, folder moved, or the permission expired). Select it again with "Change".',
    SUBFOLDER_FAILED: "Could not create the project subfolder inside the backup folder.",
    FILE_CREATION_FAILED:
        "Could not create the backup file in the selected folder. Check write permissions.",
    NAME_COLLISION: "Could not find a free file name for the backup: too many name collisions.",
    SAVE_FAILED: "Photoshop failed to save the backup copy.",
    MODAL_BUSY:
        "Photoshop is busy with another modal operation (a dialog or an active tool). The backup will be retried at the next interval.",
    DOCUMENT_CLOSED: "The document was closed while the backup was running.",
    BACKUP_IN_PROGRESS: "A backup is already running.",
    DISK_FULL: "Not enough free disk space to complete the backup.",
    RETENTION_FAILED: "Backup created, but some older backups could not be deleted.",
    UNKNOWN: "An unexpected error occurred."
};

class BackupError extends Error {
    constructor(code, details, cause) {
        super(MESSAGES[code] || MESSAGES.UNKNOWN);
        this.name = "BackupError";
        this.code = code in MESSAGES ? code : CODES.UNKNOWN;
        this.details = details || null;
        this.cause = cause || null;
    }
}

/**
 * Translates a native error (Photoshop / UXP / file system) into a BackupError.
 * executeAsModal reports `number === 9` when Photoshop is already in a modal state.
 */
function fromNative(nativeError, fallbackCode) {
    if (nativeError instanceof BackupError) {
        return nativeError;
    }

    const message = nativeError && nativeError.message ? String(nativeError.message) : "";
    const lower = message.toLowerCase();

    if (nativeError && (nativeError.number === 9 || lower.indexOf("modal state") >= 0)) {
        return new BackupError(CODES.MODAL_BUSY, message, nativeError);
    }
    if (
        lower.indexOf("no space") >= 0 ||
        lower.indexOf("disk full") >= 0 ||
        lower.indexOf("enospc") >= 0
    ) {
        return new BackupError(CODES.DISK_FULL, message, nativeError);
    }

    return new BackupError(fallbackCode || CODES.UNKNOWN, message, nativeError);
}

function describe(error) {
    if (error instanceof BackupError) {
        return error.details ? error.message + " (" + error.details + ")" : error.message;
    }
    if (error && error.message) {
        return MESSAGES.UNKNOWN + " " + error.message;
    }
    return MESSAGES.UNKNOWN;
}

module.exports = { CODES, MESSAGES, BackupError, fromNative, describe };
