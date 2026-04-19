const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const express = require("express");

const AuthSource = require("../src/auth/AuthSource");
const StatusRoutes = require("../src/routes/StatusRoutes");
const AccountQuotaService = require("../src/core/AccountQuotaService");
const { extractCooldownState, hasAnyCooldown, isCoolingDownForScope } = require("../src/utils/CooldownStateUtils");

function createLogger() {
    return {
        debug() {},
        displayLimit: 100,
        error() {},
        info() {},
        logBuffer: [],
        warn() {},
    };
}

function writeAuthFile(workspaceDir, index, authData) {
    const authDir = path.join(workspaceDir, "configs", "auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, `auth-${index}.json`), JSON.stringify(authData, null, 2));
}

async function withTempWorkspace(callback) {
    const previousCwd = process.cwd();
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-cooldown-"));
    fs.mkdirSync(path.join(workspaceDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "index.html"), "<html></html>");
    process.chdir(workspaceDir);

    try {
        await callback(workspaceDir);
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(workspaceDir, { force: true, recursive: true });
    }
}

test("legacy auth cooldown migrates to scoped text/image cooldowns", async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const cooldownState = extractCooldownState({
        cooldownReason: "RESOURCE_EXHAUSTED",
        cooldownUntil: futureIso,
    });

    assert.equal(hasAnyCooldown(cooldownState), true);
    assert.equal(isCoolingDownForScope(cooldownState, "text"), true);
    assert.equal(isCoolingDownForScope(cooldownState, "image"), true);
    assert.equal(cooldownState.text.cooldownUntil, futureIso);
    assert.equal(cooldownState.image.cooldownUntil, futureIso);
});

test("auth source excludes only the matching cooldown scope from route selection", async () => {
    await withTempWorkspace(async workspaceDir => {
        const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        writeAuthFile(workspaceDir, 1, {
            accountName: "text@example.com",
            accountTier: "pro",
            cooldowns: {
                text: {
                    cooldownReason: "RESOURCE_EXHAUSTED",
                    cooldownUntil: futureIso,
                    lastCooldownAt: futureIso,
                },
            },
        });
        writeAuthFile(workspaceDir, 2, {
            accountName: "image@example.com",
            accountTier: "pro",
        });

        const authSource = new AuthSource(createLogger());
        const textAllowed = authSource.getAvailableIndicesByTier("default", {
            cooldownScope: "text",
            includeCooldown: false,
            includeExpired: false,
            rotationOnly: true,
        });
        const imageAllowed = authSource.getAvailableIndicesByTier("default", {
            cooldownScope: "image",
            includeCooldown: false,
            includeExpired: false,
            rotationOnly: true,
        });

        assert.deepEqual(textAllowed, [2]);
        assert.deepEqual(imageAllowed, [1, 2]);
        assert.deepEqual(authSource.getRotationIndices(), [1, 2]);
    });
});

test("cooldown clear endpoint clears matching scope and resets only matching quota usage", async () => {
    await withTempWorkspace(async workspaceDir => {
        const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        writeAuthFile(workspaceDir, 1, {
            accountName: "scope@example.com",
            accountTier: "pro",
            cooldowns: {
                text: {
                    cooldownReason: "RESOURCE_EXHAUSTED",
                    cooldownUntil: futureIso,
                    lastCooldownAt: futureIso,
                },
            },
        });

        const authSource = new AuthSource(createLogger());
        const accountQuotaService = new AccountQuotaService(
            authSource,
            createLogger(),
            {
                proImageDailyQuota: 5,
                proTextDailyQuota: 5,
                ultraImageDailyQuota: 5,
                ultraTextDailyQuota: 5,
            },
            path.join(workspaceDir, "data")
        );
        accountQuotaService.consumeQuota(1, "text");
        accountQuotaService.consumeQuota(1, "image");

        const app = express();
        app.use(express.json());

        const statusRoutes = new StatusRoutes({
            accountQuotaService,
            authSource,
            browserManager: {
                rebalanceContextPool() {
                    return Promise.resolve();
                },
            },
            config: {
                immediateSwitchStatusCodes: [],
            },
            connectionRegistry: {
                getConnectionByAuth() {
                    return null;
                },
            },
            distIndexPath: path.join(workspaceDir, "index.html"),
            forceThinking: false,
            forceUrlContext: false,
            forceWebSearch: false,
            logger: createLogger(),
            requestHandler: {
                currentAuthIndex: -1,
                isSystemBusy: false,
            },
            runtimeSettingsManager: {
                getSleepCooldownSettings() {
                    return {
                        autoSleepEnabled: false,
                        idleSleepMinutes: 30,
                        quotaCooldownMinutes: 60,
                        sleepWindows: [],
                        sleepWindowsRaw: "",
                        timezone: null,
                    };
                },
            },
            sleepManager: {
                getStatus() {
                    return null;
                },
                recordActivity() {},
            },
            streamingMode: "fake",
            usageStatsService: {
                getSnapshot() {
                    return {
                        accounts: [],
                        records: [],
                        startedAt: null,
                        summary: {},
                    };
                },
            },
        });

        statusRoutes.setupRoutes(app, (req, res, next) => next());

        const server = app.listen(0);
        try {
            const { port } = server.address();
            const response = await fetch(`http://127.0.0.1:${port}/api/accounts/cooldown/clear`, {
                body: JSON.stringify({
                    indices: [1],
                    scope: "text",
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "POST",
            });
            const payload = await response.json();

            assert.equal(response.status, 200);
            assert.deepEqual(payload.clearedIndices, [1]);
            assert.deepEqual(payload.quotaResetIndices, [1]);
            assert.equal(authSource.isCoolingDown(1, "text"), false);
            assert.equal(accountQuotaService.getUsedQuota(1, "text"), 0);
            assert.equal(accountQuotaService.getUsedQuota(1, "image"), 1);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});
