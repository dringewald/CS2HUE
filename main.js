const { ipcMain, powerSaveBlocker, app, BrowserWindow, shell } = require('electron');
const { stopScript, isScriptRunning, setIsRunning, setLightIDs, setHueAPI, getHueAPI } = require('./logic');
const { info, warn, debug, error, initializeLogger, setIpcBridge } = require('./logger');
const { setBasePath } = require('./paths');
const path = require('path');
const DiscordRPC = require('./discordRPC');

app.commandLine.appendSwitch('no-timers-throttle');
let win;
let isTestingColor = false;
let cleanupDone = false;
let currentHueAPI = null;
let blockerId;
let resetLightsDone = false;
let lightIDs = [];

ipcMain.on('color-test-status', (_e, status) => {
    isTestingColor = status;
});

ipcMain.on('set-light-ids', (_e, ids) => {
    lightIDs = ids;
    setLightIDs(ids);
});

ipcMain.on('set-script-running', (_e, status) => {
    setIsRunning(status);
});

ipcMain.handle('get-user-data-path', (_e) => {
    return app.getPath('userData');
});
ipcMain.handle('get-is-packaged', (_e) => {
    return app.isPackaged;
});

ipcMain.handle('open-folder', async (_e, folderPath) => {
    try {
        if (!folderPath || typeof folderPath !== 'string') return false;
        if (!path.isAbsolute(folderPath)) return false;
        await shell.openPath(folderPath);
        return true;
    } catch (err) {
        error("❌ Failed to open folder:", err?.stack || err?.message || String(err));
        return false;
    }
});

ipcMain.on('lights-reset-complete', (_e) => {
    resetLightsDone = true;
});

ipcMain.on('set-hue-api', (_e, api) => {
    currentHueAPI = api;
    setHueAPI(api);
});

ipcMain.on('stop-script', async (_e) => {
    if (!getHueAPI() && currentHueAPI) {
        setHueAPI(currentHueAPI);
    }
    await stopScript();
});

ipcMain.handle('controller-get-state', async (_e, { id }) => {
    const logic = require('./logic');
    if (typeof logic.getLightData === 'function') {
        return await logic.getLightData(id);
    }
    return {};
});

ipcMain.handle('controller-set-state', async (_e, { id, body }) => {
    const logic = require('./logic');
    if (typeof logic.updateLightData === 'function') {
        return await logic.updateLightData(id, body);
    }
    return false;
});

ipcMain.on('rpc-toggle', (_e, enabled) => {
    debug(`[Discord] rpc-toggle received: ${enabled}`);
    if (enabled) DiscordRPC.startRPC();
    else DiscordRPC.stopRPC();
});

ipcMain.on('rpc-bump', (_e) => DiscordRPC.discordBump());

ipcMain.on('rpc-update', (_e, partial) => {
    try { DiscordRPC.updatePresence(partial || {}); } catch { }
});

process.on('unhandledRejection', (reason) => {
    const msg = (reason && (reason.message || reason)) + '';
    if (msg && msg.includes('connection closed')) {
        // Discord RPC is being shutdown –  ignore message.
        return;
    }
    error("⚠️ UnhandledPromiseRejection:", (reason && reason.stack) || reason);
});

function createWindow() {
    win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });

    win.loadFile('index.html');
    win.setVisibleOnAllWorkspaces(true);
}

app.whenReady().then(async () => {
    const cachePath = app.getPath('userData');
    const fs = require('fs');
    const path = require('path');
    try {
        const cacheDir = path.join(cachePath, 'Cache');
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            info("Cleared existing Cache directory");
        }
    } catch (err) {
        warn("Could not clear Cache directory:", err.message);
    }

    try {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
        info(`Power Save Blocker started with ID ${blockerId}`);

        const userDataPath = app.isPackaged
            ? app.getPath('userData')
            : __dirname;

        setBasePath(userDataPath);
        initializeLogger();
        createWindow();

        win.on('close', (event) => {
            if (!cleanupDone) {
                event.preventDefault();
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    } catch (err) {
        error("❌ Fatal error during app initialization:", err?.stack || err?.message || String(err));
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    if (cleanupDone) return;

    event.preventDefault();
    debug("before-quit triggered");

    // Send shutdown messages
    if (win && !win.isDestroyed()) {
        win.webContents.send('app-is-shutting-down');

        if (isTestingColor) {
            win.webContents.send('reset-lights');
        }
    }

    // Wait for reset-lights ack
    if (isTestingColor) {
        await Promise.race([
            new Promise(resolve => {
                const timeout = setTimeout(() => {
                    warn("Timeout waiting for lights-reset-complete");
                    resolve();
                }, 1000);
                ipcMain.once('lights-reset-complete', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            })
        ]);
    }

    // Stop script if running
    if (isScriptRunning()) {
        debug("🏃 Script is running — calling stopScript()");
        if (!getHueAPI()) {
            if (currentHueAPI) {
                info("Assigning currentHueAPI from main to logic");
                setHueAPI(currentHueAPI);
            } else {
                warn("hueAPI not yet set — waiting up to 500ms for renderer to send it...");
                await new Promise(resolve => {
                    const timeout = setTimeout(resolve, 500);
                    ipcMain.once('set-hue-api', (event, api) => {
                        currentHueAPI = api;
                        setHueAPI(api);
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
        }
        await stopScript(currentHueAPI);
    }
    try { DiscordRPC.stopRPC(); } catch { }

    cleanupDone = true;
    app.quit();
});

app.on('window-all-closed', async () => {
    if (isScriptRunning()) {
        await stopScript(currentHueAPI);
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

setIpcBridge((msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('log-line', msg);
});