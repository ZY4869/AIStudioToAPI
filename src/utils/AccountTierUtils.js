/**
 * File: src/utils/AccountTierUtils.js
 * Description: Shared helpers for account tier normalization and model tier access rules
 */

const DEFAULT_ACCOUNT_TIER = "default";
const ACCOUNT_TIERS = Object.freeze([DEFAULT_ACCOUNT_TIER, "pro", "ultra"]);
const ACCOUNT_TIER_RANK = Object.freeze({
    default: 0,
    pro: 1,
    ultra: 2,
});

const normalizeAccountTier = value => {
    if (typeof value !== "string") {
        return DEFAULT_ACCOUNT_TIER;
    }

    const normalized = value.trim().toLowerCase();
    return ACCOUNT_TIER_RANK[normalized] !== undefined ? normalized : DEFAULT_ACCOUNT_TIER;
};

const isValidAccountTier = value => {
    if (typeof value !== "string") {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return ACCOUNT_TIER_RANK[normalized] !== undefined;
};

const getAccountTierRank = tier => ACCOUNT_TIER_RANK[normalizeAccountTier(tier)];

const satisfiesMinAccountTier = (accountTier, minAccountTier = DEFAULT_ACCOUNT_TIER) =>
    getAccountTierRank(accountTier) >= getAccountTierRank(minAccountTier);

const normalizeAuthDataAccountTier = authData => {
    if (!authData || typeof authData !== "object" || Array.isArray(authData)) {
        return authData;
    }

    return {
        ...authData,
        accountTier: normalizeAccountTier(authData.accountTier),
    };
};

const findModelConfig = (modelList, modelName) => {
    if (!Array.isArray(modelList) || typeof modelName !== "string" || !modelName) {
        return null;
    }

    const normalizedModelName = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
    return (
        modelList.find(model => model?.name === normalizedModelName) ||
        modelList.find(model => model?.name?.replace(/^models\//, "") === modelName)
    );
};

const getModelMinAccountTier = (modelList, modelName) =>
    normalizeAccountTier(findModelConfig(modelList, modelName)?.minAccountTier);

module.exports = {
    ACCOUNT_TIERS,
    DEFAULT_ACCOUNT_TIER,
    findModelConfig,
    getAccountTierRank,
    getModelMinAccountTier,
    isValidAccountTier,
    normalizeAccountTier,
    normalizeAuthDataAccountTier,
    satisfiesMinAccountTier,
};
