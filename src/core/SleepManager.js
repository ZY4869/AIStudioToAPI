"use strict";

const fs = require("fs");
const path = require("path");

const HEARTBEAT_INTERVAL_MS = 30000;

class SleepManager {
    constructor(logger, config, browserManager, authSource) {
        this.logger = logger;
        this.config = config;
        this.browserManager = browserManager;
        this.authSource = authSource;

        this.requestHandler = null;

        this.isSleeping = false;
        this.sleepReason = null;
        this.pendingScheduleSleep = false;
        this.lastActivityAt = new Date().toISOString();
        this.activeRequestCount = 0;
        this.nextWakeAt = null;
        this.preferredWakeAuthIndex = null;
        this.lastSleepAt = null;
        this.lastSleepReason = null;
        this.lastWakeAt = null;
        this.lastWakeResult = null;

        this._heartbeat = null;
        this._transitionPromise = null;

        this.dataDir = path.join(process.cwd(), "data");
        this.runtimeStatePath = path.join(this.dataDir, "runtime-state.json");

        this._loadRuntimeState();
    }

    setRequestHandler(requestHandler) {
        this.requestHandler = requestHandler;
    }

    start() {
        if (this._heartbeat) return;

        this._ensureDataDir();
        this._heartbeat = setInterval(() => {
            this.runHeartbeat().catch(error => {
                this.logger.error(`[Sleep] Heartbeat failed: ${error.message}`);
            });
        }, HEARTBEAT_INTERVAL_MS);
    }

    stop() {
        if (!this._heartbeat) return;
        clearInterval(this._heartbeat);
        this._heartbeat = null;
    }

    recordActivity() {
        this.lastActivityAt = new Date().toISOString();
    }

    onRequestStart() {
        this.activeRequestCount++;
    }

    async onRequestEnd() {
        if (this.activeRequestCount > 0) {
            this.activeRequestCount--;
        }

        if (this.pendingScheduleSleep && this.activeRequestCount === 0 && this.isInScheduledSleepWindow()) {
            await this.enterSleep("schedule", "pending_schedule_sleep");
        }
    }

    getStatus() {
        return {
            idleSleepMinutes: this.config.idleSleepMinutes,
            isSleeping: this.isSleeping,
            lastActivityAt: this.lastActivityAt,
            nextWakeAt: this.nextWakeAt,
            pendingScheduleSleep: this.pendingScheduleSleep,
            preferredWakeAuthIndex: this.preferredWakeAuthIndex,
            sleepReason: this.sleepReason,
            sleepWindows: (this.config.sleepWindows || []).map(window => window.raw),
            timezone: this.config.timezone,
        };
    }

    isInScheduledSleepWindow(now = new Date()) {
        return Boolean(this._getCurrentWindow(now));
    }

    async prepareForRequest() {
        const currentWindow = this._getCurrentWindow();

        if (this.isSleeping && this.sleepReason === "schedule" && !currentWindow) {
            await this.wakeUp("schedule_window_ended_request");
        }

        if (currentWindow) {
            this.nextWakeAt = currentWindow.endAt.toISOString();

            if (this.isSleeping) {
                if (this.sleepReason !== "schedule") {
                    this.sleepReason = "schedule";
                    this.lastSleepReason = "schedule";
                    this._persistRuntimeState();
                }
            } else if (this.activeRequestCount === 0) {
                await this.enterSleep("schedule", "request_during_schedule_window");
            } else {
                this.pendingScheduleSleep = true;
            }

            return {
                allowed: false,
                reason: "schedule",
                status: 503,
                wakeAt: this.nextWakeAt,
            };
        }

        if (this.isSleeping && this.sleepReason === "idle") {
            await this.wakeUp("incoming_request");
        }

        return { allowed: true };
    }

    async prepareForRecovery() {
        const currentWindow = this._getCurrentWindow();

        if (currentWindow) {
            this.nextWakeAt = currentWindow.endAt.toISOString();
            return {
                allowed: false,
                reason: "schedule",
                status: 503,
                wakeAt: this.nextWakeAt,
            };
        }

        if (this.isSleeping && this.sleepReason === "idle") {
            await this.wakeUp("browser_recovery");
        }

        return { allowed: true };
    }

    async runHeartbeat() {
        const currentWindow = this._getCurrentWindow();

        if (currentWindow) {
            this.nextWakeAt = currentWindow.endAt.toISOString();

            if (this.isSleeping) {
                if (this.sleepReason !== "schedule") {
                    this.sleepReason = "schedule";
                    this.lastSleepReason = "schedule";
                    this._persistRuntimeState();
                }
                return;
            }

            if (this.activeRequestCount > 0) {
                this.pendingScheduleSleep = true;
                return;
            }

            await this.enterSleep("schedule", "schedule_window_started");
            return;
        }

        if (this.pendingScheduleSleep) {
            this.pendingScheduleSleep = false;
        }

        if (this.isSleeping && this.sleepReason === "schedule") {
            await this.wakeUp("schedule_window_ended");
            return;
        }

        if (
            !this.isSleeping &&
            this.config.autoSleepEnabled &&
            this.config.idleSleepMinutes > 0 &&
            this.activeRequestCount === 0 &&
            this._isIdleThresholdReached()
        ) {
            await this.enterSleep("idle", "idle_timeout");
        }
    }

    async enterSleep(reason, trigger = "system") {
        return this._runTransition(async () => {
            const currentWindow = reason === "schedule" ? this._getCurrentWindow() : null;
            const nextWakeAt = currentWindow ? currentWindow.endAt.toISOString() : null;

            if (this.isSleeping) {
                this.sleepReason = reason;
                this.lastSleepReason = reason;
                this.nextWakeAt = nextWakeAt;
                this.pendingScheduleSleep = false;
                this._persistRuntimeState();
                return { alreadySleeping: true, reason };
            }

            const currentAuthIndex = this.browserManager.currentAuthIndex;
            if (Number.isInteger(currentAuthIndex) && currentAuthIndex >= 0) {
                this.preferredWakeAuthIndex = currentAuthIndex;
                try {
                    await this.browserManager.saveAuthState(currentAuthIndex);
                } catch (error) {
                    this.logger.warn(`[Sleep] Failed to save auth before sleep: ${error.message}`);
                }
            }

            this.isSleeping = true;
            this.lastSleepAt = new Date().toISOString();
            this.lastSleepReason = reason;
            this.nextWakeAt = nextWakeAt;
            this.pendingScheduleSleep = false;
            this.sleepReason = reason;
            this._persistRuntimeState();

            this.logger.info(`[Sleep] Entering ${reason} sleep (trigger: ${trigger}).`);
            await this.browserManager.closeBrowser();
            return { reason, slept: true };
        });
    }

    async wakeUp(trigger = "system") {
        return this._runTransition(async () => {
            if (this._getCurrentWindow()) {
                this.isSleeping = true;
                this.sleepReason = "schedule";
                this.lastSleepReason = "schedule";
                this.nextWakeAt = this._getCurrentWindow().endAt.toISOString();
                this.pendingScheduleSleep = false;
                this._persistRuntimeState();
                return { reason: "schedule_window_active", success: false };
            }

            if (!this.isSleeping && !this.browserManager.browser) {
                return this._attemptWake(trigger);
            }

            if (!this.isSleeping) {
                return { reason: "already_awake", success: true };
            }

            this.isSleeping = false;
            this.nextWakeAt = null;
            this.pendingScheduleSleep = false;
            this.sleepReason = null;

            return this._attemptWake(trigger);
        });
    }

    async _attemptWake(trigger) {
        let chosenIndex = null;
        let success = false;
        let wakeMode = "none";
        let wakeError = null;

        const preferredIndex = this.preferredWakeAuthIndex;
        if (this._isWakeCandidate(preferredIndex)) {
            try {
                await this.browserManager.launchOrSwitchContext(preferredIndex);
                chosenIndex = preferredIndex;
                success = true;
                wakeMode = "preferred";
                this.logger.info(`[Sleep] Woke browser using preferred account #${preferredIndex}.`);
            } catch (error) {
                wakeError = error;
                this.logger.warn(
                    `[Sleep] Preferred wake account #${preferredIndex} failed, falling back to next account: ${error.message}`
                );
            }
        }

        if (!success) {
            const rotationIndices = this.authSource.getRotationIndices();
            if (rotationIndices.length > 0 && this.requestHandler?.authSwitcher) {
                try {
                    const result = await this.requestHandler.authSwitcher.switchToNextAuth();
                    if (result?.success) {
                        chosenIndex = result.newIndex;
                        success = true;
                        wakeMode = "fallback";
                        this.logger.info(`[Sleep] Wake fallback switched to account #${chosenIndex}.`);
                    }
                } catch (error) {
                    wakeError = error;
                    this.logger.warn(`[Sleep] Wake fallback failed: ${error.message}`);
                }
            }
        }

        this.lastWakeAt = new Date().toISOString();
        this.lastWakeResult = {
            error: wakeError ? wakeError.message : null,
            status: success ? "success" : "failed",
            trigger,
            wakeMode,
        };

        if (success && Number.isInteger(chosenIndex)) {
            this.preferredWakeAuthIndex = chosenIndex;
        }

        this._persistRuntimeState();
        return {
            authIndex: chosenIndex,
            reason: success ? wakeMode : wakeError?.message || "no_available_accounts",
            success,
        };
    }

    _isIdleThresholdReached() {
        const lastActivity = new Date(this.lastActivityAt);
        if (Number.isNaN(lastActivity.getTime())) return false;
        return Date.now() - lastActivity.getTime() >= this.config.idleSleepMinutes * 60 * 1000;
    }

    _isWakeCandidate(index) {
        if (!Number.isInteger(index) || index < 0) return false;
        if (!this.authSource.availableIndices.includes(index)) return false;
        if (this.authSource.isExpired(index)) return false;
        if (this.authSource.isCoolingDown(index)) return false;
        return true;
    }

    _getCurrentWindow(now = new Date()) {
        const windows = this.config.sleepWindows || [];
        if (windows.length === 0) return null;

        const referenceNow = new Date(now);
        const nowMinutes = referenceNow.getHours() * 60 + referenceNow.getMinutes();

        for (const window of windows) {
            if (window.startMinutes <= window.endMinutes) {
                if (nowMinutes >= window.startMinutes && nowMinutes < window.endMinutes) {
                    return {
                        ...window,
                        endAt: this._buildWindowDate(referenceNow, window.endMinutes),
                    };
                }
                continue;
            }

            if (nowMinutes >= window.startMinutes || nowMinutes < window.endMinutes) {
                const endDate = this._buildWindowDate(
                    nowMinutes >= window.startMinutes ? this._addDays(referenceNow, 1) : referenceNow,
                    window.endMinutes
                );
                return {
                    ...window,
                    endAt: endDate,
                };
            }
        }

        return null;
    }

    _buildWindowDate(baseDate, minuteOfDay) {
        const date = new Date(baseDate);
        const hours = Math.floor(minuteOfDay / 60);
        const minutes = minuteOfDay % 60;
        date.setHours(hours, minutes, 0, 0);
        return date;
    }

    _addDays(date, days) {
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + days);
        return nextDate;
    }

    _runTransition(task) {
        if (this._transitionPromise) {
            return this._transitionPromise;
        }

        const promise = (async () => {
            try {
                return await task();
            } finally {
                if (this._transitionPromise === promise) {
                    this._transitionPromise = null;
                }
            }
        })();

        this._transitionPromise = promise;
        return promise;
    }

    _ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    _loadRuntimeState() {
        try {
            if (!fs.existsSync(this.runtimeStatePath)) return;
            const raw = fs.readFileSync(this.runtimeStatePath, "utf-8");
            if (!raw.trim()) return;
            const parsed = JSON.parse(raw);

            this.lastSleepAt = parsed.lastSleepAt || null;
            this.lastSleepReason = parsed.lastSleepReason || null;
            this.lastWakeAt = parsed.lastWakeAt || null;
            this.lastWakeResult = parsed.lastWakeResult || null;
            this.preferredWakeAuthIndex = Number.isInteger(parsed.preferredWakeAuthIndex)
                ? parsed.preferredWakeAuthIndex
                : null;
        } catch (error) {
            this.logger.warn(`[Sleep] Failed to load runtime state: ${error.message}`);
        }
    }

    _persistRuntimeState() {
        try {
            this._ensureDataDir();
            fs.writeFileSync(
                this.runtimeStatePath,
                JSON.stringify(
                    {
                        lastSleepAt: this.lastSleepAt,
                        lastSleepReason: this.lastSleepReason,
                        lastWakeAt: this.lastWakeAt,
                        lastWakeResult: this.lastWakeResult,
                        preferredWakeAuthIndex: this.preferredWakeAuthIndex,
                    },
                    null,
                    2
                )
            );
        } catch (error) {
            this.logger.warn(`[Sleep] Failed to persist runtime state: ${error.message}`);
        }
    }
}

module.exports = SleepManager;
