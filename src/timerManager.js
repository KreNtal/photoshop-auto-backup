"use strict";

/**
 * timerManager.js
 * Automatic interval handling.
 *
 * Design choices:
 *  - a single 1-second setInterval drives both the countdown shown in the UI
 *    and the decision to run a backup;
 *  - the timer lives in this module, not in the panel DOM: hiding the panel
 *    does not stop it, as long as Photoshop keeps the plugin loaded;
 *  - the next run time is recomputed only after the previous run finished, so
 *    a slow backup can never produce overlapping executions.
 */

const logger = require("./logger.js");

const TICK_MS = 1000;

const state = {
    handle: null,
    intervalMs: 5 * 60 * 1000,
    nextRunAt: 0,
    running: false,
    executing: false,
    runner: null
};

const tickListeners = new Set();

function getRemainingMs() {
    if (!state.running || !state.nextRunAt) {
        return 0;
    }
    return Math.max(0, state.nextRunAt - Date.now());
}

function getSnapshot() {
    return {
        running: state.running,
        executing: state.executing,
        intervalMs: state.intervalMs,
        nextRunAt: state.nextRunAt,
        remainingMs: getRemainingMs()
    };
}

function notifyTick() {
    const snapshot = getSnapshot();
    for (const listener of tickListeners) {
        try {
            listener(snapshot);
        } catch (err) {
            console.error("[AutoBackup] Timer listener failed:", err);
        }
    }
}

function scheduleNext() {
    state.nextRunAt = Date.now() + state.intervalMs;
}

async function fire() {
    if (state.executing) {
        return;
    }
    state.executing = true;
    notifyTick();
    try {
        if (typeof state.runner === "function") {
            await state.runner();
        }
    } catch (err) {
        // The runner handles its own errors; this is a last resort so the
        // timer loop is never interrupted.
        console.error("[AutoBackup] Unhandled error in the automatic cycle:", err);
        logger.error("Unexpected error during the automatic backup.", { error: err });
    } finally {
        state.executing = false;
        scheduleNext();
        notifyTick();
    }
}

function tick() {
    if (!state.running) {
        return;
    }
    if (!state.executing && state.nextRunAt > 0 && Date.now() >= state.nextRunAt) {
        // Deliberately not awaited: tick() stays synchronous so it never falls
        // behind. The `executing` flag prevents overlapping runs.
        fire();
        return;
    }
    notifyTick();
}

/**
 * @param {{intervalMinutes?: number, runner?: Function}} options
 */
function configure(options) {
    const opts = options || {};
    if (typeof opts.runner === "function") {
        state.runner = opts.runner;
    }
    if (Number.isFinite(opts.intervalMinutes) && opts.intervalMinutes > 0) {
        setIntervalMinutes(opts.intervalMinutes);
    }
}

function setIntervalMinutes(minutes) {
    const value = Math.max(1, Math.round(Number(minutes) || 1));
    const nextIntervalMs = value * 60 * 1000;
    if (nextIntervalMs === state.intervalMs) {
        return;
    }
    state.intervalMs = nextIntervalMs;
    if (state.running) {
        scheduleNext();
    }
    notifyTick();
}

function start() {
    if (state.running) {
        return;
    }
    state.running = true;
    scheduleNext();
    if (state.handle === null) {
        state.handle = setInterval(tick, TICK_MS);
    }
    logger.info("Automatic backup enabled (every " + state.intervalMs / 60000 + " min).");
    notifyTick();
}

function stop() {
    if (!state.running) {
        return;
    }
    state.running = false;
    state.nextRunAt = 0;
    if (state.handle !== null) {
        clearInterval(state.handle);
        state.handle = null;
    }
    logger.info("Automatic backup disabled.");
    notifyTick();
}

function restart() {
    if (state.running) {
        scheduleNext();
        notifyTick();
    }
}

function isRunning() {
    return state.running;
}

function isExecuting() {
    return state.executing;
}

/** Formats a countdown as "in X min Y s". */
function formatRemaining(ms) {
    if (!ms || ms <= 0) {
        return "any moment now";
    }
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) {
        return "in " + seconds + " second" + (seconds === 1 ? "" : "s");
    }
    return (
        "in " +
        minutes +
        " minute" +
        (minutes === 1 ? "" : "s") +
        " " +
        seconds +
        " second" +
        (seconds === 1 ? "" : "s")
    );
}

module.exports = {
    configure,
    start,
    stop,
    restart,
    setIntervalMinutes,
    isRunning,
    isExecuting,
    getRemainingMs,
    getSnapshot,
    formatRemaining,
    onTick(listener) {
        tickListeners.add(listener);
        return () => tickListeners.delete(listener);
    }
};
