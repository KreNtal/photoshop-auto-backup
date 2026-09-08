"use strict";

/**
 * storageManager.js
 * The single point of contact with:
 *  - localStorage (settings persistence, available in UXP)
 *  - uxp.storage.localFileSystem (pickers, persistent tokens, disk entries)
 *  - uxp.shell (handing a native path to the OS file explorer)
 *
 * UXP note: a plugin has no arbitrary file system access. Every folder must be
 * granted by the user through the picker; the grant is then kept with
 * createPersistentToken() and restored with getEntryForPersistentToken().
 * A token can become invalid (folder moved or deleted, drive unplugged), so
 * failure must always be handled.
 */

const uxp = require("uxp");
const logger = require("./logger.js");
const { BackupError, CODES, fromNative } = require("./errors.js");

const fs = uxp.storage.localFileSystem;
const entryTypes = uxp.storage.types;
const shell = uxp.shell;

const STORAGE_KEY = "com.lusprite.photoshop.autobackup.settings.v1";

/* ------------------------------------------------------------------ */
/* Settings (localStorage)                                             */
/* ------------------------------------------------------------------ */

function readSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
        logger.warn("Stored settings could not be read; defaults will be used.");
        console.warn("[AutoBackup] readSettings:", err);
        return null;
    }
}

function writeSettings(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return true;
    } catch (err) {
        logger.error("Could not save the plugin settings.", { error: err });
        return false;
    }
}

function clearSettings() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
        console.warn("[AutoBackup] clearSettings:", err);
    }
}

/* ------------------------------------------------------------------ */
/* Folders and persistent tokens                                       */
/* ------------------------------------------------------------------ */

/**
 * Opens the system folder picker.
 * When the user cancels, getFolder() resolves to null (it does not throw),
 * so any exception here is a real failure and is left to propagate to the
 * caller instead of being swallowed.
 * @returns {Promise<Folder|null>} null when the user cancels.
 */
async function pickFolder() {
    const folder = await fs.getFolder();
    return folder || null;
}

async function createToken(entry) {
    try {
        return await fs.createPersistentToken(entry);
    } catch (err) {
        logger.warn("Could not create a persistent token for the selected folder.");
        console.warn("[AutoBackup] createToken:", err);
        return null;
    }
}

/**
 * Restores a folder from a persistent token.
 * It also verifies the folder is really readable: a token can resolve while
 * pointing at a location that is no longer available.
 * @returns {Promise<Folder|null>}
 */
async function resolveFolderToken(token) {
    if (!token) {
        return null;
    }
    try {
        const entry = await fs.getEntryForPersistentToken(token);
        if (!entry || !entry.isFolder) {
            return null;
        }
        await entry.getEntries(); // real accessibility check
        return entry;
    } catch (err) {
        console.warn("[AutoBackup] resolveFolderToken:", err);
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Folder and file operations                                          */
/* ------------------------------------------------------------------ */

async function listEntries(folder) {
    try {
        const entries = await folder.getEntries();
        return Array.isArray(entries) ? entries : [];
    } catch (err) {
        throw fromNative(err, CODES.FOLDER_UNAVAILABLE);
    }
}

/**
 * Returns the subfolder with the given name, creating it when missing.
 * The comparison is case insensitive because Windows and macOS do not
 * distinguish case in folder names.
 */
async function getOrCreateSubfolder(parentFolder, name) {
    const entries = await listEntries(parentFolder);
    const wanted = name.toLowerCase();

    for (const entry of entries) {
        if (entry.isFolder && String(entry.name).toLowerCase() === wanted) {
            return entry;
        }
    }

    try {
        return await parentFolder.createEntry(name, { type: entryTypes.folder });
    } catch (err) {
        // Some builds also expose createFolder(); try it as a fallback.
        if (typeof parentFolder.createFolder === "function") {
            try {
                return await parentFolder.createFolder(name);
            } catch (innerErr) {
                throw new BackupError(CODES.SUBFOLDER_FAILED, name, innerErr);
            }
        }
        throw new BackupError(CODES.SUBFOLDER_FAILED, name, err);
    }
}

/**
 * Creates a file and never overwrites: if the name is taken the call fails and
 * the caller has to try a different name.
 * @returns {Promise<File|null>} null when the name is already in use.
 */
async function createFileExclusive(folder, name) {
    try {
        return await folder.createFile(name, { overwrite: false });
    } catch (err) {
        const message = err && err.message ? String(err.message).toLowerCase() : "";
        if (message.indexOf("exist") >= 0) {
            return null;
        }
        // The failure may be a collision or a write error: if the file really
        // exists, treat it as a collision.
        const existing = await fileExists(folder, name);
        if (existing) {
            return null;
        }
        throw fromNative(err, CODES.FILE_CREATION_FAILED);
    }
}

async function fileExists(folder, name) {
    try {
        const entries = await folder.getEntries();
        const wanted = name.toLowerCase();
        return entries.some((entry) => entry.isFile && String(entry.name).toLowerCase() === wanted);
    } catch (err) {
        console.warn("[AutoBackup] fileExists:", err);
        return false;
    }
}

async function deleteEntry(entry) {
    await entry.delete();
}

async function getEntryMetadata(entry) {
    try {
        return await entry.getMetadata();
    } catch (err) {
        console.warn("[AutoBackup] getEntryMetadata:", err);
        return null;
    }
}

/**
 * Reads the "version" field from the plugin's own manifest.json, so the
 * panel can show it without the value having to be duplicated and kept in
 * sync by hand. `getPluginFolder()` gives read-only access to the plugin's
 * install directory regardless of the localFileSystem permission level.
 * @returns {Promise<string|null>} null if it could not be read.
 */
async function getPluginVersion() {
    try {
        const pluginFolder = await fs.getPluginFolder();
        const entry = await pluginFolder.getEntry("manifest.json");
        const text = await entry.read();
        const manifest = JSON.parse(text);
        return typeof manifest.version === "string" ? manifest.version : null;
    } catch (err) {
        console.warn("[AutoBackup] getPluginVersion:", err);
        return null;
    }
}

function getNativePath(entry) {
    try {
        return entry && entry.nativePath ? String(entry.nativePath) : "";
    } catch (err) {
        return "";
    }
}

/**
 * Opens a native path in the OS file explorer (Explorer on Windows, Finder on
 * macOS). Photoshop shows the user a one-time consent dialog the first time a
 * given path is opened this way; `developerText` is the explanation shown in
 * that dialog.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function openInFileExplorer(nativePath, developerText) {
    if (!nativePath) {
        return { ok: false, error: "No folder path to open." };
    }
    if (!shell || typeof shell.openPath !== "function") {
        console.error("[AutoBackup] uxp.shell.openPath is not available in this environment.");
        return { ok: false, error: "Opening a folder in the file explorer is not supported here." };
    }
    try {
        const result = await shell.openPath(nativePath, developerText || "");
        // openPath resolves with "" on success, or an error message string.
        if (result) {
            console.warn("[AutoBackup] shell.openPath reported an error:", result);
            return { ok: false, error: result };
        }
        return { ok: true };
    } catch (err) {
        // Surface the real native message instead of guessing at a cause:
        // this path is not a folder-token failure, so the generic
        // FOLDER_UNAVAILABLE wording used elsewhere would be misleading here.
        console.error("[AutoBackup] shell.openPath threw:", err);
        return { ok: false, error: (err && err.message) || String(err) };
    }
}

module.exports = {
    STORAGE_KEY,
    readSettings,
    writeSettings,
    clearSettings,
    pickFolder,
    createToken,
    resolveFolderToken,
    listEntries,
    getOrCreateSubfolder,
    createFileExclusive,
    fileExists,
    deleteEntry,
    getEntryMetadata,
    getNativePath,
    getPluginVersion,
    openInFileExplorer
};
