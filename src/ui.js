"use strict";

/**
 * ui.js
 * The only module that touches the panel DOM.
 *
 * The backup logic does not depend on this file: if the panel is closed or
 * hidden the rest of the plugin keeps working. When the panel comes back,
 * main.js calls the render helpers again to resynchronise the UI with the
 * real state.
 */

const settingsManager = require("./settingsManager.js");

const STATUS = { ACTIVE: "active", IDLE: "idle", ERROR: "error", WORKING: "working" };

const elements = {};
let handlers = {};
let bound = false;

function cacheElements() {
    const ids = [
        "onboarding",
        "onboardingChooseFolder",
        "onboardingSkip",
        "onboardingError",
        "mainPanel",
        "autoToggle",
        "autoToggleLabel",
        "intervalPicker",
        "customIntervalRow",
        "customInterval",
        "customIntervalApply",
        "backupNow",
        "modePicker",
        "folderPath",
        "openFolder",
        "changeFolder",
        "maxBackupsPicker",
        "customMaxBackupsRow",
        "customMaxBackups",
        "customMaxBackupsApply",
        "onlyIfChanged",
        "documentInfo",
        "lastBackup",
        "nextBackup",
        "statusDot",
        "statusText",
        "errorBox",
        "errorText",
        "clearLog",
        "logList"
    ];
    for (const id of ids) {
        elements[id] = document.getElementById(id);
    }
}

/* ------------------------------------------------------------------ */
/* Spectrum UXP component helpers                                      */
/* ------------------------------------------------------------------ */

function getMenuItems(picker) {
    return picker ? Array.from(picker.querySelectorAll("sp-menu-item")) : [];
}

/**
 * True when `obj[prop] = ...` would actually work: some Spectrum UXP builds
 * expose `value` as a getter with no setter, which throws instead of being a
 * silent no-op. Checked once via the property descriptor so we never rely on
 * catching the exception as control flow.
 */
function isPropertyAssignable(obj, prop) {
    let target = obj;
    while (target) {
        const descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (descriptor) {
            return typeof descriptor.set === "function" || descriptor.writable === true;
        }
        target = Object.getPrototypeOf(target);
    }
    return true; // no descriptor found anywhere: plain assignable property
}

function setPickerValue(picker, value) {
    if (!picker) {
        return;
    }
    const items = getMenuItems(picker);
    const target = String(value);
    let index = -1;

    items.forEach((item, position) => {
        if (String(item.getAttribute("value")) === target) {
            index = position;
            item.setAttribute("selected", "true");
        } else {
            item.removeAttribute("selected");
        }
    });

    // Some builds expose `value` as a read-only getter (selection is driven
    // by the `selected` attribute and `selectedIndex` instead); assigning it
    // there would throw, so it is skipped rather than attempted-and-caught.
    if (isPropertyAssignable(picker, "value")) {
        try {
            picker.value = target;
        } catch (err) {
            console.warn("[AutoBackup] setPickerValue (value):", err);
        }
    }
    if (index >= 0 && isPropertyAssignable(picker, "selectedIndex")) {
        try {
            picker.selectedIndex = index;
        } catch (err) {
            console.warn("[AutoBackup] setPickerValue (selectedIndex):", err);
        }
    }
}

function readPickerValue(picker, event) {
    if (event && event.target && event.target.value !== undefined && event.target.value !== null) {
        const fromEvent = String(event.target.value);
        if (fromEvent !== "" && fromEvent !== "undefined") {
            return fromEvent;
        }
    }
    if (!picker) {
        return null;
    }
    if (picker.value !== undefined && picker.value !== null && picker.value !== "") {
        return String(picker.value);
    }
    const items = getMenuItems(picker);
    const index = Number(picker.selectedIndex);
    if (Number.isFinite(index) && items[index]) {
        return String(items[index].getAttribute("value"));
    }
    const selected = items.filter((item) => item.hasAttribute("selected"))[0];
    return selected ? String(selected.getAttribute("value")) : null;
}

function show(element, visible) {
    if (!element) {
        return;
    }
    if (visible) {
        element.classList.remove("hidden");
    } else {
        element.classList.add("hidden");
    }
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function call(name, payload) {
    const handler = handlers[name];
    if (typeof handler !== "function") {
        console.warn("[AutoBackup] No handler registered for: " + name);
        return;
    }
    try {
        const result = handler(payload);
        if (result && typeof result.catch === "function") {
            result.catch((err) => {
                console.error("[AutoBackup] Handler " + name + " failed:", err);
            });
        }
    } catch (err) {
        console.error("[AutoBackup] Handler " + name + " failed:", err);
    }
}

function bindEvents() {
    if (bound) {
        return;
    }
    bound = true;

    elements.onboardingChooseFolder.addEventListener("click", () => call("onboardingChooseFolder"));
    elements.onboardingSkip.addEventListener("click", () => call("onboardingSkip"));

    elements.autoToggle.addEventListener("change", () => {
        call("toggleAuto", elements.autoToggle.checked === true);
    });

    elements.intervalPicker.addEventListener("change", (event) => {
        const value = readPickerValue(elements.intervalPicker, event);
        if (value === "custom") {
            show(elements.customIntervalRow, true);
            return;
        }
        show(elements.customIntervalRow, false);
        const minutes = parseInt(value, 10);
        if (Number.isFinite(minutes)) {
            call("changeInterval", minutes);
        }
    });

    elements.customIntervalApply.addEventListener("click", () => {
        call("changeInterval", parseInt(elements.customInterval.value, 10));
    });

    elements.backupNow.addEventListener("click", () => call("backupNow"));

    elements.modePicker.addEventListener("change", (event) => {
        const value = readPickerValue(elements.modePicker, event);
        if (value) {
            call("changeMode", value);
        }
    });

    elements.openFolder.addEventListener("click", () => call("openFolder"));
    elements.changeFolder.addEventListener("click", () => call("chooseFolder"));

    elements.maxBackupsPicker.addEventListener("change", (event) => {
        const raw = readPickerValue(elements.maxBackupsPicker, event);
        if (raw === "custom") {
            show(elements.customMaxBackupsRow, true);
            return;
        }
        show(elements.customMaxBackupsRow, false);
        const value = parseInt(raw, 10);
        if (Number.isFinite(value)) {
            call("changeMaxBackups", value);
        }
    });

    elements.customMaxBackupsApply.addEventListener("click", () => {
        call("changeMaxBackups", parseInt(elements.customMaxBackups.value, 10));
    });

    elements.onlyIfChanged.addEventListener("change", () => {
        call("changeOnlyIfChanged", elements.onlyIfChanged.checked === true);
    });

    elements.clearLog.addEventListener("click", () => call("clearLog"));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function applySettings(settings, folderPath) {
    elements.autoToggle.checked = settings.enabled === true;
    elements.autoToggleLabel.textContent = settings.enabled ? "ON" : "OFF";

    const isPreset = settingsManager.ALLOWED_INTERVALS.indexOf(settings.intervalMinutes) >= 0;
    setPickerValue(elements.intervalPicker, isPreset ? String(settings.intervalMinutes) : "custom");
    show(elements.customIntervalRow, !isPreset);
    elements.customInterval.value = String(settings.intervalMinutes);

    setPickerValue(elements.modePicker, settings.backupMode);

    const isMaxBackupsPreset = settingsManager.ALLOWED_MAX_BACKUPS.indexOf(settings.maxBackups) >= 0;
    setPickerValue(elements.maxBackupsPicker, isMaxBackupsPreset ? String(settings.maxBackups) : "custom");
    show(elements.customMaxBackupsRow, !isMaxBackupsPreset);
    elements.customMaxBackups.value = String(settings.maxBackups);

    elements.onlyIfChanged.checked = settings.backupOnlyIfChanged === true;

    elements.openFolder.disabled = !folderPath;

    if (folderPath) {
        elements.folderPath.textContent = folderPath;
        elements.folderPath.classList.remove("muted");
    } else {
        elements.folderPath.textContent = "No backup folder selected";
        elements.folderPath.classList.add("muted");
    }
}

function setDocumentInfo(text) {
    elements.documentInfo.textContent = text || "—";
}

function setLastBackup(text) {
    elements.lastBackup.textContent = text || "—";
}

function setNextBackup(text) {
    elements.nextBackup.textContent = text || "—";
}

function setStatus(kind, text) {
    const classes = {
        active: "dot dot-active",
        idle: "dot dot-idle",
        error: "dot dot-error",
        working: "dot dot-working"
    };
    elements.statusDot.className = classes[kind] || classes.idle;
    elements.statusText.textContent = text || "";
}

function setError(message) {
    if (message) {
        elements.errorText.textContent = message;
        show(elements.errorBox, true);
    } else {
        elements.errorText.textContent = "";
        show(elements.errorBox, false);
    }
}

function setBusy(busy) {
    elements.backupNow.disabled = busy === true;
    elements.backupNow.textContent = busy ? "Backing up…" : "Back up now";
}

function pad2(value) {
    return String(value).padStart(2, "0");
}

function formatClock(timestamp) {
    const date = new Date(timestamp);
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
}

function renderLog(snapshot) {
    const list = elements.logList;
    list.innerHTML = "";

    if (!snapshot.entries.length) {
        const empty = document.createElement("div");
        empty.className = "log-entry log-info";
        empty.textContent = "No activity recorded yet.";
        list.appendChild(empty);
        return;
    }

    for (const entry of snapshot.entries) {
        const row = document.createElement("div");
        row.className = "log-entry log-" + entry.level;

        const time = document.createElement("span");
        time.className = "log-time";
        time.textContent = formatClock(entry.at);

        const text = document.createElement("span");
        text.textContent = entry.project ? entry.project + " — " + entry.message : entry.message;

        row.appendChild(time);
        row.appendChild(text);
        list.appendChild(row);
    }
}

function showOnboarding(visible) {
    show(elements.onboarding, visible);
    show(elements.mainPanel, !visible);
}

function setOnboardingError(message) {
    if (message) {
        elements.onboardingError.textContent = message;
        show(elements.onboardingError, true);
    } else {
        elements.onboardingError.textContent = "";
        show(elements.onboardingError, false);
    }
}

function init(eventHandlers) {
    handlers = eventHandlers || {};
    cacheElements();
    bindEvents();
}

module.exports = {
    STATUS,
    init,
    applySettings,
    setDocumentInfo,
    setLastBackup,
    setNextBackup,
    setStatus,
    setError,
    setBusy,
    renderLog,
    showOnboarding,
    setOnboardingError,
    formatClock
};
