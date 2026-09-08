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

const ALLOWED_INTERVALS = [1, 2, 5, 10, 15, 30];
const ALLOWED_MAX_BACKUPS = [1, 3, 5, 10, 20, 0]; // 0 = unlimited

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

const DEFAULTS = {
    version: 1,
    enabled: false,
    intervalMinutes: 5,
    backupMode: BACKUP_MODES.PER_PROJECT,
    projectRootFolderToken: null,
    globalBackupFolderToken: null,
    maxBackups: 20,
    backupOnlyIfChanged: true,
    onboardingDone: false,
    projects: {}
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

    result.projectRootFolderToken =
        typeof raw.projectRootFolderToken === "string" && raw.projectRootFolderToken
            ? raw.projectRootFolderToken
            : null;

    result.globalBackupFolderToken =
        typeof raw.globalBackupFolderToken === "string" && raw.globalBackupFolderToken
            ? raw.globalBackupFolderToken
            : null;

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
    const merged = validate(Object.assign({}, current, patch || {}));
    merged.projects = projects; // project state is only changed by the dedicated methods
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

/* ------------------------- Folders ----------------------------- */

/** Token of the folder that belongs to the active mode. */
function getActiveFolderToken(settings) {
    const data = settings || ensureLoaded();
    return data.backupMode === BACKUP_MODES.GLOBAL
        ? data.globalBackupFolderToken
        : data.projectRootFolderToken;
}

function setActiveFolderToken(token) {
    ensureLoaded();
    const patch = {};
    if (current.backupMode === BACKUP_MODES.GLOBAL) {
        patch.globalBackupFolderToken = token;
    } else {
        patch.projectRootFolderToken = token;
    }
    return update(patch);
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
    getActiveFolderToken,
    setActiveFolderToken,
    reset,
    onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
};
