"use strict";

function normalizeSleepWindowsRaw(rawWindows) {
    if (rawWindows === undefined || rawWindows === null) {
        return "";
    }

    if (Array.isArray(rawWindows)) {
        return rawWindows
            .map(item => String(item).trim())
            .filter(Boolean)
            .join(",");
    }

    return String(rawWindows)
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)
        .join(",");
}

function parseSleepWindows(rawWindows, options = {}) {
    const { logger = null, strict = false } = options;
    const normalizedRaw = normalizeSleepWindowsRaw(rawWindows);

    if (!normalizedRaw) {
        return [];
    }

    const invalidItems = [];
    const parsedWindows = normalizedRaw
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const match = item.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
            if (!match) {
                invalidItems.push(item);
                return null;
            }

            const [, startHourRaw, startMinuteRaw, endHourRaw, endMinuteRaw] = match;
            const startHour = parseInt(startHourRaw, 10);
            const startMinute = parseInt(startMinuteRaw, 10);
            const endHour = parseInt(endHourRaw, 10);
            const endMinute = parseInt(endMinuteRaw, 10);

            const isInvalidTime =
                startHour > 23 ||
                startMinute > 59 ||
                endHour > 23 ||
                endMinute > 59 ||
                (startHour === endHour && startMinute === endMinute);

            if (isInvalidTime) {
                invalidItems.push(item);
                return null;
            }

            return {
                endMinutes: endHour * 60 + endMinute,
                raw: item,
                startMinutes: startHour * 60 + startMinute,
            };
        })
        .filter(Boolean);

    if (invalidItems.length > 0) {
        const errorMessage = `Invalid sleep window value(s): ${invalidItems.join(", ")}. Expected HH:mm-HH:mm.`;
        if (strict) {
            throw new Error(errorMessage);
        }

        if (logger) {
            logger.warn(`[Config] ${errorMessage}`);
        }
    }

    return parsedWindows;
}

function parseBooleanSetting(value, fallback = null) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "1") return true;
        if (normalized === "false" || normalized === "0") return false;
    }

    return fallback;
}

function parseIntegerSetting(value, fallback, options = {}) {
    const { max = null, min = 0, name = "value" } = options;
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid ${name}. Expected an integer.`);
    }

    if (parsed < min) {
        throw new Error(`Invalid ${name}. Expected a value greater than or equal to ${min}.`);
    }

    if (max !== null && parsed > max) {
        throw new Error(`Invalid ${name}. Expected a value less than or equal to ${max}.`);
    }

    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSleepCooldownSettings(input = {}, fallback = {}, options = {}) {
    const { logger = null, strict = false } = options;

    const autoSleepEnabled = parseBooleanSetting(
        input.autoSleepEnabled ?? fallback.autoSleepEnabled,
        fallback.autoSleepEnabled ?? false
    );
    if (typeof autoSleepEnabled !== "boolean") {
        throw new Error("Invalid autoSleepEnabled setting. Expected true or false.");
    }

    const idleSleepMinutes = parseIntegerSetting(input.idleSleepMinutes ?? fallback.idleSleepMinutes ?? 30, 30, {
        max: 7 * 24 * 60,
        min: 0,
        name: "idleSleepMinutes",
    });

    const quotaCooldownMinutes = parseIntegerSetting(
        input.quotaCooldownMinutes ?? fallback.quotaCooldownMinutes ?? 60,
        60,
        {
            max: 7 * 24 * 60,
            min: 1,
            name: "quotaCooldownMinutes",
        }
    );

    const sleepWindowsRaw = normalizeSleepWindowsRaw(
        input.sleepWindowsRaw ?? input.sleepWindows ?? fallback.sleepWindowsRaw
    );
    const sleepWindows = parseSleepWindows(sleepWindowsRaw, {
        logger,
        strict,
    });

    return {
        autoSleepEnabled,
        idleSleepMinutes,
        quotaCooldownMinutes,
        sleepWindows,
        sleepWindowsRaw,
    };
}

module.exports = {
    normalizeSleepCooldownSettings,
    normalizeSleepWindowsRaw,
    parseSleepWindows,
};
