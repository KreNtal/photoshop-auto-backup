"use strict";

/**
 * settingsManager.js
 * User settings plus per-project state, with defaults and validation.
 *
 * Project state lives in a `projects[projectKey]` map: there is no single
 * global "last backup" variable shared by every document.
 */

const storageManager = require("./storageManager.js");
const logger = require("./logger.js");

const BACKUP_MODES = { PER_PROJECT: "perProject", GLOBAL: "global" };

/** Which document(s) a backup cycle (automatic or "Backup now") targets. */
const DOCUMENT_SCOPES = { ACTIVE: "active", ALL_OPEN: "allOpen" };

const ALLOWED_INTERVALS = [1, 2, 5, 10, 15, 30];
const ALLOWED_MAX_BACKUPS = [1, 3, 5, 10, 20, 0]; // 0 = unlimited

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

const DEFAULTS = {
    version: 1,
    enabled: false,
    intervalMinutes: 5,
    backupMode: BACKUP_MODES.PER_PROJECT,
    backupFolderToken: null,
    documentScope: DOCUMENT_SCOPES.ACTIVE,
    maxBackups: 5,
    backupOnlyIfChanged: true,
    onboardingDone: false,
    projects: {},
    // Project keys the user chose to exclude ("never back this one up"), kept
    // separate from `projects` because exclusion is a preference that can be
    // set before a project has ever been backed up, unlike the fields in
    // `projects` which are all backup history.
    excludedProjects: {}
};

let current = null;
const listeners = new Set();

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeProjectState(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    return {
        name: typeof raw.name === "string" ? raw.name : "",
        folderName: typeof raw.folderName === "string" ? raw.folderName : "",
        lastBackupAt: toInt(raw.lastBackupAt, 0),
        lastBackupFileName: typeof raw.lastBackupFileName === "string" ? raw.lastBackupFileName : "",
        lastBackupFolderPath:
            typeof raw.lastBackupFolderPath === "string" ? raw.lastBackupFolderPath : "",
        lastSignature: typeof raw.lastSignature === "string" ? raw.lastSignature : ""
    };
}

/**
 * Normalises anything coming from localStorage into the expected shape.
 * Every out-of-range field falls back to its default: the plugin must never
 * start with inconsistent settings.
 */
function validate(raw) {
    const result = clone(DEFAULTS);
    if (!raw || typeof raw !== "object") {
        return result;
    }

    result.enabled = raw.enabled === true;

    const interval = toInt(raw.intervalMinutes, DEFAULTS.intervalMinutes);
    result.intervalMinutes =
        interval >= MIN_INTERVAL_MINUTES && interval <= MAX_INTERVAL_MINUTES
            ? interval
            : DEFAULTS.intervalMinutes;

    result.backupMode =
        raw.backupMode === BACKUP_MODES.GLOBAL ? BACKUP_MODES.GLOBAL : BACKUP_MODES.PER_PROJECT;

    result.documentScope =
        raw.documentScope === DOCUMENT_SCOPES.ALL_OPEN
            ? DOCUMENT_SCOPES.ALL_OPEN
            : DOCUMENT_SCOPES.ACTIVE;

    if (typeof raw.backupFolderToken === "string" && raw.backupFolderToken) {
        result.backupFolderToken = raw.backupFolderToken;
    } else {
        // Migration from the earlier per-mode tokens (< v1.2.0), which kept a
        // separate folder for "per project" and "global" mode. Both modes now
        // share a single folder, so pick whichever of the old tokens exists,
        // preferring the one matching the previously active mode.
        const legacyProject =
            typeof raw.projectRootFolderToken === "string" && raw.projectRootFolderToken
                ? raw.projectRootFolderToken
                : null;
        const legacyGlobal =
            typeof raw.globalBackupFolderToken === "string" && raw.globalBackupFolderToken
                ? raw.globalBackupFolderToken
                : null;
        const preferred = raw.backupMode === BACKUP_MODES.GLOBAL ? legacyGlobal : legacyProject;
        result.backupFolderToken = preferred || legacyProject || legacyGlobal || null;
    }

    const maxBackups = toInt(raw.maxBackups, DEFAULTS.maxBackups);
    result.maxBackups = maxBackups >= 0 && maxBackups <= 10000 ? maxBackups : DEFAULTS.maxBackups;

    result.backupOnlyIfChanged = raw.backupOnlyIfChanged !== false;
    result.onboardingDone = raw.onboardingDone === true;

    result.projects = {};
    if (raw.projects && typeof raw.projects === "object") {
        for (const key of Object.keys(raw.projects)) {
            const projectState = sanitizeProjectState(raw.projects[key]);
            if (projectState) {
                result.projects[key] = projectState;
            }
        }
    }

    result.excludedProjects = {};
    if (raw.excludedProjects && typeof raw.excludedProjects === "object") {
        for (const key of Object.keys(raw.excludedProjects)) {
            if (raw.excludedProjects[key] === true) {
                result.excludedProjects[key] = true;
            }
        }
    }

    return result;
}

function notify() {
    const data = get();
    for (const listener of listeners) {
        try {
            listener(data);
        } catch (err) {
            console.error("[AutoBackup] Settings listener failed:", err);
        }
    }
}

function load() {
    current = validate(storageManager.readSettings());
    return get();
}

function ensureLoaded() {
    if (!current) {
        load();
    }
    return current;
}

function get() {
    return clone(ensureLoaded());
}

function persist() {
    storageManager.writeSettings(current);
}

function update(patch, options) {
    ensureLoaded();
    const projects = current.projects;
    const excludedProjects = current.excludedProjects;
    const merged = validate(Object.assign({}, current, patch || {}));
    // Project history and exclusions are only changed by their dedicated methods.
    merged.projects = projects;
    merged.excludedProjects = excludedProjects;
    current = merged;
    persist();
    if (!options || options.silent !== true) {
        notify();
    }
    return get();
}

/* ---------------------- Per-project state ---------------------- */

function getProjectState(projectKey) {
    ensureLoaded();
    const state = current.projects[projectKey];
    return state ? clone(state) : null;
}

function setProjectState(projectKey, patch) {
    ensureLoaded();
    const previous = current.projects[projectKey] || {
        name: "",
        folderName: "",
        lastBackupAt: 0,
        lastBackupFileName: "",
        lastBackupFolderPath: "",
        lastSignature: ""
    };
    current.projects[projectKey] = sanitizeProjectState(Object.assign({}, previous, patch));
    persist();
    notify();
    return clone(current.projects[projectKey]);
}

function removeProjectState(projectKey) {
    ensureLoaded();
    if (current.projects[projectKey]) {
        delete current.projects[projectKey];
        persist();
        notify();
    }
}

/* --------------------- Per-project exclusion --------------------- */

function isProjectExcluded(projectKey) {
    ensureLoaded();
    return current.excludedProjects[projectKey] === true;
}

function setProjectExcluded(projectKey, excluded) {
    ensureLoaded();
    if (excluded) {
        current.excludedProjects[projectKey] = true;
    } else {
        delete current.excludedProjects[projectKey];
    }
    persist();
    notify();
}

/* ------------------------- Folders ----------------------------- */

/**
 * Token of the backup folder. Both modes ("per project" and "global") share
 * the same folder: only what the plugin does inside it differs (a subfolder
 * per project, or everything flat).
 */
function getActiveFolderToken(settings) {
    const data = settings || ensureLoaded();
    return data.backupFolderToken;
}

function setActiveFolderToken(token) {
    return update({ backupFolderToken: token });
}

function reset() {
    storageManager.clearSettings();
    current = clone(DEFAULTS);
    persist();
    notify();
    logger.info("Settings restored to their defaults.");
    return get();
}

module.exports = {
    BACKUP_MODES,
    DOCUMENT_SCOPES,
    ALLOWED_INTERVALS,
    ALLOWED_MAX_BACKUPS,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    DEFAULTS,
    load,
    get,
    update,
    getProjectState,
    setProjectState,
    removeProjectState,
    isProjectExcluded,
    setProjectExcluded,
    getActiveFolderToken,
    setActiveFolderToken,
    reset,
    onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
};
