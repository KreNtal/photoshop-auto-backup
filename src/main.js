"use strict";

/**
 * main.js
 * Plugin entry point: wires the panel entrypoint, the settings, the timer and
 * the UI together.
 *
 * Lifecycle notes (see the README for the full explanation):
 *  - the timer and every manager live at module scope, so they survive the
 *    panel being hidden; the panel `show` handler only resynchronises the UI;
 *  - UXP gives no guarantee that JavaScript keeps running once Photoshop
 *    unloads the plugin, so this is not a true background service.
 */

// main.js is loaded via a plain <script src="src/main.js"> tag in index.html,
// not via require() from another module. UXP therefore does not know this
// script's own folder and resolves its relative requires against the plugin
// root ("./"), not against "./src/" — even though the file physically lives
// in src/. Every module required from here must be reached through "./src/".
// Modules inside src/ that require each other (e.g. backupManager.js ->
// "./errors.js") are unaffected: they are loaded via require() from another
// src/ module, so their own base folder is correctly tracked as "./src/".
const { entrypoints } = require("uxp");

const logger = require("./src/logger.js");
const storageManager = require("./src/storageManager.js");
const settingsManager = require("./src/settingsManager.js");
const documentManager = require("./src/documentManager.js");
const projectManager = require("./src/projectManager.js");
const backupManager = require("./src/backupManager.js");
const timerManager = require("./src/timerManager.js");
const ui = require("./src/ui.js");
const { MESSAGES } = require("./src/errors.js");

const PANEL_ID = "autoBackupPanel";

const runtime = {
    initialised: false,
    uiReady: false,
    panelVisible: false,
    folderPath: null,
    folderMissing: false,
    lastResult: null,
    lastErrorMessage: null
};

/* ------------------------------------------------------------------ */
/* Panel entrypoint                                                    */
/* ------------------------------------------------------------------ */

entrypoints.setup({
    panels: {
        [PANEL_ID]: {
            create() {
                // The DOM already exists (index.html): nothing to build here.
            },
            show() {
                runtime.panelVisible = true;
                refreshAll();
            },
            hide() {
                // The timer deliberately keeps running while the panel is hidden.
                runtime.panelVisible = false;
            },
            destroy() {
                runtime.panelVisible = false;
            }
        }
    }
});

/* ------------------------------------------------------------------ */
/* Folder handling                                                     */
/* ------------------------------------------------------------------ */

async function refreshFolderPath() {
    const settings = settingsManager.get();
    const token = settingsManager.getActiveFolderToken(settings);

    if (!token) {
        runtime.folderPath = null;
        runtime.folderMissing = false;
        return null;
    }

    const path = await projectManager.getConfiguredFolderPath(settings);
    runtime.folderPath = path || null;
    runtime.folderMissing = !path;

    if (runtime.folderMissing) {
        runtime.lastErrorMessage = MESSAGES.FOLDER_UNAVAILABLE;
    }
    return runtime.folderPath;
}

/**
 * Opens the picker and stores the chosen folder for the active mode.
 * Any failure (including one thrown by the native picker itself) is turned
 * into a message the caller can show, instead of failing silently.
 * @returns {Promise<{ok: boolean, cancelled: boolean, error?: string}>}
 */
async function pickAndStoreFolder() {
    let folder;
    try {
        folder = await storageManager.pickFolder();
    } catch (err) {
        console.error("[AutoBackup] Folder picker failed:", err);
        return { ok: false, cancelled: false, error: "Could not open the folder picker: " + (err && err.message ? err.message : String(err)) };
    }

    if (!folder) {
        return { ok: false, cancelled: true };
    }

    const token = await storageManager.createToken(folder);
    if (!token) {
        runtime.lastErrorMessage =
            "The folder was selected but the permission could not be stored. It may have to be picked again after restarting Photoshop.";
    }

    settingsManager.setActiveFolderToken(token || null);
    runtime.folderPath = storageManager.getNativePath(folder);
    runtime.folderMissing = false;

    logger.info("Backup folder set: " + runtime.folderPath);
    await refreshFolderPath();
    refreshAll();
    return { ok: true, cancelled: false };
}

/* ------------------------------------------------------------------ */
/* Backup runner                                                       */
/* ------------------------------------------------------------------ */

async function runBackup(trigger, force) {
    const result = await backupManager.runBackup({ trigger: trigger, force: force === true });
    runtime.lastResult = result;

    if (result.status === backupManager.RESULT.ERROR) {
        runtime.lastErrorMessage = result.message;
    } else if (result.status === backupManager.RESULT.OK) {
        runtime.lastErrorMessage = null;
    }

    refreshAll();
    return result;
}

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

function getCurrentProject() {
    const info = documentManager.describeActiveDocument();
    if (!info.supported) {
        return { info: info, descriptor: null, state: null };
    }
    const descriptor = projectManager.getProjectDescriptor(info);
    return {
        info: info,
        descriptor: descriptor,
        state: settingsManager.getProjectState(descriptor.key)
    };
}

function describeOpenDocuments() {
    const infos = documentManager.getOpenDocuments().map((doc) => documentManager.describe(doc));
    const eligible = infos.filter((info) => {
        if (!info.supported) {
            return false;
        }
        const key = projectManager.getProjectDescriptor(info).key;
        return !settingsManager.isProjectExcluded(key);
    }).length;
    return { total: infos.length, supported: eligible };
}

function describeDocumentLine(current, settings) {
    if (settings.documentScope === settingsManager.DOCUMENT_SCOPES.ALL_OPEN) {
        const open = describeOpenDocuments();
        if (open.total === 0) {
            return MESSAGES.NO_DOCUMENT;
        }
        const noun = open.total === 1 ? "document" : "documents";
        return open.total + " open " + noun + " (" + open.supported + " eligible for backup)";
    }
    if (current.info.supported) {
        return current.descriptor.name + " (" + current.info.format.toUpperCase() + ")";
    }
    return MESSAGES[current.info.reason] || MESSAGES.NO_DOCUMENT;
}

/** Most recently created backup across every tracked project. */
function findMostRecentBackup(settings) {
    let best = null;
    for (const key of Object.keys(settings.projects)) {
        const state = settings.projects[key];
        if (state.lastBackupAt && (!best || state.lastBackupAt > best.lastBackupAt)) {
            best = state;
        }
    }
    return best;
}

function describeLastBackup(current, settings) {
    if (settings.documentScope === settingsManager.DOCUMENT_SCOPES.ALL_OPEN) {
        const best = findMostRecentBackup(settings);
        if (!best) {
            return "No backup yet";
        }
        return best.lastBackupFileName + "  ·  " + ui.formatClock(best.lastBackupAt);
    }
    if (!current.state || !current.state.lastBackupAt) {
        return "No backup yet for this project";
    }
    return current.state.lastBackupFileName + "  ·  " + ui.formatClock(current.state.lastBackupAt);
}

function describeNextBackup(settings) {
    if (!settings.enabled || !timerManager.isRunning()) {
        return "Automatic backup is off";
    }
    if (backupManager.isBusy()) {
        return "running now";
    }
    return timerManager.formatRemaining(timerManager.getRemainingMs());
}

function computeStatus(settings, current) {
    if (backupManager.isBusy()) {
        return { kind: ui.STATUS.WORKING, text: "Backing up…" };
    }
    if (runtime.lastErrorMessage) {
        return { kind: ui.STATUS.ERROR, text: "Error" };
    }
    if (!settingsManager.getActiveFolderToken(settings)) {
        return { kind: ui.STATUS.IDLE, text: "No backup folder configured" };
    }
    if (!settings.enabled) {
        return { kind: ui.STATUS.IDLE, text: "Automatic backup off" };
    }
    if (settings.documentScope === settingsManager.DOCUMENT_SCOPES.ALL_OPEN) {
        if (describeOpenDocuments().supported === 0) {
            return { kind: ui.STATUS.IDLE, text: "Waiting for a supported document" };
        }
    } else if (!current.info.supported) {
        return { kind: ui.STATUS.IDLE, text: "Waiting for a supported document" };
    } else if (settingsManager.isProjectExcluded(current.descriptor.key)) {
        return { kind: ui.STATUS.IDLE, text: "Active document is excluded" };
    }
    return { kind: ui.STATUS.ACTIVE, text: "Active" };
}

function refreshDynamic() {
    if (!runtime.uiReady || !runtime.panelVisible) {
        return;
    }
    const settings = settingsManager.get();
    const current = getCurrentProject();

    ui.setDocumentInfo(describeDocumentLine(current, settings));
    ui.setExcludeCheckbox(
        current.info.supported ? settingsManager.isProjectExcluded(current.descriptor.key) : false,
        !current.info.supported
    );
    ui.setLastBackup(describeLastBackup(current, settings));
    ui.setNextBackup(describeNextBackup(settings));
    ui.setBusy(backupManager.isBusy());

    const status = computeStatus(settings, current);
    ui.setStatus(status.kind, status.text);
    ui.setError(runtime.lastErrorMessage);
}

function refreshAll() {
    if (!runtime.uiReady || !runtime.panelVisible) {
        return;
    }
    const settings = settingsManager.get();
    ui.showOnboarding(!settings.onboardingDone);
    ui.applySettings(settings, runtime.folderPath);
    ui.renderLog(logger.getSnapshot());
    refreshDynamic();
}

/* ------------------------------------------------------------------ */
/* UI handlers                                                         */
/* ------------------------------------------------------------------ */

function applyTimerState(settings) {
    timerManager.setIntervalMinutes(settings.intervalMinutes);
    if (settings.enabled) {
        timerManager.start();
    } else {
        timerManager.stop();
    }
}

const handlers = {
    async onboardingChooseFolder() {
        ui.setOnboardingError(null);
        const result = await pickAndStoreFolder();
        if (!result.ok) {
            ui.setOnboardingError(
                result.error ||
                    "No folder selected. Choose one to enable automatic backups."
            );
            return;
        }
        const settings = settingsManager.update({
            onboardingDone: true,
            enabled: true,
            intervalMinutes: settingsManager.DEFAULTS.intervalMinutes
        });
        applyTimerState(settings);
        refreshAll();
    },

    onboardingSkip() {
        settingsManager.update({ onboardingDone: true });
        logger.info('Setup postponed. Pick a backup folder with "Change" when ready.');
        refreshAll();
    },

    toggleAuto(enabled) {
        const settings = settingsManager.update({ enabled: enabled === true });
        if (enabled && !settingsManager.getActiveFolderToken(settings)) {
            runtime.lastErrorMessage = MESSAGES.NO_FOLDER_CONFIGURED;
        }
        applyTimerState(settings);
        refreshAll();
    },

    changeInterval(minutes) {
        if (!Number.isFinite(minutes)) {
            return;
        }
        const clamped = Math.min(
            settingsManager.MAX_INTERVAL_MINUTES,
            Math.max(settingsManager.MIN_INTERVAL_MINUTES, Math.round(minutes))
        );
        const settings = settingsManager.update({ intervalMinutes: clamped });
        timerManager.setIntervalMinutes(settings.intervalMinutes);
        timerManager.restart();
        logger.info("Interval set to " + settings.intervalMinutes + " minute(s).");
        refreshAll();
    },

    async backupNow() {
        // A manual backup always writes a copy, even when nothing changed.
        await runBackup("manual", true);
    },

    changeScope(scope) {
        const settings = settingsManager.get();
        if (settings.documentScope === scope) {
            return;
        }
        settingsManager.update({ documentScope: scope });
        logger.info(
            "Documents to back up: " +
                (scope === settingsManager.DOCUMENT_SCOPES.ALL_OPEN
                    ? "all open documents"
                    : "active document only")
        );
        refreshAll();
    },

    async changeMode(mode) {
        const settings = settingsManager.get();
        if (settings.backupMode === mode) {
            return;
        }
        settingsManager.update({ backupMode: mode });
        logger.info(
            "Mode: " + (mode === settingsManager.BACKUP_MODES.GLOBAL ? "global folder" : "per project")
        );
        await refreshFolderPath();
        refreshAll();
    },

    async chooseFolder() {
        const result = await pickAndStoreFolder();
        if (!result.ok && result.error) {
            runtime.lastErrorMessage = result.error;
            refreshAll();
        }
    },

    async openFolder() {
        if (!runtime.folderPath) {
            return;
        }
        const result = await storageManager.openInFileExplorer(
            runtime.folderPath,
            "Open the Photoshop Auto Backup folder in your file explorer."
        );
        if (!result.ok) {
            runtime.lastErrorMessage = "Could not open the backup folder: " + result.error;
            refreshAll();
        }
    },

    changeMaxBackups(value) {
        if (!Number.isFinite(value) || value < 0) {
            return;
        }
        const clamped = Math.min(100, Math.round(value));
        const settings = settingsManager.update({ maxBackups: clamped });
        logger.info(
            "Retention limit: " +
                (settings.maxBackups === 0 ? "unlimited" : settings.maxBackups + " backups")
        );
        refreshAll();
    },

    clearLog() {
        logger.clear();
        runtime.lastErrorMessage = null;
        refreshAll();
    },

    toggleExclude(excluded) {
        const current = getCurrentProject();
        if (!current.info.supported) {
            return;
        }
        settingsManager.setProjectExcluded(current.descriptor.key, excluded === true);
        logger.info(
            excluded ? "Excluded from backups." : "No longer excluded from backups.",
            { project: current.descriptor.name }
        );
        refreshAll();
    }
};

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

async function init() {
    if (runtime.initialised) {
        return;
    }
    runtime.initialised = true;

    const settings = settingsManager.load();

    ui.init(handlers);
    runtime.uiReady = true;
    runtime.panelVisible = true;

    storageManager.getPluginVersion().then((version) => ui.setVersion(version));

    timerManager.configure({
        intervalMinutes: settings.intervalMinutes,
        runner: () => runBackup("auto", false)
    });

    timerManager.onTick(() => refreshDynamic());
    logger.onChange((snapshot) => {
        if (runtime.uiReady && runtime.panelVisible) {
            ui.renderLog(snapshot);
        }
    });
    settingsManager.onChange(() => refreshDynamic());

    ui.showOnboarding(!settings.onboardingDone);

    await refreshFolderPath();

    if (settings.enabled && !settingsManager.getActiveFolderToken(settings)) {
        // Enabled but without a usable folder: keep the timer off and say why.
        settingsManager.update({ enabled: false });
        runtime.lastErrorMessage = MESSAGES.NO_FOLDER_CONFIGURED;
        logger.warn("Automatic backup turned off: no backup folder is configured.");
    } else if (settings.enabled && runtime.folderMissing) {
        settingsManager.update({ enabled: false });
        logger.error(MESSAGES.FOLDER_UNAVAILABLE);
    } else if (settings.enabled) {
        applyTimerState(settingsManager.get());
    }

    logger.info("Photoshop Auto Backup ready.");
    refreshAll();
}

init().catch((err) => {
    console.error("[AutoBackup] Initialisation failed:", err);
    logger.error("Plugin initialisation failed.", { error: err });
});
