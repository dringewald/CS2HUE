const { info, warn, error, debug, setHtmlLogEnabled, setDebugMode, setRendererLogFunction, setMaxSessionLines, initializeLogger } = require('./logger');
const { startScript, stopScript, isScriptRunning, anyLightInSyncMode, getHueAPI } = require('./logic.js');
const { setBasePath, getConfigPath, getColorsPath, getBackupPath } = require('./paths');
const { migrateMissingColors } = require('./migrator');
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
let scriptIsRunning = false;
let lightIDs = [];
let lightIDsReady = false;
let scriptIsStarting = false;
let scriptIsStopping = false;

ipcRenderer.on('set-light-ids', (event, ids) => {
    lightIDs = ids;
    lightIDsReady = true;  // Mark lightIDs as ready
    debug("🔧 lightIDs set in renderer:", lightIDs);
});

ipcRenderer.on('reset-lights', async () => {
    if (isTestingColor) {
        info("🔙 Stopping color test and resetting lights...");
        await restorePreviousLightState();
        isTestingColor = false;
        testedColorName = null;
    }

    ipcRenderer.send('lights-reset-complete');
});

ipcRenderer.on('app-is-shutting-down', () => {
    document.body.innerHTML = '<h1 style="color:white;text-align:center">Shutting down...</h1>';
});

setRendererLogFunction((message) => {
    if (
        message.startsWith('[INFO]') ||
        message.startsWith('[WARN]') ||
        message.startsWith('[ERROR]')
    ) {
        const logBox = document.getElementById('log');
        if (logBox) {
            logBox.textContent += message + '\n';
            logBox.scrollTop = logBox.scrollHeight;
        }
    }

    if (message.startsWith('[DEBUG]')) {
        console.log(message);
    } else {
        console.log(message);
    }
});

const logBox = document.getElementById('log');
if (!logBox) {
    console.warn("⚠️ logBox not found. Is #log missing in your HTML?");
}

window.addEventListener('DOMContentLoaded', async () => {
    const isPackaged = await ipcRenderer.invoke('get-is-packaged');

    const defaultConfigPath = isPackaged
        ? path.join(__dirname, 'config.json')
        : path.join(__dirname, 'config.json');

    const defaultColorsPath = isPackaged
        ? path.join(__dirname, 'colors.json')
        : path.join(__dirname, 'colors.json');

    await setupPaths(defaultConfigPath, defaultColorsPath);
    initializeLogger();

    // Migrate missing color fields
    migrateMissingColors();

    initializeApp();
});

function sanitizeColorObject(obj) {
    for (const key in obj) {
        if (obj[key] === null || key === 'undefined') {
            delete obj[key];
        }
    }
    return obj;
}

// Load stuff on page load
function initializeApp() {
    document.querySelectorAll('.toggle-secret').forEach(wrapper => {
        const input = wrapper.querySelector('.secret-input');
        const btn = wrapper.querySelector('.reveal-btn');
        const img = btn.querySelector('img');

        btn.addEventListener('click', () => {
            const visible = input.classList.toggle('visible');
            img.src = visible ? 'img/eye-password-show.svg' : 'img/eye-password-hide.svg';
        });
    });

    // Load and fill config
    let config = {};
    if (fs.existsSync(getConfigPath())) {
        try {
            config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

            // Load log to HTML file and Debug mode
            setHtmlLogEnabled(config.HTML_LOG);
            setDebugMode(config.DEBUG_MODE);
            if (config.LIVE_LOG_LINES !== undefined) {
                setMaxSessionLines(config.LIVE_LOG_LINES);
            }

            // Set light IDs from config
            lightIDs = config.LIGHT_ID.split(',').map(id => id.trim());
            lightIDsReady = true;  // Mark lightIDs as ready
            ipcRenderer.send('set-light-ids', lightIDs); // Send the light IDs to renderer

            document.getElementById('bridgeIP').value = config.BRIDGE_IP || '';
            debug('Bridge IP field value:', document.getElementById('bridgeIP').value);
            document.getElementById('apiKey').value = config.API_KEY || '';
            debug('API-Key field value:', document.getElementById('apiKey').value);
            document.getElementById('serverHost').value = config.SERVER_HOST || '127.0.0.1';
            debug('serverHost field value:', document.getElementById('serverHost').value);
            document.getElementById('serverPort').value = config.SERVER_PORT || 8080;
            debug('serverPort field value:', document.getElementById('serverPort').value);
            document.getElementById('lightIds').value = config.LIGHT_ID || '';
            debug('LightIDs field value:', document.getElementById('lightIds').value);
            document.getElementById('showTimer').value = config.SHOW_BOMB_TIMER ? 'true' : 'false';
            debug('showTimer field value:', document.getElementById('showTimer').value);
            document.getElementById('htmlLog').value = config.HTML_LOG ? 'true' : 'false';
            debug('htmlLog field value:', document.getElementById('htmlLog').value);
            document.getElementById('debugMode').value = config.DEBUG_MODE ? 'true' : 'false';
            debug('debugMode field value:', document.getElementById('debugMode').value);
            document.getElementById('liveLogNumber').value = config.LIVE_LOG_LINES || 1000;
            debug('liveLogNumber field value:', document.getElementById('liveLogNumber').value);

            info("🔧 Loaded config.json");
        } catch (err) {
            error(`❌ Failed to parse config.json: ${err.message}`);
        }
    } else {
        console.warn("⚠️ config.json not found. Please fill out the form and save.");
    }

    const debugSelect = document.getElementById('debugMode');
    if (config.DEBUG_MODE !== undefined) {
        debugSelect.value = config.DEBUG_MODE.toString();
        setDebugMode(config.DEBUG_MODE);
    } else {
        setDebugMode(false); // default fallback
    }
    debugSelect.addEventListener('change', (e) => {
        const enabled = e.target.value === 'true';
        setDebugMode(enabled);
        debug('🐞 Debug mode toggled:', enabled);
    });

    // Bind events
    document.getElementById('saveConfig').addEventListener('click', () => {
        const config = {
            BRIDGE_IP: document.getElementById('bridgeIP').value,
            API_KEY: document.getElementById('apiKey').value,
            SERVER_HOST: document.getElementById('serverHost').value || '127.0.0.1',
            SERVER_PORT: parseInt(document.getElementById('serverPort').value) || 8080,
            LIGHT_ID: document.getElementById('lightIds').value,
            SHOW_BOMB_TIMER: document.getElementById('showTimer').value === 'true',
            HTML_LOG: document.getElementById('htmlLog').value === 'true',
            DEBUG_MODE: document.getElementById('debugMode').value === 'true',
            LIVE_LOG_LINES: document.getElementById('liveLogNumber').value || 1000,
        };

        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 4));
        info("✅ Config saved.");

        // 🔁 Reload fields
        reloadSettings();
        info("🔁 Reloaded config fields after saving.");
    });

    document.getElementById('startScript').addEventListener('click', async () => {
        if (!lightIDsReady) {
            warn("⚠️ lightIDs not ready, cannot start script.");
            return;
        }

        if (isTestingColor) {
            warn("🚫 Cannot start script while color test is active.");
            return;
        }

        if (scriptIsRunning) {
            warn("⚠️ Script already running..");
            return;
        }

        if (scriptIsStarting) {
            warn("⚠️ Script is currently starting.");
            return;
        }

        scriptIsStarting = true;
        setScriptControlsEnabled(false); // 🔒 Disable buttons

        info("▶️ Starting bomb script...");
        const success = await startScript();

        scriptIsStarting = false;
        scriptIsRunning = !!success;
        ipcRenderer.send('set-script-running', scriptIsRunning);
        updateLogButtonVisibility();
        setScriptControlsEnabled(true); // 🔓 Enable buttons

        if (!success) {
            warn("❌ Script failed to start.");
        }
    });

    document.getElementById('stopScript').addEventListener('click', async () => {
        if (scriptIsStarting) {
            warn("⚠️ Script is still starting. Please wait...");
            return;
        }

        if (!scriptIsRunning) {
            warn("⚠️ Script is not currently running.");
            return;
        }

        if (scriptIsStopping) {
            warn("⏳ Script is already stopping...");
            return;
        }

        scriptIsStopping = true;
        setScriptControlsEnabled(false); // 🔒 Disable buttons
        info("🛑 Stopping script...");

        await stopScript(getHueAPI());

        scriptIsRunning = false;
        scriptIsStopping = false;
        ipcRenderer.send('set-script-running', false);
        updateLogButtonVisibility();
        setScriptControlsEnabled(true); // 🔓 Enable buttons
        info("✅ Script stopped!");
    });

    document.getElementById('reloadConfig').addEventListener('click', () => {
        info("🔁 Reloading Settings...");
        reloadSettings();
    });

    document.getElementById('restartScript').addEventListener('click', async () => {
        if (isTestingColor) {
            warn("🚫 Cannot restart script while color test is active.");
            return;
        }
        if (scriptIsStarting || scriptIsStopping) {
            warn("⚠️ Script is busy. Please wait...");
            return;
        }

        setScriptControlsEnabled(false);
        info("🔁 Restarting Script...");

        scriptIsStopping = true;
        await stopScript(getHueAPI());
        scriptIsRunning = false;
        scriptIsStopping = false;

        scriptIsStarting = true;
        const success = await startScript();
        scriptIsRunning = !!success;
        scriptIsStarting = false;

        ipcRenderer.send('set-script-running', scriptIsRunning);
        updateLogButtonVisibility();
        setScriptControlsEnabled(true);
    });

    document.getElementById('openLogBtn').addEventListener('click', () => {
        const serverHost = document.getElementById('serverHost').value || '127.0.0.1';
        const serverPort = document.getElementById('serverPort').value || '8080';
        const url = `http://${serverHost}:${serverPort}/log`;
        require('electron').shell.openExternal(url);
    });

    document.getElementById('openDocBtn').addEventListener('click', () => {
        const serverHost = document.getElementById('serverHost').value || '127.0.0.1';
        const serverPort = document.getElementById('serverPort').value || '8080';
        const url = `http://${serverHost}:${serverPort}/docs/index.html`;
        require('electron').shell.openExternal(url);
    });

    document.getElementById('openConfig').addEventListener('click', () => {
        const folderPath = path.dirname(getConfigPath());
        ipcRenderer.invoke('open-folder', folderPath);
    });

    updateLogButtonVisibility();

    scriptIsRunning = isScriptRunning();
    updateLogButtonVisibility();
}

function pointInTriangle(p, a, b, c) {
    const v0 = [c[0] - a[0], c[1] - a[1]];
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [p[0] - a[0], p[1] - a[1]];

    const dot00 = v0[0] * v0[0] + v0[1] * v0[1];
    const dot01 = v0[0] * v1[0] + v0[1] * v1[1];
    const dot02 = v0[0] * v2[0] + v0[1] * v2[1];
    const dot11 = v1[0] * v1[0] + v1[1] * v1[1];
    const dot12 = v1[0] * v2[0] + v1[1] * v2[1];

    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return u >= 0 && v >= 0 && (u + v < 1);
}

function closestPointOnLine(a, b, p) {
    const ap = [p[0] - a[0], p[1] - a[1]];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const ab2 = ab[0] * ab[0] + ab[1] * ab[1];
    const ap_ab = ap[0] * ab[0] + ap[1] * ab[1];
    const t = Math.max(0, Math.min(1, ap_ab / ab2));
    return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

function closestInGamut(p, gamut) {
    const a = gamut.red;
    const b = gamut.green;
    const c = gamut.blue;

    const pAB = closestPointOnLine(a, b, p);
    const pAC = closestPointOnLine(a, c, p);
    const pBC = closestPointOnLine(b, c, p);

    const d = (p1, p2) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);

    const distances = [
        { pt: pAB, dist: d(p, pAB) },
        { pt: pAC, dist: d(p, pAC) },
        { pt: pBC, dist: d(p, pBC) }
    ];

    distances.sort((a, b) => a.dist - b.dist);
    return distances[0].pt;
}

function rgbToHex(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3) return "#cccccc";

    return (
        "#" +
        rgb
            .map(x => {
                const val = Number(x);
                if (isNaN(val)) return "cc";
                return Math.min(255, Math.max(0, Math.round(val)))
                    .toString(16)
                    .padStart(2, "0");
            })
            .join("")
    );
}

function hexToRgb(hex) {
    const bigint = parseInt(hex.slice(1), 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToXy([r, g, b]) {
    // Normalize
    r /= 255;
    g /= 255;
    b /= 255;

    // Gamma correction
    r = r > 0.04045 ? ((r + 0.055) / 1.055) ** 2.4 : r / 12.92;
    g = g > 0.04045 ? ((g + 0.055) / 1.055) ** 2.4 : g / 12.92;
    b = b > 0.04045 ? ((b + 0.055) / 1.055) ** 2.4 : b / 12.92;

    // Convert to XYZ (Wide RGB D65)
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    let cx = X / (X + Y + Z);
    let cy = Y / (X + Y + Z);

    // Fallback
    if (isNaN(cx)) cx = 0;
    if (isNaN(cy)) cy = 0;

    let xy = [parseFloat(cx.toFixed(4)), parseFloat(cy.toFixed(4))];

    // Clamp to Hue Gamut C
    const GAMUT_C = {
        red: [0.701, 0.299],
        green: [0.172, 0.747],
        blue: [0.135, 0.039]
    };

    if (!pointInTriangle(xy, GAMUT_C.red, GAMUT_C.green, GAMUT_C.blue)) {
        xy = closestInGamut(xy, GAMUT_C);
    }

    return xy;
}

function xyToRgb(xy, bri = 254) {
    const fallback = [200, 200, 200];
    if (!xy) return fallback;

    if (typeof xy === 'string') {
        try {
            const parsed = JSON.parse(xy);
            if (!Array.isArray(parsed) || parsed.length !== 2) return fallback;
            xy = parsed;
        } catch {
            return fallback;
        }
    }

    if (!Array.isArray(xy) || xy.length !== 2 || isNaN(xy[0]) || isNaN(xy[1])) {
        return fallback;
    }

    const [x, y] = xy.map(Number);
    const z = 1.0 - x - y;

    const Y = 1.0; // always max intensity for accurate color
    const X = (Y / y) * x;
    const Z = (Y / y) * z;

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;

    // Gamma correction
    r = r <= 0.0031308 ? 12.92 * r : 1.055 * (r ** (1 / 2.4)) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * (g ** (1 / 2.4)) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * (b ** (1 / 2.4)) - 0.055;

    // Apply brightness after color conversion
    const brightnessScale = bri / 254;

    let rFinal = Math.min(255, Math.max(0, r * 255));
    let gFinal = Math.min(255, Math.max(0, g * 255));
    let bFinal = Math.min(255, Math.max(0, b * 255));

    rFinal = rFinal * brightnessScale;
    gFinal = gFinal * brightnessScale;
    bFinal = bFinal * brightnessScale;

    return [
        Math.round(rFinal),
        Math.round(gFinal),
        Math.round(bFinal)
    ];
}

function getBrightnessFromRgb([r, g, b]) {
    return Math.round(Math.max(r, g, b) / 255 * 254);
}

// Load and show colors from colors.json
let isTestingColor = false;
let testedColorName = null;
let previousStateCache = {};

function loadColors() {
    const colorsContainer = document.getElementById('colorsDisplay');
    colorsContainer.innerHTML = '';

    const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));

    let needsMigration = false;

    Object.entries(colors).forEach(([name, color]) => {
        const xy = color.xy;

        let parsed = null;
        if (Array.isArray(xy) && xy.length === 2) {
            parsed = xy;
        } else if (typeof xy === 'string') {
            try {
                const temp = JSON.parse(xy);
                if (Array.isArray(temp) && temp.length === 2) {
                    parsed = temp;
                }
            } catch {
                warn("⚠️ Migration of XY values failed.")
            }
        }

        if (parsed) {
            color.x = parsed[0];
            color.y = parsed[1];
            delete color.xy;
            needsMigration = true;
        }
    });

    if (needsMigration) {
        fs.writeFileSync(getColorsPath(), JSON.stringify(colors, null, 4));
        info("✅ Migrated old xy format to x/y and saved to colors.json");
    }

    const colorKeys = Object.keys(colors);

    for (const name of colorKeys) {
        const color = colors[name];

        if (!('enabled' in color)) {
            color.enabled = true;
        }

        const wrapper = document.createElement('div');
        wrapper.classList.add('color-item');

        let rgb = [200, 200, 200];
        const bri = typeof color.bri === 'number' ? color.bri : 254;

        if (typeof color.x === 'number' && typeof color.y === 'number') {
            try {
                const xy = [color.x, color.y];
                rgb = xyToRgb(xy, bri);

                // Override hex ONLY if xy+brightness exactly matches original RGB color
                if (color.bri === 254 && color.x === 0.6401 && color.y === 0.33) {
                    rgb = [255, 0, 0];
                }
            } catch {
                warn(`⚠️ Failed to convert xy for ${name}`);
            }
        }
        const hex = rgbToHex(rgb);
        debug(`🔍 ${name}: XY [${color.x}, ${color.y}] @ bri ${bri} → ${hex}`);

        const label = document.createElement('strong');
        label.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        wrapper.appendChild(label);

        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.value = hex;
        colorPicker.style.width = '100%';
        colorPicker.style.margin = '10px 0';
        colorPicker.dataset.name = name;
        wrapper.appendChild(colorPicker);

        const briLabel = document.createElement('label');
        briLabel.textContent = 'Brightness (bri):';
        wrapper.appendChild(briLabel);

        const briInput = document.createElement('input');
        briInput.type = 'number';
        briInput.min = 1;
        briInput.max = 254;
        briInput.value = color.bri ?? '';
        briInput.dataset.name = name;
        briInput.dataset.key = 'bri';
        wrapper.appendChild(briInput);

        const xyLabel = document.createElement('label');
        xyLabel.textContent = 'XY:';
        wrapper.appendChild(xyLabel);

        const xInput = document.createElement('input');
        xInput.type = 'number';
        xInput.step = '0.0001';
        xInput.min = 0;
        xInput.max = 1;
        xInput.placeholder = 'x';
        xInput.value = typeof color.x === 'number' ? color.x : '';
        xInput.dataset.name = name;
        xInput.dataset.key = 'x';
        wrapper.appendChild(xInput);

        const yInput = document.createElement('input');
        yInput.type = 'number';
        yInput.step = '0.0001';
        yInput.min = 0;
        yInput.max = 1;
        yInput.placeholder = 'y';
        yInput.value = typeof color.y === 'number' ? color.y : '';
        yInput.dataset.name = name;
        yInput.dataset.key = 'y';
        wrapper.appendChild(yInput);

        const ctLabel = document.createElement('label');
        ctLabel.textContent = 'Color Temp (ct):';
        wrapper.appendChild(ctLabel);

        const ctInput = document.createElement('input');
        ctInput.type = 'number';
        ctInput.min = 153;
        ctInput.max = 500;
        ctInput.value = color.ct ?? '';
        ctInput.dataset.name = name;
        ctInput.dataset.key = 'ct';
        wrapper.appendChild(ctInput);

        const useCtLabel = document.createElement('label');
        useCtLabel.style.display = "flex";
        useCtLabel.style.alignItems = "center";
        useCtLabel.style.gap = "6px";

        const toggleContainer = document.createElement('div');
        toggleContainer.className = 'toggle-container';

        // Left side text with icon
        const toggleText = document.createElement('span');
        toggleText.className = 'toggle-text';
        toggleText.textContent = color.useCt ? '🌡️ CT' : '🎨 XY';

        // Actual toggle switch container
        const toggleSwitch = document.createElement('label');
        toggleSwitch.className = 'toggle-switch';

        // Checkbox input
        const useCtCheckbox = document.createElement('input');
        useCtCheckbox.type = 'checkbox';
        useCtCheckbox.dataset.name = name;
        useCtCheckbox.dataset.key = 'useCt';
        useCtCheckbox.checked = color.useCt === true;

        // Slider span
        const sliderSpan = document.createElement('span');
        sliderSpan.className = 'toggle-slider';

        // Put checkbox and slider inside label
        toggleSwitch.appendChild(useCtCheckbox);
        toggleSwitch.appendChild(sliderSpan);

        const toggleWrapper = document.createElement('span');
        toggleWrapper.className = 'toggle-wrapper';
        toggleWrapper.appendChild(toggleText);
        toggleWrapper.appendChild(toggleSwitch);

        toggleContainer.appendChild(toggleWrapper);
        wrapper.appendChild(toggleContainer);

        // Enable/disable logic
        ctInput.disabled = !useCtCheckbox.checked;
        xInput.disabled = yInput.disabled = useCtCheckbox.checked;
        useCtCheckbox.addEventListener('change', () => {
            const useCt = useCtCheckbox.checked;
            ctInput.disabled = !useCt;
            xInput.disabled = yInput.disabled = useCt;
            toggleText.textContent = useCt ? '🌡️ CT' : '🎨 XY';
        });

        colorPicker.addEventListener('input', () => {
            const newRgb = hexToRgb(colorPicker.value);
            const [newX, newY] = rgbToXy(newRgb);
            const newBri = getBrightnessFromRgb(newRgb);

            xInput.value = newX;
            yInput.value = newY;
            briInput.value = newBri;

            color.x = newX;
            color.y = newY;
            color.bri = newBri;
        });

        // Create Wrapper for Enabled Toggle
        const enabledWrapper = document.createElement('div');
        enabledWrapper.className = 'enabled-wrapper';

        wrapper.appendChild(enabledWrapper);

        // "Enabled" toggle
        const enabledToggleContainer = document.createElement('div');
        enabledToggleContainer.className = 'toggle-container';

        const enabledToggleText = document.createElement('span');
        enabledToggleText.className = 'toggle-text';
        enabledToggleText.textContent = color.enabled !== false ? '✅ Enabled' : '🚫 Disabled';

        const enabledToggleSwitch = document.createElement('label');
        enabledToggleSwitch.className = 'toggle-switch';

        const enabledCheckbox = document.createElement('input');
        enabledCheckbox.type = 'checkbox';
        enabledCheckbox.dataset.name = name;
        enabledCheckbox.dataset.key = 'enabled';
        enabledCheckbox.checked = color.enabled !== false;

        const enabledSlider = document.createElement('span');
        enabledSlider.className = 'toggle-slider';

        enabledToggleSwitch.appendChild(enabledCheckbox);
        enabledToggleSwitch.appendChild(enabledSlider);

        const enabledToggleWrapper = document.createElement('span');
        enabledToggleWrapper.className = 'toggle-wrapper';
        enabledToggleWrapper.appendChild(enabledToggleText);
        enabledToggleWrapper.appendChild(enabledToggleSwitch);

        enabledToggleContainer.appendChild(enabledToggleWrapper);

        if (color.enabled === false) {
            // Make sure the enabled checkbox works normally
            enabledCheckbox.disabled = false;

            // CSS
            wrapper.classList.add('disabled');
        }

        // Make toggle live
        enabledCheckbox.addEventListener('change', () => {
            const isEnabled = enabledCheckbox.checked;
            wrapper.classList.toggle('disabled', !isEnabled);

            enabledToggleText.textContent = isEnabled ? '✅ Enabled' : '🚫 Disabled';

            // Disable inner controls
            colorPicker.disabled = !isEnabled;
            briInput.disabled = !isEnabled;
            xInput.disabled = !isEnabled && !useCtCheckbox.checked;
            yInput.disabled = !isEnabled && !useCtCheckbox.checked;
            ctInput.disabled = !isEnabled || !useCtCheckbox.checked;
            useCtCheckbox.disabled = !isEnabled;
        });

        // Test Button
        const testSavedButton = document.createElement('button');
        testSavedButton.textContent = '💾 Test Saved';
        testSavedButton.className = 'test-color-btn';
        testSavedButton.dataset.name = name;
        wrapper.appendChild(testSavedButton);

        // Test Live View Button
        const testLiveButton = document.createElement('button');
        testLiveButton.textContent = '🎨 Test Live';
        testLiveButton.className = 'test-live-color-btn';
        testLiveButton.dataset.name = name;
        wrapper.appendChild(testLiveButton);

        // Shared test function
        async function handleColorTest(colorSourceFn, button) {
            if (isTestingColor && testedColorName === name) {
                await restorePreviousLightState();
                info(`🔙 Stopped testing "${name}"`);
                isTestingColor = false;
                testedColorName = null;
                testSavedButton.textContent = '💾 Test Saved';
                testLiveButton.textContent = '🎨 Test Live';
                ipcRenderer.send('color-test-status', isTestingColor);
                return;
            }

            if (isTestingColor) {
                warn(`⚠️ Already testing "${testedColorName}". Stop that first.`);
                return;
            }

            if (isScriptRunning()) {
                info("🚫 Cannot test while script is running.");
                return;
            }

            if (!fs.existsSync(getConfigPath())) return;
            const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
            const ids = config.LIGHT_ID.split(',').map(id => id.trim());
            const hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`;

            ipcRenderer.send('set-light-ids', ids);
            ipcRenderer.send('set-hue-api', hueAPI);

            const inSync = await anyLightInSyncMode();
            if (inSync) {
                info("🚫 One or more lights are in sync/entertainment mode.");
                return;
            }

            previousStateCache = {};
            for (const id of ids) {
                try {
                    const res = await fetch(`${hueAPI}/lights/${id}`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const body = await res.json();
                    previousStateCache[id] = body.state;
                } catch (err) {
                    error(`❌ Failed to fetch state for light ${id}: ${err.message}`);
                    return;
                }
            }

            const color = await colorSourceFn();  // Fetch color dynamically
            const body = { on: true, bri: color.bri ?? 200 };

            if (color.useCt && typeof color.ct === 'number') {
                body.ct = color.ct;
            } else if (typeof color.x === 'number' && typeof color.y === 'number') {
                body.xy = [color.x, color.y];
            }

            for (const id of ids) {
                try {
                    const response = await fetch(`${hueAPI}/lights/${id}/state`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                } catch (err) {
                    error(`❌ Failed to set color on light ${id}: ${err.message}`);
                }
            }

            isTestingColor = true;
            testedColorName = name;
            testSavedButton.textContent = '⛔ Stop Test';
            testLiveButton.textContent = '⛔ Stop Test';
            ipcRenderer.send('color-test-status', isTestingColor);

            let watchdogInterval = setInterval(async () => {
                if (!isTestingColor) {
                    clearInterval(watchdogInterval);
                    return;
                }

                try {
                    for (const id of ids) {
                        const res = await fetch(`${hueAPI}/lights/${id}`);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const data = await res.json();
                        if (data.state?.reachable === false) {
                            throw new Error(`Light ${id} not reachable`);
                        }
                    }
                } catch (err) {
                    error(`❌ Lost connection during test: ${err.message}`);
                    await restorePreviousLightState();
                    isTestingColor = false;
                    testedColorName = null;
                    testSavedButton.textContent = '💾 Test Saved';
                    testLiveButton.textContent = '🎨 Test Live';
                    ipcRenderer.send('color-test-status', isTestingColor);
                    clearInterval(watchdogInterval);
                }
            }, 3000);
        }

        // Button Events
        testSavedButton.addEventListener('click', () =>
            handleColorTest(async () => {
                const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));
                return colors[name];
            }, testSavedButton)
        );

        testLiveButton.addEventListener('click', () =>
            handleColorTest(async () => {
                // 🔧 Replace this with live color source (e.g., from UI input fields)
                return getLiveColor(name); // Example: your own function to fetch from inputs
            }, testLiveButton)
        );

        enabledWrapper.appendChild(enabledToggleContainer);
        colorsContainer.appendChild(wrapper);
    }

    // Add invisible filler blocks to balance layout
    const columns = 4; // change if your grid uses different column count
    const remainder = colorKeys.length % columns;
    if (remainder !== 0) {
        const fillers = columns - remainder;
        for (let i = 0; i < fillers; i++) {
            const filler = document.createElement('div');
            filler.classList.add('color-item');
            filler.style.visibility = 'hidden';
            colorsContainer.appendChild(filler);
        }
    }
}

async function restorePreviousLightState() {
    if (!previousStateCache || !fs.existsSync(getConfigPath())) return;

    const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    const ids = config.LIGHT_ID.split(',').map(id => id.trim());
    ipcRenderer.send('set-light-ids', ids);
    const hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`;

    for (const id of ids) {
        const prev = previousStateCache[id];
        if (!prev) continue;

        const body = {
            on: prev.on,
            bri: prev.bri
        };
        if (prev.xy) body.xy = prev.xy;
        if (typeof prev.ct === 'number') body.ct = prev.ct;

        try {
            const response = await fetch(`${hueAPI}/lights/${id}/state`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} - ${response.statusText}`);
            }
        } catch (err) {
            error(`❌ Failed to restore light ${id} state: ${err.message}`);
        }
    }

    previousStateCache = {};
}

document.getElementById('saveColors').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#colorsDisplay input');
    const newColors = {};

    inputs.forEach(input => {
        const name = input.dataset.name;
        const key = input.dataset.key;

        if (!newColors[name]) newColors[name] = {};

        if (key === 'enabled') {
            newColors[name][key] = input.checked;
            return;
        }

        if (key === 'useCt') {
            newColors[name][key] = input.checked;
            return;
        }

        switch (key) {
            case 'x':
                newColors[name].x = parseFloat(input.value) || 0.5;
                break;
            case 'y':
                newColors[name].y = parseFloat(input.value) || 0.5;
                break;
            case 'useCt':
                newColors[name].useCt = input.checked;
                break;
            default:
                if (input.value !== '') {
                    newColors[name][key] = parseInt(input.value);
                }
        }
    });

    // 🧼 Sanitize all color objects
    for (const name in newColors) {
        sanitizeColorObject(newColors[name]);
    }

    const existing = fs.existsSync(getColorsPath())
        ? JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'))
        : {};

    const merged = { ...existing, ...newColors };
    fs.writeFileSync(getColorsPath(), JSON.stringify(merged, null, 4));
    info("✅ Saved and sanitized colors.json");

    // Reload Color Settings
    loadColors();
});

function loadBombSettings() {
    const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));
    const bomb = colors.bomb;
    const stages = bomb?.stages || {};
    const container = document.getElementById('bombStagesGrid');
    container.innerHTML = ''; // Clear grid

    // 🧨 Initial Bomb Settings Card
    const initialWrapper = document.createElement('div');
    initialWrapper.classList.add('color-item', 'initial-bomb-card');

    const title = document.createElement('strong');
    title.textContent = '💣 Initial Bomb Settings';
    initialWrapper.appendChild(title);

    const initialLabel = document.createElement('label');
    initialLabel.textContent = 'Initial Bomb Time (s)';
    initialWrapper.appendChild(initialLabel);

    const initialInput = document.createElement('input');
    initialInput.type = 'number';
    initialInput.min = 5;
    initialInput.max = 90;
    initialInput.value = bomb?.initialTime || 40;
    initialInput.classList.add('initial-time');
    initialWrapper.appendChild(initialInput);

    const initialSpeedLabel = document.createElement('label');
    initialSpeedLabel.textContent = 'Initial Blink Speed (ms)';
    initialWrapper.appendChild(initialSpeedLabel);

    const initialSpeedInput = document.createElement('input');
    initialSpeedInput.type = 'number';
    initialSpeedInput.min = 0;
    initialSpeedInput.value = bomb?.initialBlinkSpeed ?? '';
    initialSpeedInput.classList.add('initial-speed');
    initialWrapper.appendChild(initialSpeedInput);

    container.appendChild(initialWrapper);

    // 🔁 Sort stages descending by time
    const sortedStages = Object.entries(stages)
        .sort((a, b) => Number(b[0]) - Number(a[0]));

    sortedStages.forEach(([seconds, { bri, speed }]) => {
        const card = document.createElement('div');
        card.className = 'color-item';
        card.dataset.seconds = seconds;

        const title = document.createElement('strong');
        title.textContent = `${seconds}s`;
        card.appendChild(title);

        const briLabel = document.createElement('label');
        briLabel.textContent = 'Brightness';
        card.appendChild(briLabel);

        const briInput = document.createElement('input');
        briInput.type = 'number';
        briInput.min = 1;
        briInput.max = 254;
        briInput.value = bri ?? '';
        briInput.classList.add('bri-input');
        card.appendChild(briInput);

        const speedLabel = document.createElement('label');
        speedLabel.textContent = 'Blink Speed (ms)';
        card.appendChild(speedLabel);

        const speedInput = document.createElement('input');
        speedInput.type = 'number';
        speedInput.min = 0;
        speedInput.value = speed ?? '';
        speedInput.classList.add('speed-input');
        card.appendChild(speedInput);

        container.appendChild(card);
    });

    // ➕ Add filler blocks for grid symmetry
    const stageCount = sortedStages.length;
    const columns = 4;
    const remainder = (stageCount + 1) % columns; // +1 for initial card
    if (remainder !== 0) {
        const fillers = columns - remainder;
        for (let i = 0; i < fillers; i++) {
            const filler = document.createElement('div');
            filler.classList.add('color-item');
            filler.style.visibility = 'hidden';
            container.appendChild(filler);
        }
    }
}

document.getElementById('saveBombSettings').addEventListener('click', () => {
    if (!fs.existsSync(getColorsPath())) return;

    const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));
    if (!colors.bomb) colors.bomb = {};
    if (!colors.bomb.stages) colors.bomb.stages = {};

    const cards = document.querySelectorAll('#bombStagesGrid .color-item');
    const newStages = {};

    cards.forEach(card => {
        const seconds = card.dataset.seconds;
        if (!seconds) return;

        const bri = parseInt(card.querySelector('.bri-input').value);
        const speed = parseInt(card.querySelector('.speed-input').value);

        newStages[seconds] = {
            bri: isNaN(bri) ? undefined : bri,
            speed: isNaN(speed) ? undefined : speed
        };
    });

    // ⏱️ Save initial bomb time
    const initialInput = document.querySelector('.initial-time');
    const initialSpeedInput = document.querySelector('.initial-speed');

    colors.bomb.initialTime = parseInt(initialInput.value) || 40;

    const blinkSpeed = parseInt(initialSpeedInput.value);
    colors.bomb.initialBlinkSpeed = isNaN(blinkSpeed) ? undefined : blinkSpeed;

    // 💾 Save new stages
    colors.bomb.stages = newStages;

    fs.writeFileSync(getColorsPath(), JSON.stringify(colors, null, 4));
    info("✅ Bomb stages and settings saved to colors.json");

    // Reload Bomb Settings
    loadBombSettings();
});

function reloadSettings() {
    const savedConfig = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

    // Set light IDs from config
    lightIDs = savedConfig.LIGHT_ID.split(',').map(id => id.trim());
    lightIDsReady = true;
    ipcRenderer.send('set-light-ids', lightIDs);

    document.getElementById('bridgeIP').value = savedConfig.BRIDGE_IP || '';
    document.getElementById('apiKey').value = savedConfig.API_KEY || '';
    document.getElementById('serverHost').value = savedConfig.SERVER_HOST || '127.0.0.1';
    document.getElementById('serverPort').value = savedConfig.SERVER_PORT || 8080;
    document.getElementById('lightIds').value = savedConfig.LIGHT_ID || '';
    document.getElementById('showTimer').value = savedConfig.SHOW_BOMB_TIMER ? 'true' : 'false';
    document.getElementById('htmlLog').value = savedConfig.HTML_LOG ? 'true' : 'false';
    document.getElementById('liveLogNumber').value = savedConfig.LIVE_LOG_LINES || 1000;
    document.getElementById('debugMode').value = savedConfig.DEBUG_MODE ? 'true' : 'false';
    setDebugMode(savedConfig.DEBUG_MODE);
    setHtmlLogEnabled(savedConfig.HTML_LOG);
    if (savedConfig.LIVE_LOG_LINES !== undefined) {
        setMaxSessionLines(savedConfig.LIVE_LOG_LINES);
    }
    loadColors();
    loadBombSettings();
    ipcRenderer.send('set-hue-api', `http://${config.BRIDGE_IP}/api/${config.API_KEY}`);
    info("✅ Reload completed.")
}

function updateLogButtonVisibility() {
    const openLogBtn = document.getElementById('openLogBtn');
    const openDocBtn = document.getElementById('openDocBtn');

    if (!openLogBtn) return;
    if (!openDocBtn) return;

    openLogBtn.style.display = scriptIsRunning ? 'inline-block' : 'none';
    openDocBtn.style.display = scriptIsRunning ? 'inline-block' : 'none';
}

async function setupPaths() {
    const isPackaged = await ipcRenderer.invoke('get-is-packaged');
    let basePath;

    if (isPackaged) {
        basePath = await ipcRenderer.invoke('get-user-data-path');
        setBasePath(basePath);

        const defaultConfigPath = path.join(__dirname, 'config.json');
        const defaultColorsPath = path.join(__dirname, 'colors.json');

        if (!fs.existsSync(getConfigPath())) {
            const contents = fs.readFileSync(defaultConfigPath, 'utf-8');
            fs.writeFileSync(getConfigPath(), contents);
            info("✅ Copied default config.json to user path");
        }

        if (!fs.existsSync(getColorsPath())) {
            const contents = fs.readFileSync(defaultColorsPath, 'utf-8');
            fs.writeFileSync(getColorsPath(), contents);
            info("✅ Copied default colors.json to user path");
        }
    } else {
        basePath = path.resolve(__dirname); // dev mode
        setBasePath(basePath);
        debug("🛠️ Dev mode: using local files only, no copying.");
    }

    // ✅ Ensure backups directory exists
    const backupDir = getBackupPath();
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
        info("📁 Created backups directory at: " + backupDir);
    }

    debug("📁 ConfigPath: " + getConfigPath());
    debug("📁 ColorsPath: " + getColorsPath());
    debug("📁 BackupPath: " + getBackupPath());

    loadColors();
    loadBombSettings();
}

function setScriptControlsEnabled(enabled) {
    const startBtn = document.getElementById('startScript');
    const stopBtn = document.getElementById('stopScript');
    const restartBtn = document.getElementById('restartScript');

    if (startBtn) startBtn.disabled = !enabled;
    if (stopBtn) stopBtn.disabled = !enabled;
    if (restartBtn) restartBtn.disabled = !enabled;
}

function getLiveColor(name) {
    const getInput = (key) =>
        document.querySelector(`input[data-name="${name}"][data-key="${key}"]`);

    const parseFloatOrUndefined = (val) =>
        val !== '' && !isNaN(val) ? parseFloat(val) : undefined;

    const parseIntOrUndefined = (val) =>
        val !== '' && !isNaN(val) ? parseInt(val, 10) : undefined;

    const x = parseFloatOrUndefined(getInput('x')?.value);
    const y = parseFloatOrUndefined(getInput('y')?.value);
    const bri = parseIntOrUndefined(getInput('bri')?.value);
    const ct = parseIntOrUndefined(getInput('ct')?.value);
    const useCt = getInput('useCt')?.checked === true;

    const color = { bri, useCt };

    if (useCt && ct !== undefined) {
        color.ct = ct;
    } else if (!useCt && x !== undefined && y !== undefined) {
        color.x = x;
        color.y = y;
    } else {
        throw new Error(`❌ Invalid inputs for live color "${name}". Missing required fields.`);
    }

    return color;
}
