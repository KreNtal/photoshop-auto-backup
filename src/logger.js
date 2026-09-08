"use strict";

/**
 * logger.js
 * In-memory log plus forwarding to the developer console.
 *
 * The log is not persisted to disk: it is a session journal shown in the panel.
 * The last success and the last error are tracked separately because they are
 * the two pieces of information the UI always displays.
 */

const MAX_ENTRIES = 60;

const state = {
    entries: [],
    lastSuccess: null,
    lastError: null
};

const listeners = new Set();

function snapshot() {
    return {
        entries: state.entries.slice(),
        lastSuccess: state.lastSuccess,
        lastError: state.lastError
    };
}

function notify() {
    const data = snapshot();
    for (const listener of listeners) {
        try {
            listener(data);
        } catch (err) {
            console.error("[AutoBackup] Logger listener failed:", err);
        }
    }
}

function add(level, message, context) {
    const entry = {
        level: level,
        message: String(message),
        project: context && context.project ? context.project : null,
        at: Date.now()
    };

    state.entries.unshift(entry);
    if (state.entries.length > MAX_ENTRIES) {
        state.entries.length = MAX_ENTRIES;
    }

    if (level === "error") {
        state.lastError = entry;
    } else if (level === "success") {
        state.lastSuccess = entry;
    }

    const suffix = entry.project ? " (" + entry.project + ")" : "";
    const line = "[AutoBackup] " + entry.message + suffix;

    if (level === "error") {
        console.error(line, context && context.error ? context.error : "");
    } else if (level === "warn") {
        console.warn(line);
    } else {
        console.log(line);
    }

    notify();
    return entry;
}

module.exports = {
    info(message, context) {
        return add("info", message, context);
    },
    warn(message, context) {
        return add("warn", message, context);
    },
    error(message, context) {
        return add("error", message, context);
    },
    success(message, context) {
        return add("success", message, context);
    },
    clear() {
        state.entries = [];
        notify();
    },
    getSnapshot: snapshot,
    getLastError() {
        return state.lastError;
    },
    getLastSuccess() {
        return state.lastSuccess;
    },
    onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }
};
