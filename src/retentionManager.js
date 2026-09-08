"use strict";

/**
 * retentionManager.js
 * Discovery, ordering and deletion of the oldest backups.
 *
 * SAFETY: only files matching exactly the naming scheme this plugin generates
 * for that specific project are ever deleted:
 *
 *     <ProjectName>_YYYY-MM-DD_HH-mm-ss[_n].psd|psb
 *
 * Any other file in the folder (the original project, backups from other
 * tools, unrelated assets) is never touched.
 */

const storageManager = require("./storageManager.js");
const logger = require("./logger.js");

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pattern that recognises the backups of a single project. */
function buildPattern(baseFileName) {
    const stamp = "_(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})(?:_(\\d+))?";
    return new RegExp("^" + escapeRegExp(baseFileName) + stamp + "\\.(psd|psb)$", "i");
}

function parseMatch(match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    const seconds = Number(match[6]);
    const suffix = match[7] ? Number(match[7]) : 0;

    const time = new Date(year, month - 1, day, hours, minutes, seconds).getTime();
    return { time: Number.isFinite(time) ? time : 0, suffix: suffix };
}

/**
 * Lists the backups that belong to the project, oldest first.
 * @returns {Promise<Array<{entry: object, name: string, time: number, suffix: number}>>}
 */
async function listProjectBackups(folder, baseFileName) {
    const pattern = buildPattern(baseFileName);
    const entries = await storageManager.listEntries(folder);
    const backups = [];

    for (const entry of entries) {
        if (!entry.isFile) {
            continue;
        }
        const match = pattern.exec(String(entry.name));
        if (!match) {
            continue;
        }
        const parsed = parseMatch(match);
        backups.push({
            entry: entry,
            name: String(entry.name),
            time: parsed.time,
            suffix: parsed.suffix
        });
    }

    backups.sort((a, b) => {
        if (a.time !== b.time) {
            return a.time - b.time;
        }
        if (a.suffix !== b.suffix) {
            return a.suffix - b.suffix;
        }
        return a.name.localeCompare(b.name);
    });

    return backups;
}

/**
 * Applies the retention limit.
 * @param {object} folder project backup folder
 * @param {string} baseFileName project backup prefix
 * @param {number} maxBackups 0 = unlimited
 * @returns {Promise<{deleted: string[], failed: string[], total: number}>}
 */
async function applyRetention(folder, baseFileName, maxBackups) {
    const result = { deleted: [], failed: [], total: 0 };

    if (!maxBackups || maxBackups <= 0) {
        return result;
    }

    const backups = await listProjectBackups(folder, baseFileName);
    result.total = backups.length;

    const excess = backups.length - maxBackups;
    if (excess <= 0) {
        return result;
    }

    for (let index = 0; index < excess; index += 1) {
        const backup = backups[index];
        try {
            await storageManager.deleteEntry(backup.entry);
            result.deleted.push(backup.name);
        } catch (err) {
            result.failed.push(backup.name);
            console.warn("[AutoBackup] Could not delete:", backup.name, err);
        }
    }

    if (result.deleted.length > 0) {
        logger.info(
            "Retention: removed " +
                result.deleted.length +
                " older backup(s) (limit " +
                maxBackups +
                ").",
            { project: baseFileName }
        );
    }

    return result;
}

module.exports = { buildPattern, listProjectBackups, applyRetention };
