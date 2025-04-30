const { ipcMain, powerSaveBlocker, app, BrowserWindow, shell } = require('electron');
const { stopScript } = require('./logic');
const path = require('path');
const { setBasePath } = require('./logic');
app.commandLine.appendSwitch('no-timers-throttle');

ipcMain.handle('get-user-data-path', () => {
    return app.getPath('userData');
});
ipcMain.handle('get-is-packaged', () => {
    return app.isPackaged;
});
const logPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(__dirname, 'logs');

ipcMain.handle('get-log-path', () => {
    return logPath;
});

ipcMain.handle('open-folder', async (event, folderPath) => {
    try {
        await shell.openPath(folderPath);
        return true;
    } catch (err) {
        console.error("Failed to open folder:", err);
        return false;
    }
});

let blockerId;

function createWindow() {
    const win = new BrowserWindow({
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
    try {
        blockerId = powerSaveBlocker.start('prevent-app-suspension');
        console.log(`Power Save Blocker started with ID ${blockerId}`);

        const logicBasePath = app.isPackaged
            ? app.getPath('userData')
            : __dirname;

        await setBasePath(logicBasePath);

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    } catch (err) {
        console.log("[ERROR] ❌ Fatal error during app initialization:", err.message);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (blockerId !== null) {
        powerSaveBlocker.stop(blockerId);
        console.log(`Power Save Blocker stopped`);
        blockerId = null;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    event.preventDefault();
    await stopScript();
    app.exit();
});
