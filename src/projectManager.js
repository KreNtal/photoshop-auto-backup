"use strict";

/**
 * projectManager.js
 * Project identity and resolution of the destination folder.
 *
 * A "project" is a Photoshop document identified by its path on disk. The key
 * is normalised (uniform separators, lowercase) because on Windows the same
 * file can appear with different casing.
 */

const storageManager = require("./storageManager.js");
const settingsManager = require("./settingsManager.js");
const { BackupError, CODES } = require("./errors.js");

// Characters that are illegal in file names on Windows (macOS only rejects "/"
// and ":", so the strictest set is applied everywhere for portability).
const RESERVED_CHARS = '<>:"/|?*';
const BACKSLASH = String.fromCharCode(92);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function stripExtension(name) {
    if (!name) {
        return "";
    }
    const value = String(name);
    const dot = value.lastIndexOf(".");
    return dot > 0 ? value.substring(0, dot) : value;
}

/** Makes a name usable as a folder/file name on Windows and macOS. */
function sanitizeName(name) {
    const source = String(name || "");
    let cleaned = "";

    for (let index = 0; index < source.length; index += 1) {
        const char = source.charAt(index);
        const code = source.charCodeAt(index);
        const illegal = code < 32 || char === BACKSLASH || RESERVED_CHARS.indexOf(char) >= 0;
        cleaned += illegal ? "_" : char;
    }

    let result = cleaned
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "");

    if (!result) {
        result = "Document";
    }
    if (RESERVED_WINDOWS_NAMES.test(result)) {
        result = "_" + result;
    }
    if (result.length > 80) {
        result = result.substring(0, 80).trim();
    }
    return result;
}

/**
 * Stable project descriptor built from the document information.
 * @param {object} info result of documentManager.describe()
 */
function getProjectDescriptor(info) {
    const rawName = stripExtension(info.title) || stripExtension(info.path) || "Document";
    const safeName = sanitizeName(rawName);

    const key = info.path
        ? "path:" + String(info.path).split(BACKSLASH).join("/").toLowerCase()
        : "title:" + safeName.toLowerCase();

    return {
        key: key,
        name: rawName,
        folderName: safeName,
        baseFileName: safeName,
        format: info.format,
        sourcePath: info.path
    };
}

/**
 * Folder the backup of this project has to be written to.
 * - "perProject" mode: <chosen root>/<project name>/
 * - "global" mode:     <chosen folder>/
 *
 * @throws {BackupError} NO_FOLDER_CONFIGURED | FOLDER_UNAVAILABLE | SUBFOLDER_FAILED
 */
async function resolveBackupFolder(descriptor, settings) {
    const token = settingsManager.getActiveFolderToken(settings);
    if (!token) {
        throw new BackupError(CODES.NO_FOLDER_CONFIGURED);
    }

    const rootFolder = await storageManager.resolveFolderToken(token);
    if (!rootFolder) {
        throw new BackupError(CODES.FOLDER_UNAVAILABLE);
    }

    if (settings.backupMode === settingsManager.BACKUP_MODES.GLOBAL) {
        return rootFolder;
    }

    return storageManager.getOrCreateSubfolder(rootFolder, descriptor.folderName);
}

/** Readable path of the folder configured for the active mode. */
async function getConfiguredFolderPath(settings) {
    const token = settingsManager.getActiveFolderToken(settings);
    if (!token) {
        return null;
    }
    const folder = await storageManager.resolveFolderToken(token);
    if (!folder) {
        return null;
    }
    return storageManager.getNativePath(folder);
}

module.exports = {
    stripExtension,
    sanitizeName,
    getProjectDescriptor,
    resolveBackupFolder,
    getConfiguredFolderPath
};
