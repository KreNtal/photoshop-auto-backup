"use strict";

/**
 * documentManager.js
 * Reads Photoshop document state through the UXP DOM API.
 *
 * APIs used (verified against the official Photoshop UXP reference):
 *   app.activeDocument, app.documents
 *   Document: id, title, path, saved, cloudDocument, activeHistoryState
 *   HistoryState: id, name
 *
 * Every read is defensive: reading `path` on a never-saved document, or
 * `activeHistoryState` in certain states, can throw.
 */

const photoshop = require("photoshop");
const { CODES } = require("./errors.js");

const app = photoshop.app;

const FORMATS = { PSD: "psd", PSB: "psb" };

function getActiveDocument() {
    try {
        return app.activeDocument || null;
    } catch (err) {
        // Photoshop throws when no document is open.
        return null;
    }
}

function getOpenDocuments() {
    try {
        const documents = app.documents;
        return documents ? Array.from(documents) : [];
    } catch (err) {
        console.warn("[AutoBackup] getOpenDocuments:", err);
        return [];
    }
}

/** True when a document with that id is still open. */
function isDocumentOpen(documentId) {
    return getOpenDocuments().some((doc) => {
        try {
            return doc.id === documentId;
        } catch (err) {
            return false;
        }
    });
}

function readPath(doc) {
    try {
        const value = doc.path;
        return typeof value === "string" && value.length > 0 ? value : null;
    } catch (err) {
        return null;
    }
}

function readTitle(doc) {
    try {
        return typeof doc.title === "string" && doc.title ? doc.title : "Untitled";
    } catch (err) {
        return "Untitled";
    }
}

function readIsCloud(doc) {
    try {
        return doc.cloudDocument === true;
    } catch (err) {
        return false;
    }
}

function readIsSaved(doc) {
    try {
        return doc.saved === true;
    } catch (err) {
        return false;
    }
}

function readId(doc) {
    try {
        return doc.id;
    } catch (err) {
        return null;
    }
}

function extensionOf(nameOrPath) {
    if (!nameOrPath) {
        return "";
    }
    const normalized = String(nameOrPath).replace(/\\/g, "/");
    const base = normalized.substring(normalized.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.substring(dot + 1).toLowerCase() : "";
}

/**
 * Describes a document and decides whether it can be backed up.
 * @returns {{
 *   document: object|null, id: number|null, title: string, path: string|null,
 *   isCloud: boolean, isSaved: boolean, format: string|null,
 *   supported: boolean, reason: string|null
 * }}
 */
function describe(doc) {
    if (!doc) {
        return {
            document: null,
            id: null,
            title: "",
            path: null,
            isCloud: false,
            isSaved: false,
            format: null,
            supported: false,
            reason: CODES.NO_DOCUMENT
        };
    }

    const info = {
        document: doc,
        id: readId(doc),
        title: readTitle(doc),
        path: readPath(doc),
        isCloud: readIsCloud(doc),
        isSaved: readIsSaved(doc),
        format: null,
        supported: false,
        reason: null
    };

    if (info.isCloud) {
        info.reason = CODES.CLOUD_DOCUMENT;
        return info;
    }

    if (!info.path) {
        info.reason = CODES.UNSAVED_DOCUMENT;
        return info;
    }

    const extension = extensionOf(info.path) || extensionOf(info.title);
    if (extension === FORMATS.PSB) {
        info.format = FORMATS.PSB;
    } else if (extension === FORMATS.PSD) {
        info.format = FORMATS.PSD;
    } else {
        info.reason = CODES.UNSUPPORTED_FORMAT;
        return info;
    }

    info.supported = true;
    return info;
}

function describeActiveDocument() {
    return describe(getActiveDocument());
}

/**
 * Document state fingerprint used by the "back up only if changed" option.
 *
 * It is based on `activeHistoryState.id`: every operation that pushes a new
 * entry into the History panel produces a different id, no matter whether the
 * document counts as "saved". `document.saved` alone is not enough, because a
 * saveAs(asCopy = true) must not change the state of the original document.
 *
 * KNOWN LIMITS (also documented in the README):
 *  - undoing back to an earlier state returns an id already seen, so the
 *    document looks "unchanged" even though it differs from the last backup;
 *  - operations that do not create a history state are not detected;
 *  - when the id cannot be read this returns null and the caller performs the
 *    backup anyway (conservative behaviour).
 */
function getChangeSignature(doc) {
    try {
        const historyState = doc.activeHistoryState;
        if (historyState && historyState.id !== undefined && historyState.id !== null) {
            return "hs:" + historyState.id;
        }
    } catch (err) {
        console.warn("[AutoBackup] getChangeSignature:", err);
    }
    return null;
}

module.exports = {
    FORMATS,
    getActiveDocument,
    getOpenDocuments,
    isDocumentOpen,
    describe,
    describeActiveDocument,
    getChangeSignature,
    extensionOf
};
