/**
 * File: src/core/AccountQuotaService.js
 * Description: Daily per-account quota state for pro/ultra accounts
 */

const fs = require("fs");
const path = require("path");
const { DEFAULT_QUOTA_CATEGORY } = require("../utils/AccountTierUtils");
const { getNextPacificMidnightIso, getPacificDayBucket, PACIFIC_TIME_ZONE } = require("../utils/PacificTimeUtils");

class AccountQuotaService {
    constructor(authSource, logger, config, dataDir) {
        this.authSource = authSource;
        this.logger = logger;
        this.config = config;
        this.dataDir = dataDir || path.join(process.cwd(), "data");
        this.stateFilePath = path.join(this.dataDir, "account-quota-state.json");
        this.onDayReset = null;
        this.state = this._loadStateSync();
    }

    setDayResetHandler(handler) {
        this.onDayReset = typeof handler === "function" ? handler : null;
    }

    ensureDailyStateSync(now = new Date()) {
        const currentDayBucket = getPacificDayBucket(now);
        if (this.state.dayBucket === currentDayBucket) {
            return false;
        }

        this.logger.info(
            `[Quota] Pacific day bucket changed from "${this.state.dayBucket}" to "${currentDayBucket}". Resetting local quota state.`
        );

        this.state = this._createEmptyState(currentDayBucket);
        this._persistStateSync();

        const clearedCooldownIndices = this.authSource.clearAllCooldownsSync();
        if (clearedCooldownIndices.length > 0) {
            this.logger.info(`[Quota] Cleared cooldown flags for auth files: [${clearedCooldownIndices.join(", ")}].`);
        }

        if (this.onDayReset) {
            try {
                this.onDayReset({
                    clearedCooldownIndices,
                    dayBucket: currentDayBucket,
                });
            } catch (error) {
                this.logger.warn(`[Quota] Day reset handler failed: ${error.message}`);
            }
        }

        return true;
    }

    getNextResetAtIso(now = new Date()) {
        return getNextPacificMidnightIso(now);
    }

    getTimezone() {
        return PACIFIC_TIME_ZONE;
    }

    hasRemainingQuota(index, quotaCategory = DEFAULT_QUOTA_CATEGORY) {
        this.ensureDailyStateSync();
        const limit = this.getQuotaLimit(index, quotaCategory);
        if (!Number.isFinite(limit)) {
            return true;
        }

        return this.getUsedQuota(index, quotaCategory) < limit;
    }

    getUsedQuota(index, quotaCategory = DEFAULT_QUOTA_CATEGORY) {
        this.ensureDailyStateSync();
        const { usageBucket } = this._getUsageBucket(index, quotaCategory);
        return usageBucket;
    }

    consumeQuota(index, quotaCategory = DEFAULT_QUOTA_CATEGORY) {
        this.ensureDailyStateSync();

        const limit = this.getQuotaLimit(index, quotaCategory);
        if (!Number.isFinite(limit)) {
            return {
                exhausted: false,
                limit: null,
                quotaCategory,
                used: 0,
            };
        }

        const { accountKey, record } = this._getAccountRecord(index);
        const normalizedCategory = quotaCategory === "image" ? "image" : DEFAULT_QUOTA_CATEGORY;
        const nextUsed = (record[normalizedCategory] || 0) + 1;
        record[normalizedCategory] = nextUsed;
        this.state.accounts[accountKey] = record;
        this._persistStateSync();

        return {
            exhausted: nextUsed >= limit,
            limit,
            quotaCategory: normalizedCategory,
            used: nextUsed,
        };
    }

    getQuotaLimit(index, quotaCategory = DEFAULT_QUOTA_CATEGORY) {
        const accountTier = this.authSource.getAccountTier(index);
        const normalizedCategory = quotaCategory === "image" ? "image" : DEFAULT_QUOTA_CATEGORY;

        if (accountTier === "pro") {
            return normalizedCategory === "image" ? this.config.proImageDailyQuota : this.config.proTextDailyQuota;
        }

        if (accountTier === "ultra") {
            return normalizedCategory === "image" ? this.config.ultraImageDailyQuota : this.config.ultraTextDailyQuota;
        }

        return Infinity;
    }

    _loadStateSync() {
        const initialState = this._createEmptyState();
        if (!fs.existsSync(this.stateFilePath)) {
            return initialState;
        }

        try {
            const rawContent = fs.readFileSync(this.stateFilePath, "utf-8");
            const parsed = JSON.parse(rawContent);
            return {
                accounts: parsed?.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
                dayBucket: typeof parsed?.dayBucket === "string" ? parsed.dayBucket : initialState.dayBucket,
            };
        } catch (error) {
            this.logger.warn(`[Quota] Failed to load quota state file: ${error.message}`);
            return initialState;
        }
    }

    _createEmptyState(dayBucket = getPacificDayBucket()) {
        return {
            accounts: {},
            dayBucket,
        };
    }

    _persistStateSync() {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2));
    }

    _getAccountRecord(index) {
        const accountKey = this.authSource.getAccountIdentityKey(index) || `auth:${index}`;
        const record = this.state.accounts[accountKey] || {
            image: 0,
            text: 0,
        };
        return {
            accountKey,
            record,
        };
    }

    _getUsageBucket(index, quotaCategory) {
        const normalizedCategory = quotaCategory === "image" ? "image" : DEFAULT_QUOTA_CATEGORY;
        const { record } = this._getAccountRecord(index);
        return {
            quotaCategory: normalizedCategory,
            usageBucket: record[normalizedCategory] || 0,
        };
    }
}

module.exports = AccountQuotaService;
