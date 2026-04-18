/**
 * File: src/auth/AuthSwitcher.js
 * Description: Authentication switcher that handles account rotation logic, failure tracking, and usage-based switching
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const { classifyQuotaCooldown, isQuotaExhaustedError } = require("../utils/QuotaCooldownClassifier");

/**
 * Authentication Switcher Module
 * Handles account switching logic including single/multi-account modes and fallback mechanisms
 */
class AuthSwitcher {
    constructor(logger, config, authSource, browserManager, accountQuotaService = null) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        this.browserManager = browserManager;
        this.accountQuotaService = accountQuotaService;
        this.failureCount = 0;
        this.usageCount = 0;
        this.isSystemBusy = false;
    }

    get currentAuthIndex() {
        return this.browserManager.currentAuthIndex;
    }

    set currentAuthIndex(value) {
        this.browserManager.currentAuthIndex = value;
    }

    _resolveAvailableRotationIndices(allowedIndices = null) {
        const rotationIndices = this.authSource.getRotationIndices();
        if (!Array.isArray(allowedIndices)) {
            return rotationIndices;
        }

        const allowedSet = new Set(allowedIndices.filter(Number.isInteger));
        return rotationIndices.filter(index => allowedSet.has(index));
    }

    async switchToNextAuth(options = {}) {
        const { allowedIndices = null } = options;
        const available = this._resolveAvailableRotationIndices(allowedIndices);

        if (available.length === 0) {
            throw new Error("No available authentication sources, cannot switch.");
        }

        if (this.isSystemBusy) {
            this.logger.info("[Auth] Account switching/restarting in progress, skipping duplicate operation");
            return { reason: "Switch already in progress.", success: false };
        }

        this.isSystemBusy = true;

        try {
            if (available.length === 1) {
                const singleIndex = available[0];
                this.logger.info("==================================================");
                this.logger.info(
                    "[Auth] Single account mode: Rotation threshold reached, performing in-place restart..."
                );
                this.logger.info(`   - Target account: #${singleIndex}`);
                this.logger.info("==================================================");

                try {
                    await this.browserManager.launchOrSwitchContext(singleIndex);
                    this.resetCounters();
                    this.browserManager.rebalanceContextPool().catch(err => {
                        this.logger.error(`[Auth] Background rebalance failed: ${err.message}`);
                    });

                    this.logger.info(
                        `[Auth] Single account #${singleIndex} restart/refresh successful, usage count reset.`
                    );
                    return { newIndex: singleIndex, success: true };
                } catch (error) {
                    this.logger.error(`[Auth] Single account restart failed: ${error.message}`);
                    throw new Error(`Only one account is available and restart failed: ${error.message}`);
                }
            }

            const currentCanonicalIndex =
                this.currentAuthIndex >= 0
                    ? this.authSource.getCanonicalIndex(this.currentAuthIndex)
                    : this.currentAuthIndex;
            const currentIndexInArray = available.indexOf(currentCanonicalIndex);
            const hasCurrentAccount = currentIndexInArray !== -1;
            const startIndex = hasCurrentAccount ? currentIndexInArray : 0;
            const originalStartAccount = hasCurrentAccount ? available[startIndex] : null;

            this.logger.info("==================================================");
            this.logger.info("[Auth] Multi-account mode: Starting intelligent account switching");
            this.logger.info(`   - Current account: #${this.currentAuthIndex}`);
            this.logger.info(
                `   - Available accounts (dedup by email, keeping latest index): [${available.join(", ")}]`
            );
            if (hasCurrentAccount) {
                this.logger.info(`   - Starting from: #${originalStartAccount}`);
            } else {
                this.logger.info("   - No current account, will try all available accounts");
            }
            this.logger.info("==================================================");

            const failedAccounts = [];
            const startOffset = hasCurrentAccount ? 1 : 0;
            const tryCount = hasCurrentAccount ? available.length - 1 : available.length;

            for (let i = startOffset; i < startOffset + tryCount; i++) {
                const tryIndex = (startIndex + i) % available.length;
                const accountIndex = available[tryIndex];

                const attemptNumber = i - startOffset + 1;
                this.logger.info(
                    `[Auth] Attempting to switch to account #${accountIndex} (${attemptNumber}/${tryCount} accounts)...`
                );

                try {
                    await this.browserManager.preCleanupForSwitch(accountIndex);
                    await this.browserManager.switchAccount(accountIndex);
                    this.resetCounters();
                    this.browserManager.rebalanceContextPool().catch(err => {
                        this.logger.error(`[Auth] Background rebalance failed: ${err.message}`);
                    });

                    if (failedAccounts.length > 0) {
                        this.logger.info(
                            `[Auth] Successfully switched to account #${accountIndex} after skipping failed accounts: [${failedAccounts.join(", ")}]`
                        );
                    } else {
                        this.logger.info(`[Auth] Successfully switched to account #${accountIndex}, counters reset.`);
                    }

                    return { failedAccounts, newIndex: accountIndex, success: true };
                } catch (error) {
                    this.logger.error(`[Auth] Account #${accountIndex} failed: ${error.message}`);
                    failedAccounts.push(accountIndex);
                }
            }

            if (hasCurrentAccount && originalStartAccount !== null) {
                this.logger.warn("==================================================");
                this.logger.warn(
                    `[Auth] All other accounts failed. Making final attempt with original starting account #${originalStartAccount}...`
                );
                this.logger.warn("==================================================");

                try {
                    await this.browserManager.preCleanupForSwitch(originalStartAccount);
                    await this.browserManager.switchAccount(originalStartAccount);
                    this.resetCounters();
                    this.browserManager.rebalanceContextPool().catch(err => {
                        this.logger.error(`[Auth] Background rebalance failed: ${err.message}`);
                    });
                    this.logger.info(`[Auth] Final attempt succeeded! Switched to account #${originalStartAccount}.`);
                    return {
                        failedAccounts,
                        finalAttempt: true,
                        newIndex: originalStartAccount,
                        success: true,
                    };
                } catch (finalError) {
                    this.logger.error(
                        `[Auth] Final attempt with account #${originalStartAccount} also failed: ${finalError.message}`
                    );
                    failedAccounts.push(originalStartAccount);
                    this.currentAuthIndex = -1;
                    throw new Error(
                        `Fallback failed reason: All accounts failed including fallback to #${originalStartAccount}. Failed accounts: [${failedAccounts.join(", ")}]`
                    );
                }
            }

            this.logger.error(
                `All ${available.length} accounts failed! Failed accounts: [${failedAccounts.join(", ")}]`
            );
            this.currentAuthIndex = -1;
            throw new Error(
                `Switching to account failed: All ${available.length} available accounts failed to initialize. Failed accounts: [${failedAccounts.join(", ")}]`
            );
        } finally {
            this.isSystemBusy = false;
        }
    }

    async switchToSpecificAuth(targetIndex, options = {}) {
        const { allowedIndices = null } = options;
        if (this.isSystemBusy) {
            this.logger.info("[Auth] Account switching in progress, skipping duplicate operation");
            return { reason: "Switch already in progress.", success: false };
        }

        if (!this.authSource.availableIndices.includes(targetIndex)) {
            return {
                reason: `Switch failed: Account #${targetIndex} invalid or does not exist.`,
                success: false,
            };
        }

        if (
            Array.isArray(allowedIndices) &&
            !this._resolveAvailableRotationIndices(allowedIndices).includes(targetIndex)
        ) {
            return {
                reason: `Switch failed: Account #${targetIndex} is not allowed for this request.`,
                success: false,
            };
        }

        this.isSystemBusy = true;
        try {
            this.logger.info(`[Auth] Starting switch to specified account #${targetIndex}...`);
            await this.browserManager.preCleanupForSwitch(targetIndex);
            await this.browserManager.switchAccount(targetIndex);
            this.resetCounters();
            this.browserManager.rebalanceContextPool().catch(err => {
                this.logger.error(`[Auth] Background rebalance failed: ${err.message}`);
            });
            this.logger.info(`[Auth] Successfully switched to account #${targetIndex}, counters reset.`);
            return { newIndex: targetIndex, success: true };
        } catch (error) {
            this.logger.error(`[Auth] Switch to specified account #${targetIndex} failed: ${error.message}`);
            throw error;
        } finally {
            this.isSystemBusy = false;
        }
    }

    async handleRequestFailureAndSwitch(errorDetails, sendErrorCallback, options = {}) {
        if (isQuotaExhaustedError(errorDetails)) {
            const cooldownUntil =
                this.accountQuotaService?.getNextResetAtIso?.() ||
                classifyQuotaCooldown(errorDetails, this.config.quotaCooldownMinutes).cooldownUntil;

            return this._handleQuotaCooldown(
                {
                    cooldownUntil,
                    reason: "RESOURCE_EXHAUSTED",
                },
                sendErrorCallback,
                options
            );
        }

        const cooldownDecision = classifyQuotaCooldown(errorDetails, this.config.quotaCooldownMinutes);
        if (cooldownDecision.isCooldown) {
            return this._handleQuotaCooldown(cooldownDecision, sendErrorCallback, options);
        }

        this.failureCount++;
        if (this.config.failureThreshold > 0) {
            this.logger.warn(
                `[Auth] Request failed - failure count: ${this.failureCount}/${this.config.failureThreshold} (Current account index: ${this.currentAuthIndex})`
            );
        } else {
            this.logger.warn(
                `[Auth] Request failed - failure count: ${this.failureCount} (Current account index: ${this.currentAuthIndex})`
            );
        }

        const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(errorDetails.status);
        const isThresholdReached =
            this.config.failureThreshold > 0 && this.failureCount >= this.config.failureThreshold;

        if (isImmediateSwitch || isThresholdReached) {
            if (isImmediateSwitch) {
                this.logger.warn(
                    `[Auth] Received status code ${errorDetails.status}, triggering immediate account switch...`
                );
            } else {
                this.logger.warn(
                    `[Auth] Failure threshold reached (${this.failureCount}/${this.config.failureThreshold})! Preparing to switch account...`
                );
            }

            try {
                const result = await this.switchToNextAuth(options);
                if (!result.success) {
                    this.logger.warn(`[Auth] Account switch skipped: ${result.reason}`);
                    if (sendErrorCallback) {
                        sendErrorCallback(`[Auth] Account switch skipped: ${result.reason}`);
                    }
                    return result;
                }
                const successMessage = `[Auth] Account switch completed, now using account #${this.currentAuthIndex}.`;
                this.logger.info(successMessage);
                if (sendErrorCallback) sendErrorCallback(successMessage);
                return result;
            } catch (error) {
                let userMessage = `Fatal error: Unknown switching error occurred: ${error.message}`;

                if (error.message.includes("Only one account is available")) {
                    userMessage = "Switch failed: Only one account available.";
                    this.logger.info("[Auth] Only one account available, failure count reset.");
                    this.failureCount = 0;
                } else if (error.message.includes("Fallback failed reason")) {
                    userMessage =
                        "Fatal error: Both automatic switching and emergency fallback failed, service may be interrupted, please check logs!";
                } else if (error.message.includes("Switching to account")) {
                    userMessage = `Automatic switch failed: Automatically fell back to account #${this.currentAuthIndex}, please check if target account has issues.`;
                }

                this.logger.error(`[Auth] Background account switching task failed: ${error.message}`);
                if (sendErrorCallback) sendErrorCallback(userMessage);
                return { reason: error.message, success: false };
            }
        }

        return { success: false };
    }

    async _handleQuotaCooldown(cooldownDecision, sendErrorCallback, options = {}) {
        const currentIndex = this.currentAuthIndex;
        if (!Number.isInteger(currentIndex) || currentIndex < 0) {
            this.logger.warn("[Auth] Quota cooldown detected but there is no active account to cool down.");
            return { reason: "no_active_account", success: false };
        }

        this.logger.warn(
            `[Auth] Quota exhaustion detected for account #${currentIndex}. Cooling down until ${cooldownDecision.cooldownUntil}.`
        );

        await this.authSource.markAsCooldown(currentIndex, cooldownDecision.cooldownUntil, cooldownDecision.reason);
        this.resetCounters();

        try {
            await this.browserManager.closeContext(currentIndex);
        } catch (error) {
            this.logger.warn(`[Auth] Failed to close cooling account #${currentIndex}: ${error.message}`);
        }

        this.browserManager.rebalanceContextPool().catch(error => {
            this.logger.error(`[Auth] Background rebalance failed after cooldown: ${error.message}`);
        });

        const remainingAccounts = this._resolveAvailableRotationIndices(options.allowedIndices);
        if (remainingAccounts.length === 0) {
            const message = `All available accounts are cooling down until ${cooldownDecision.cooldownUntil}.`;
            this.logger.warn(`[Auth] ${message}`);
            if (sendErrorCallback) sendErrorCallback(message);
            return {
                cooldownUntil: cooldownDecision.cooldownUntil,
                reason: "all_accounts_cooling_down",
                success: false,
            };
        }

        try {
            const result = await this.switchToNextAuth(options);
            if (result.success) {
                const successMessage = `Account #${currentIndex} cooled down. Switched to account #${result.newIndex}.`;
                this.logger.info(`[Auth] ${successMessage}`);
                if (sendErrorCallback) sendErrorCallback(successMessage);
                return {
                    cooldownUntil: cooldownDecision.cooldownUntil,
                    newIndex: result.newIndex,
                    success: true,
                };
            }

            return {
                cooldownUntil: cooldownDecision.cooldownUntil,
                reason: result.reason,
                success: false,
            };
        } catch (error) {
            this.logger.error(`[Auth] Failed to switch away from cooling account #${currentIndex}: ${error.message}`);
            return {
                cooldownUntil: cooldownDecision.cooldownUntil,
                reason: error.message,
                success: false,
            };
        }
    }

    incrementUsageCount() {
        this.usageCount++;
        return this.usageCount;
    }

    shouldSwitchByUsage() {
        return this.config.switchOnUses > 0 && this.usageCount >= this.config.switchOnUses;
    }

    resetCounters() {
        this.failureCount = 0;
        this.usageCount = 0;
    }
}

module.exports = AuthSwitcher;
