"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeSleepCooldownSettings } = require("../utils/SleepSettingsUtils");

class RuntimeSettingsManager {
    constructor(logger, config, sleepManager = null) {
        this.logger = logger;
        this.config = config;
        this.sleepManager = sleepManager;
        this.dataDir = path.join(process.cwd(), "data");
        this.runtimeSettingsPath = path.join(this.dataDir, "runtime-settings.json");
    }

    setSleepManager(sleepManager) {
        this.sleepManager = sleepManager;
    }

    getSleepCooldownSettings() {
        return {
            autoSleepEnabled: this.config.autoSleepEnabled === true,
            idleSleepMinutes: this.config.idleSleepMinutes,
            quotaCooldownMinutes: this.config.quotaCooldownMinutes,
            sleepWindows: (this.config.sleepWindows || []).map(window => window.raw),
            sleepWindowsRaw: this.config.sleepWindowsRaw || "",
            timezone: this.config.timezone,
        };
    }

    async updateSleepCooldownSettings(input) {
        const normalized = normalizeSleepCooldownSettings(input, this.getSleepCooldownSettings(), {
            logger: this.logger,
            strict: true,
        });

        this.config.autoSleepEnabled = normalized.autoSleepEnabled;
        this.config.idleSleepMinutes = normalized.idleSleepMinutes;
        this.config.quotaCooldownMinutes = normalized.quotaCooldownMinutes;
        this.config.sleepWindows = normalized.sleepWindows;
        this.config.sleepWindowsRaw = normalized.sleepWindowsRaw;

        await this._persistRuntimeSettings(normalized);
        this.logger.info(
            `[Settings] Sleep/cooldown settings updated: autoSleepEnabled=${normalized.autoSleepEnabled}, idleSleepMinutes=${normalized.idleSleepMinutes}, quotaCooldownMinutes=${normalized.quotaCooldownMinutes}, sleepWindows="${normalized.sleepWindowsRaw || "Disabled"}"`
        );

        if (this.sleepManager?.handleSettingsUpdated) {
            await this.sleepManager.handleSettingsUpdated("runtime_settings_update");
        }

        return this.getSleepCooldownSettings();
    }

    async _persistRuntimeSettings(settings) {
        await fs.promises.mkdir(this.dataDir, { recursive: true });
        await fs.promises.writeFile(
            this.runtimeSettingsPath,
            JSON.stringify(
                {
                    autoSleepEnabled: settings.autoSleepEnabled,
                    idleSleepMinutes: settings.idleSleepMinutes,
                    quotaCooldownMinutes: settings.quotaCooldownMinutes,
                    sleepWindowsRaw: settings.sleepWindowsRaw,
                },
                null,
                2
            )
        );
    }
}

module.exports = RuntimeSettingsManager;
