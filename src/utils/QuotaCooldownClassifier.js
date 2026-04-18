"use strict";

const COOLDOWN_KEYWORDS = ["resource_exhausted", "quota", "limit reached", "rate limit exceeded"];
const DATE_TIME_CANDIDATE_PATTERNS = [
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gi,
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: ?UTC)?/gi,
];

function _toInteger(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function _parseDurationFromSegment(segment) {
    if (typeof segment !== "string" || !segment.trim()) return null;

    const unitRegex = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;
    let totalMs = 0;
    let matched = false;
    let match;

    while ((match = unitRegex.exec(segment)) !== null) {
        const value = _toInteger(match[1]);
        const unit = String(match[2] || "").toLowerCase();
        if (!value || !unit) continue;

        if (unit.startsWith("d")) {
            totalMs += value * 24 * 60 * 60 * 1000;
        } else if (unit.startsWith("h")) {
            totalMs += value * 60 * 60 * 1000;
        } else if (unit.startsWith("m")) {
            totalMs += value * 60 * 1000;
        } else {
            totalMs += value * 1000;
        }
        matched = true;
    }

    return matched && totalMs > 0 ? totalMs : null;
}

function _extractAbsoluteDate(rawText, now) {
    for (const pattern of DATE_TIME_CANDIDATE_PATTERNS) {
        const matches = rawText.match(pattern) || [];
        for (const candidate of matches) {
            const parsed = new Date(candidate.includes("UTC") ? candidate.replace(" UTC", "Z") : candidate);
            if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) {
                return parsed;
            }
        }
    }

    return null;
}

function _extractRelativeDuration(rawText) {
    const phraseRegex =
        /(?:retry after|try again in|available in|reset in|resets in|reset after|wait for|wait until|try again after)\s*([^.;,\n]+)/gi;
    let match;
    while ((match = phraseRegex.exec(rawText)) !== null) {
        const durationMs = _parseDurationFromSegment(match[1]);
        if (durationMs) return durationMs;
    }

    const retryAfterMatch = rawText.match(/retry[- ]after["=: ]+(\d+)/i);
    if (retryAfterMatch) {
        return _toInteger(retryAfterMatch[1]) * 1000;
    }

    return _parseDurationFromSegment(rawText);
}

function _resolveReason(rawTextLower) {
    if (rawTextLower.includes("resource_exhausted")) return "RESOURCE_EXHAUSTED";
    if (rawTextLower.includes("rate limit exceeded")) return "rate limit exceeded";
    if (rawTextLower.includes("limit reached")) return "limit reached";
    if (rawTextLower.includes("quota")) return "quota";
    return "quota";
}

function _collectNormalizedText(errorDetails) {
    return [errorDetails?.message, errorDetails?.body, errorDetails?.details]
        .filter(value => typeof value === "string" && value.trim())
        .join(" ")
        .toLowerCase();
}

function isQuotaExhaustedError(errorDetails) {
    const normalizedText = _collectNormalizedText(errorDetails);
    if (!normalizedText) {
        return false;
    }

    return COOLDOWN_KEYWORDS.some(keyword => normalizedText.includes(keyword));
}

function _buildCooldownUntil(rawText, defaultCooldownMinutes, now) {
    const absoluteDate = _extractAbsoluteDate(rawText, now);
    if (absoluteDate) return absoluteDate;

    const relativeMs = _extractRelativeDuration(rawText);
    if (relativeMs && relativeMs > 0) {
        return new Date(now.getTime() + relativeMs);
    }

    const fallbackMinutes = Number.isFinite(defaultCooldownMinutes) ? defaultCooldownMinutes : 60;
    return new Date(now.getTime() + Math.max(1, fallbackMinutes) * 60 * 1000);
}

function classifyQuotaCooldown(errorDetails, defaultCooldownMinutes = 60, now = new Date()) {
    const status = Number(errorDetails?.status);
    const rawText = [errorDetails?.message, errorDetails?.body, errorDetails?.details]
        .filter(value => typeof value === "string" && value.trim())
        .join(" ");
    const normalizedText = _collectNormalizedText(errorDetails);

    if (status !== 429 || !normalizedText) {
        return { isCooldown: false };
    }

    const matchedKeyword = COOLDOWN_KEYWORDS.find(keyword => normalizedText.includes(keyword));
    if (!matchedKeyword) {
        return { isCooldown: false };
    }

    const cooldownUntil = _buildCooldownUntil(rawText, defaultCooldownMinutes, now);
    return {
        cooldownUntil: cooldownUntil.toISOString(),
        isCooldown: true,
        matchedKeyword,
        reason: _resolveReason(normalizedText),
    };
}

module.exports = {
    classifyQuotaCooldown,
    isQuotaExhaustedError,
};
