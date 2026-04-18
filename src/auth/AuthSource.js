/**
 * File: src/auth/AuthSource.js
 * Description: Authentication source manager that loads and validates authentication data from config files
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const {
    DEFAULT_ACCOUNT_TIER,
    isValidAccountTier,
    normalizeAccountTier,
    normalizeAuthDataAccountTier,
    satisfiesMinAccountTier,
} = require("../utils/AccountTierUtils");

/**
 * Authentication Source Management Module
 * Responsible for loading and managing authentication information from the file system
 */
class AuthSource {
    constructor(logger) {
        this.logger = logger;
        this.authMode = "file";
        this.availableIndices = [];
        // Indices used for rotation/switching (deduplicated by email, keeping the latest index per account)
        this.rotationIndices = [];
        // Duplicate auth indices detected (valid JSON but skipped from rotation due to same email)
        this.duplicateIndices = [];
        // Expired auth indices (valid JSON but marked as expired, excluded from rotation)
        this.expiredIndices = [];
        this.cooldownInfoMap = new Map();
        this.initialIndices = [];
        this.accountNameMap = new Map();
        this.accountTierMap = new Map();
        // Map any valid index -> canonical (latest) index for the same account email
        this.canonicalIndexMap = new Map();
        // Duplicate groups (email -> kept + duplicates)
        this.duplicateGroups = [];
        this.lastScannedIndices = "[]"; // Cache to track changes

        this.logger.info('[Auth] Using files in "configs/auth/" directory for authentication.');

        this.reloadAuthSources(true); // Initial load

        if (this.availableIndices.length === 0) {
            this.logger.warn(
                `[Auth] No valid authentication sources found in 'file' mode. The server will start in account binding mode.`
            );
        }
    }

    reloadAuthSources(isInitialLoad = false) {
        const oldIndices = this.lastScannedIndices;
        this._discoverAvailableIndices();
        const newIndices = JSON.stringify(this.initialIndices);
        const cooldownsCleared = this.cleanupExpiredCooldowns();

        // Only log verbosely if it's the first load or if the file list has actually changed.
        if (isInitialLoad || oldIndices !== newIndices || cooldownsCleared.length > 0) {
            this.logger.info(`[Auth] Auth file scan detected changes. Reloading and re-validating...`);
            this._preValidateAndFilter();
            this.logger.info(
                `[Auth] Reload complete. ${this.availableIndices.length} valid sources available: [${this.availableIndices.join(", ")}]`
            );
            this.lastScannedIndices = newIndices;
            return true; // Changes detected
        }
        return false; // No changes
    }

    removeAuth(index) {
        if (!Number.isInteger(index)) {
            throw new Error("Invalid account index.");
        }

        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        if (!fs.existsSync(authFilePath)) {
            throw new Error(`Auth file for account #${index} does not exist.`);
        }

        try {
            fs.unlinkSync(authFilePath);
        } catch (error) {
            throw new Error(`Failed to delete auth file for account #${index}: ${error.message}`);
        }

        return {
            remainingAccounts: this.availableIndices.length,
            removedIndex: index,
        };
    }

    _discoverAvailableIndices() {
        let indices = [];
        const configDir = path.join(process.cwd(), "configs", "auth");
        if (!fs.existsSync(configDir)) {
            this.availableIndices = [];
            this.initialIndices = [];
            return;
        }
        try {
            const files = fs.readdirSync(configDir);
            const authFiles = files.filter(file => /^auth-\d+\.json$/.test(file));
            indices = authFiles.map(file => parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10));
        } catch (error) {
            this.logger.error(`[Auth] Failed to scan "configs/auth/" directory: ${error.message}`);
            this.availableIndices = [];
            this.initialIndices = [];
            return;
        }

        this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    }

    _preValidateAndFilter() {
        if (this.initialIndices.length === 0) {
            this.availableIndices = [];
            this.rotationIndices = [];
            this.duplicateIndices = [];
            this.expiredIndices = [];
            this.cooldownInfoMap.clear();
            this.accountNameMap.clear();
            this.accountTierMap.clear();
            this.canonicalIndexMap.clear();
            this.duplicateGroups = [];
            return;
        }

        const validIndices = [];
        const invalidSourceDescriptions = [];
        this.accountNameMap.clear(); // Clear old names before re-validating
        this.accountTierMap.clear();
        this.canonicalIndexMap.clear();
        this.cooldownInfoMap.clear();
        this.duplicateGroups = [];
        this.expiredIndices = [];

        for (const index of this.initialIndices) {
            // Iterate over initial to check all, not just previously available
            const authContent = this._getAuthContent(index);
            if (authContent) {
                try {
                    const authData = normalizeAuthDataAccountTier(JSON.parse(authContent));
                    validIndices.push(index);
                    this.accountNameMap.set(index, authData.accountName || null);
                    this.accountTierMap.set(index, authData.accountTier);
                    // Track expired status from auth file
                    if (authData.expired === true) {
                        this.expiredIndices.push(index);
                    }
                    if (typeof authData.cooldownUntil === "string") {
                        const cooldownUntil = new Date(authData.cooldownUntil);
                        if (!Number.isNaN(cooldownUntil.getTime()) && cooldownUntil.getTime() > Date.now()) {
                            this.cooldownInfoMap.set(index, {
                                cooldownReason: authData.cooldownReason || null,
                                cooldownUntil: cooldownUntil.toISOString(),
                                lastCooldownAt: authData.lastCooldownAt || null,
                            });
                        }
                    }
                } catch (e) {
                    invalidSourceDescriptions.push(`auth-${index} (parse error)`);
                }
            } else {
                invalidSourceDescriptions.push(`auth-${index} (unreadable)`);
            }
        }

        if (invalidSourceDescriptions.length > 0) {
            this.logger.warn(
                `⚠️ [Auth] Pre-validation found ${
                    invalidSourceDescriptions.length
                } authentication sources with format errors or unreadable: [${invalidSourceDescriptions.join(
                    ", "
                )}], will be removed from available list.`
            );
        }

        this.availableIndices = validIndices.sort((a, b) => a - b);
        this._buildRotationIndices();
    }

    _normalizeEmailKey(accountName) {
        if (typeof accountName !== "string") return null;
        const trimmed = accountName.trim();
        if (!trimmed) return null;
        // Conservative: only deduplicate when the name looks like an email address.
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(trimmed)) return null;
        return trimmed.toLowerCase();
    }

    _buildRotationIndices() {
        this.rotationIndices = [];
        this.duplicateIndices = [];
        this.duplicateGroups = [];
        this.canonicalIndexMap.clear();

        const emailKeyToIndices = new Map();

        // Only process non-expired and non-cooling accounts for rotation and deduplication
        const rotatableIndices = this.availableIndices.filter(
            idx => !this.expiredIndices.includes(idx) && !this.cooldownInfoMap.has(idx)
        );

        for (const index of rotatableIndices) {
            const accountName = this.accountNameMap.get(index);
            const emailKey = this._normalizeEmailKey(accountName);

            if (!emailKey) {
                this.rotationIndices.push(index);
                this.canonicalIndexMap.set(index, index);
                continue;
            }

            const list = emailKeyToIndices.get(emailKey) || [];
            list.push(index);
            emailKeyToIndices.set(emailKey, list);
        }

        for (const [emailKey, indices] of emailKeyToIndices.entries()) {
            indices.sort((a, b) => a - b);
            const keptIndex = indices[indices.length - 1];
            this.rotationIndices.push(keptIndex);

            const duplicateIndices = [];
            for (const index of indices) {
                this.canonicalIndexMap.set(index, keptIndex);
                if (index !== keptIndex) {
                    duplicateIndices.push(index);
                }
            }

            if (duplicateIndices.length > 0) {
                this.duplicateIndices.push(...duplicateIndices);
                this.duplicateGroups.push({
                    email: emailKey,
                    keptIndex,
                    removedIndices: duplicateIndices,
                });
            }
        }

        this.rotationIndices = [...new Set(this.rotationIndices)].sort((a, b) => a - b);
        this.duplicateIndices = [...new Set(this.duplicateIndices)].sort((a, b) => a - b);

        if (this.duplicateIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.duplicateIndices.length} duplicate auth files (same email). ` +
                    `Rotation will only use latest index per account: [${this.rotationIndices.join(", ")}].`
            );
        }

        if (this.expiredIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.expiredIndices.length} expired auth files: [${this.expiredIndices.join(", ")}]. ` +
                    `These accounts are excluded from automatic rotation.`
            );
        }

        if (this.cooldownInfoMap.size > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.cooldownInfoMap.size} cooling auth files: [${[
                    ...this.cooldownInfoMap.keys(),
                ].join(", ")}]. These accounts are excluded from automatic rotation.`
            );
        }
    }

    _getAuthContent(index) {
        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        if (!fs.existsSync(authFilePath)) return null;
        try {
            return fs.readFileSync(authFilePath, "utf-8");
        } catch (e) {
            return null;
        }
    }

    getAuth(index) {
        this.cleanupExpiredCooldowns();
        if (!this.availableIndices.includes(index)) {
            this.logger.error(`[Auth] Requested invalid or non-existent authentication index: ${index}`);
            return null;
        }

        const jsonString = this._getAuthContent(index);
        if (!jsonString) {
            this.logger.error(`[Auth] Unable to retrieve content for authentication source #${index} during read.`);
            return null;
        }

        try {
            return normalizeAuthDataAccountTier(JSON.parse(jsonString));
        } catch (e) {
            this.logger.error(`[Auth] Failed to parse JSON content from authentication source #${index}: ${e.message}`);
            return null;
        }
    }

    getRotationIndices() {
        this.cleanupExpiredCooldowns();
        return this.rotationIndices;
    }

    _getFilteredAvailableIndices(options = {}) {
        const { includeCooldown = true, includeExpired = true } = options;
        let indices = [...this.availableIndices];

        if (!includeExpired) {
            indices = indices.filter(index => !this.expiredIndices.includes(index));
        }

        if (!includeCooldown) {
            indices = indices.filter(index => !this.cooldownInfoMap.has(index));
        }

        return indices.sort((a, b) => a - b);
    }

    _getCanonicalIndices(options = {}) {
        const indices = this._getFilteredAvailableIndices(options);
        const canonicalByEmail = new Map();
        const standaloneIndices = [];

        for (const index of indices) {
            const emailKey = this._normalizeEmailKey(this.accountNameMap.get(index));
            if (!emailKey) {
                standaloneIndices.push(index);
                continue;
            }

            canonicalByEmail.set(emailKey, index);
        }

        return [...standaloneIndices, ...canonicalByEmail.values()].sort((a, b) => a - b);
    }

    getAvailableIndicesByTier(minTier = DEFAULT_ACCOUNT_TIER, options = {}) {
        this.cleanupExpiredCooldowns();

        const { includeCooldown = true, includeExpired = true, rotationOnly = false } = options;
        const indices = rotationOnly
            ? this._getCanonicalIndices({
                  includeCooldown,
                  includeExpired,
              })
            : this._getFilteredAvailableIndices({
                  includeCooldown,
                  includeExpired,
              });

        return indices.filter(index => satisfiesMinAccountTier(this.getAccountTier(index), minTier));
    }

    getAccountTier(index) {
        if (!Number.isInteger(index)) {
            return DEFAULT_ACCOUNT_TIER;
        }

        return this.accountTierMap.get(index) || DEFAULT_ACCOUNT_TIER;
    }

    getEligibleRotationIndices(minTier = DEFAULT_ACCOUNT_TIER) {
        return this.getAvailableIndicesByTier(minTier, {
            includeCooldown: false,
            includeExpired: false,
            rotationOnly: true,
        });
    }

    hasEligibleRotationAccount(minTier = DEFAULT_ACCOUNT_TIER) {
        return this.getEligibleRotationIndices(minTier).length > 0;
    }

    getCanonicalIndex(index) {
        this.cleanupExpiredCooldowns();
        if (!Number.isInteger(index)) return null;
        if (!this.availableIndices.includes(index)) return null;
        return this.canonicalIndexMap.get(index) ?? index;
    }

    getDuplicateGroups() {
        return this.duplicateGroups;
    }

    getCooldownIndices() {
        this.cleanupExpiredCooldowns();
        return [...this.cooldownInfoMap.keys()].sort((a, b) => a - b);
    }

    getCooldownInfo(index) {
        this.cleanupExpiredCooldowns();
        return this.cooldownInfoMap.get(index) || null;
    }

    getEarliestCooldownExpiry() {
        this.cleanupExpiredCooldowns();
        let earliest = null;
        for (const info of this.cooldownInfoMap.values()) {
            if (!info?.cooldownUntil) continue;
            if (!earliest || new Date(info.cooldownUntil).getTime() < new Date(earliest).getTime()) {
                earliest = info.cooldownUntil;
            }
        }
        return earliest;
    }

    isCoolingDown(index) {
        this.cleanupExpiredCooldowns();
        return this.cooldownInfoMap.has(index);
    }

    _getCooldownSiblingIndices(index) {
        const accountName = this.accountNameMap.get(index);
        const emailKey = this._normalizeEmailKey(accountName);
        if (!emailKey) {
            return [index];
        }

        return this.availableIndices.filter(
            candidate => this._normalizeEmailKey(this.accountNameMap.get(candidate)) === emailKey
        );
    }

    getAccountIdentityKey(index) {
        this.cleanupExpiredCooldowns();

        if (!Number.isInteger(index) || !this.availableIndices.includes(index)) {
            return null;
        }

        const canonicalIndex = this.getCanonicalIndex(index) ?? index;
        const canonicalName = this.accountNameMap.get(canonicalIndex) || this.accountNameMap.get(index) || null;
        const emailKey = this._normalizeEmailKey(canonicalName);

        if (emailKey) {
            return `email:${emailKey}`;
        }

        return `auth:${canonicalIndex}`;
    }

    _updateAuthFileSync(index, updater) {
        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        const authData = normalizeAuthDataAccountTier(JSON.parse(fs.readFileSync(authFilePath, "utf-8")));
        updater(authData);
        fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2));
    }

    setAccountTier(index, accountTier) {
        if (!Number.isInteger(index) || !this.availableIndices.includes(index)) {
            throw new Error(`Auth file for account #${index} does not exist or is not editable.`);
        }

        if (!isValidAccountTier(accountTier)) {
            throw new Error("Invalid account tier.");
        }

        const normalizedTier = normalizeAccountTier(accountTier);
        this._updateAuthFileSync(index, authData => {
            authData.accountTier = normalizedTier;
        });
        this.accountTierMap.set(index, normalizedTier);

        return normalizedTier;
    }

    cleanupExpiredCooldowns() {
        if (this.cooldownInfoMap.size === 0) return [];

        const now = Date.now();
        const clearedIndices = [];

        for (const [index, info] of [...this.cooldownInfoMap.entries()]) {
            const cooldownUntil = new Date(info.cooldownUntil).getTime();
            if (!Number.isFinite(cooldownUntil) || cooldownUntil > now) {
                continue;
            }

            try {
                this._updateAuthFileSync(index, authData => {
                    delete authData.cooldownReason;
                    delete authData.cooldownUntil;
                    delete authData.lastCooldownAt;
                });
            } catch (error) {
                this.logger.warn(`[Auth] Failed to clear cooldown for auth #${index}: ${error.message}`);
                continue;
            }

            this.cooldownInfoMap.delete(index);
            clearedIndices.push(index);
        }

        if (clearedIndices.length > 0) {
            this._buildRotationIndices();
            this.logger.info(`[Auth] Cooldown expired for auth files: [${clearedIndices.join(", ")}].`);
        }

        return clearedIndices;
    }

    clearAllCooldownsSync() {
        this.cleanupExpiredCooldowns();

        const indicesToClear = [...this.cooldownInfoMap.keys()].sort((a, b) => a - b);
        if (indicesToClear.length === 0) {
            return [];
        }

        for (const index of indicesToClear) {
            try {
                this._updateAuthFileSync(index, authData => {
                    delete authData.cooldownReason;
                    delete authData.cooldownUntil;
                    delete authData.lastCooldownAt;
                });
                this.cooldownInfoMap.delete(index);
            } catch (error) {
                this.logger.warn(`[Auth] Failed to clear cooldown for auth #${index}: ${error.message}`);
            }
        }

        this._buildRotationIndices();
        return indicesToClear;
    }

    async markAsCooldown(index, cooldownUntil, cooldownReason) {
        this.cleanupExpiredCooldowns();

        if (!this.availableIndices.includes(index)) {
            this.logger.warn(`[Auth] Cannot mark non-existent auth #${index} as cooling down`);
            return { markedIndices: [], updated: false };
        }

        const until = new Date(cooldownUntil);
        if (Number.isNaN(until.getTime())) {
            throw new Error(`Invalid cooldownUntil for auth #${index}: ${cooldownUntil}`);
        }

        const indicesToMark = this._getCooldownSiblingIndices(index);
        const lastCooldownAt = new Date().toISOString();
        const markedIndices = [];

        for (const targetIndex of indicesToMark) {
            const existingInfo = this.cooldownInfoMap.get(targetIndex);
            const existingUntil = existingInfo?.cooldownUntil ? new Date(existingInfo.cooldownUntil) : null;
            const effectiveUntil =
                existingUntil && existingUntil.getTime() > until.getTime()
                    ? existingUntil.toISOString()
                    : until.toISOString();

            const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${targetIndex}.json`);
            const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
            const authData = JSON.parse(fileContent);
            authData.cooldownReason = cooldownReason;
            authData.cooldownUntil = effectiveUntil;
            authData.lastCooldownAt = lastCooldownAt;
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.cooldownInfoMap.set(targetIndex, {
                cooldownReason,
                cooldownUntil: effectiveUntil,
                lastCooldownAt,
            });
            markedIndices.push(targetIndex);
        }

        this._buildRotationIndices();
        this.logger.warn(
            `[Auth] Marked auth files [${markedIndices.join(", ")}] as cooling down until ${until.toISOString()} (${cooldownReason}).`
        );

        return { cooldownUntil: until.toISOString(), markedIndices, updated: markedIndices.length > 0 };
    }

    async clearCooldown(index) {
        this.cleanupExpiredCooldowns();

        if (!this.availableIndices.includes(index)) {
            return false;
        }

        const indicesToClear = this._getCooldownSiblingIndices(index).filter(targetIndex =>
            this.cooldownInfoMap.has(targetIndex)
        );
        if (indicesToClear.length === 0) {
            return false;
        }

        for (const targetIndex of indicesToClear) {
            const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${targetIndex}.json`);
            const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
            const authData = JSON.parse(fileContent);
            delete authData.cooldownReason;
            delete authData.cooldownUntil;
            delete authData.lastCooldownAt;
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));
            this.cooldownInfoMap.delete(targetIndex);
        }

        this._buildRotationIndices();
        return true;
    }

    /**
     * Mark an auth as expired
     *
     * Side effects:
     * - Adds "expired": true to the auth file (configs/auth/auth-{index}.json)
     * - Adds index to this.expiredIndices array
     * - Rebuilds rotation indices (calls this._buildRotationIndices()) to exclude the expired account from rotation
     * - Updates canonicalIndexMap to reflect the new rotation state
     *
     * @param {number} index - Auth index to mark as expired
     * @returns {Promise<boolean>} True if successfully marked as expired, false if auth doesn't exist, is already expired, or file operation fails
     */
    async markAsExpired(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.warn(`[Auth] Cannot mark non-existent auth #${index} as expired`);
            return false;
        }

        if (this.expiredIndices.includes(index)) {
            this.logger.debug(`[Auth] Auth #${index} is already marked as expired`);
            return false;
        }

        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        try {
            const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
            const authData = JSON.parse(fileContent);
            authData.expired = true;
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.expiredIndices.push(index);

            // Rebuild rotation indices to exclude this expired account
            // This will properly rebuild canonicalIndexMap and handle duplicate relationships
            this._buildRotationIndices();

            this.logger.warn(`[Auth] ⏰ Marked auth #${index} as expired`);
            return true;
        } catch (error) {
            this.logger.error(`[Auth] Failed to mark auth #${index} as expired: ${error.message}`);
            return false;
        }
    }

    /**
     * Unmark an auth as expired (restore it to active status)
     *
     * Side effects:
     * - Removes "expired" field from the auth file (configs/auth/auth-{index}.json)
     * - Removes index from this.expiredIndices array
     * - Rebuilds rotation indices (calls this._buildRotationIndices()) to include the restored account in rotation
     * - Updates canonicalIndexMap to reflect the new rotation state
     *
     * @param {number} index - Auth index to restore
     * @returns {Promise<boolean>} True if successfully restored, false if auth doesn't exist, is not expired, or file operation fails
     */
    async unmarkAsExpired(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.warn(`[Auth] Cannot unmark non-existent auth #${index}`);
            return false;
        }

        if (!this.expiredIndices.includes(index)) {
            this.logger.debug(`[Auth] Auth #${index} is not marked as expired`);
            return false;
        }

        const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
        try {
            const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
            const authData = JSON.parse(fileContent);
            delete authData.expired;
            await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.expiredIndices = this.expiredIndices.filter(idx => idx !== index);

            // Rebuild rotation indices to include this restored account
            this._buildRotationIndices();

            this.logger.info(`[Auth] ✅ Restored auth #${index} from expired status`);
            return true;
        } catch (error) {
            this.logger.error(`[Auth] Failed to restore auth #${index}: ${error.message}`);
            return false;
        }
    }

    /**
     * Check if an auth is expired
     * @param {number} index - Auth index to check
     * @returns {boolean}
     */
    isExpired(index) {
        return this.expiredIndices.includes(index);
    }
}

module.exports = AuthSource;
