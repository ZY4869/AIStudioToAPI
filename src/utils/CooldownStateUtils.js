"use strict";

const TEXT_COOLDOWN_SCOPE = "text";
const IMAGE_COOLDOWN_SCOPE = "image";
const ALL_COOLDOWN_SCOPE = "all";
const COOLDOWN_CATEGORY_SCOPES = Object.freeze([TEXT_COOLDOWN_SCOPE, IMAGE_COOLDOWN_SCOPE]);

function normalizeCooldownScope(scope, options = {}) {
    const { allowAll = false, fallback = TEXT_COOLDOWN_SCOPE } = options;
    if (typeof scope !== "string") {
        return fallback;
    }

    const normalized = scope.trim().toLowerCase();
    if (COOLDOWN_CATEGORY_SCOPES.includes(normalized)) {
        return normalized;
    }

    if (allowAll && normalized === ALL_COOLDOWN_SCOPE) {
        return ALL_COOLDOWN_SCOPE;
    }

    return fallback;
}

function getCooldownScopes(scope = ALL_COOLDOWN_SCOPE) {
    const normalized = normalizeCooldownScope(scope, {
        allowAll: true,
        fallback: ALL_COOLDOWN_SCOPE,
    });
    return normalized === ALL_COOLDOWN_SCOPE ? [...COOLDOWN_CATEGORY_SCOPES] : [normalized];
}

function createEmptyCooldownState() {
    return {
        image: null,
        text: null,
    };
}

function cloneCooldownInfo(info) {
    if (!info || typeof info !== "object") {
        return null;
    }

    return {
        cooldownReason: info.cooldownReason || null,
        cooldownUntil: info.cooldownUntil || null,
        lastCooldownAt: info.lastCooldownAt || null,
    };
}

function _normalizeCooldownInfo(candidate, now = Date.now()) {
    if (!candidate || typeof candidate !== "object") {
        return null;
    }

    const cooldownUntil = new Date(candidate.cooldownUntil);
    if (Number.isNaN(cooldownUntil.getTime()) || cooldownUntil.getTime() <= now) {
        return null;
    }

    return {
        cooldownReason: candidate.cooldownReason || null,
        cooldownUntil: cooldownUntil.toISOString(),
        lastCooldownAt: candidate.lastCooldownAt || null,
    };
}

function extractCooldownState(authData, now = Date.now()) {
    const cooldownState = createEmptyCooldownState();
    const rawCooldowns = authData?.cooldowns;
    const hasScopedCooldowns = rawCooldowns && typeof rawCooldowns === "object" && !Array.isArray(rawCooldowns);

    if (hasScopedCooldowns) {
        for (const scope of COOLDOWN_CATEGORY_SCOPES) {
            cooldownState[scope] = _normalizeCooldownInfo(rawCooldowns[scope], now);
        }
        return cooldownState;
    }

    const legacyInfo = _normalizeCooldownInfo(authData, now);
    if (!legacyInfo) {
        return cooldownState;
    }

    for (const scope of COOLDOWN_CATEGORY_SCOPES) {
        cooldownState[scope] = cloneCooldownInfo(legacyInfo);
    }
    return cooldownState;
}

function serializeCooldownState(authData, cooldownState) {
    delete authData.cooldownReason;
    delete authData.cooldownUntil;
    delete authData.lastCooldownAt;

    const nextCooldowns = {};
    for (const scope of COOLDOWN_CATEGORY_SCOPES) {
        const info = cloneCooldownInfo(cooldownState?.[scope]);
        if (info?.cooldownUntil) {
            nextCooldowns[scope] = info;
        }
    }

    if (Object.keys(nextCooldowns).length === 0) {
        delete authData.cooldowns;
    } else {
        authData.cooldowns = nextCooldowns;
    }

    return authData;
}

function hasAnyCooldown(cooldownState) {
    return COOLDOWN_CATEGORY_SCOPES.some(scope => !!cooldownState?.[scope]?.cooldownUntil);
}

function isCoolingDownForScope(cooldownState, scope = null) {
    if (!cooldownState) {
        return false;
    }

    if (scope === null || scope === undefined) {
        return hasAnyCooldown(cooldownState);
    }

    const normalized = normalizeCooldownScope(scope, {
        allowAll: true,
        fallback: ALL_COOLDOWN_SCOPE,
    });
    if (normalized === ALL_COOLDOWN_SCOPE) {
        return COOLDOWN_CATEGORY_SCOPES.every(category => !!cooldownState?.[category]?.cooldownUntil);
    }

    return !!cooldownState?.[normalized]?.cooldownUntil;
}

function getCooldownInfoForScope(cooldownState, scope = null) {
    if (!cooldownState) {
        return null;
    }

    if (scope === null || scope === undefined) {
        const activeInfos = COOLDOWN_CATEGORY_SCOPES.map(category => cooldownState[category]).filter(Boolean);
        if (activeInfos.length === 0) {
            return null;
        }

        return activeInfos.reduce((earliest, current) => {
            if (!earliest) return cloneCooldownInfo(current);
            return new Date(current.cooldownUntil).getTime() < new Date(earliest.cooldownUntil).getTime()
                ? cloneCooldownInfo(current)
                : earliest;
        }, null);
    }

    const normalized = normalizeCooldownScope(scope, {
        allowAll: true,
        fallback: ALL_COOLDOWN_SCOPE,
    });
    if (normalized === ALL_COOLDOWN_SCOPE) {
        if (!isCoolingDownForScope(cooldownState, ALL_COOLDOWN_SCOPE)) {
            return null;
        }

        return getCooldownInfoForScope(cooldownState, null);
    }

    return cloneCooldownInfo(cooldownState[normalized]);
}

function getEarliestCooldownExpiryForScope(cooldownState, scope = null) {
    return getCooldownInfoForScope(cooldownState, scope)?.cooldownUntil || null;
}

function pruneExpiredCooldownState(cooldownState, now = Date.now()) {
    const nextState = createEmptyCooldownState();
    const clearedScopes = [];

    for (const scope of COOLDOWN_CATEGORY_SCOPES) {
        const info = cooldownState?.[scope];
        if (!info?.cooldownUntil) {
            continue;
        }

        const cooldownUntil = new Date(info.cooldownUntil).getTime();
        if (!Number.isFinite(cooldownUntil) || cooldownUntil <= now) {
            clearedScopes.push(scope);
            continue;
        }

        nextState[scope] = cloneCooldownInfo(info);
    }

    return {
        clearedScopes,
        nextState,
    };
}

function setCooldownForScope(cooldownState, scope, info) {
    const nextState = createEmptyCooldownState();
    for (const category of COOLDOWN_CATEGORY_SCOPES) {
        nextState[category] = cloneCooldownInfo(cooldownState?.[category]);
    }

    const nextInfo = cloneCooldownInfo(info);
    for (const category of getCooldownScopes(scope)) {
        nextState[category] = nextInfo;
    }

    return nextState;
}

function clearCooldownForScope(cooldownState, scope) {
    const nextState = createEmptyCooldownState();
    const clearedScopes = [];
    const scopesToClear = new Set(getCooldownScopes(scope));

    for (const category of COOLDOWN_CATEGORY_SCOPES) {
        if (scopesToClear.has(category) && cooldownState?.[category]?.cooldownUntil) {
            clearedScopes.push(category);
            continue;
        }

        nextState[category] = cloneCooldownInfo(cooldownState?.[category]);
    }

    return {
        clearedScopes,
        nextState,
    };
}

module.exports = {
    ALL_COOLDOWN_SCOPE,
    clearCooldownForScope,
    cloneCooldownInfo,
    COOLDOWN_CATEGORY_SCOPES,
    createEmptyCooldownState,
    extractCooldownState,
    getCooldownInfoForScope,
    getCooldownScopes,
    getEarliestCooldownExpiryForScope,
    hasAnyCooldown,
    IMAGE_COOLDOWN_SCOPE,
    isCoolingDownForScope,
    normalizeCooldownScope,
    pruneExpiredCooldownState,
    serializeCooldownState,
    setCooldownForScope,
    TEXT_COOLDOWN_SCOPE,
};
