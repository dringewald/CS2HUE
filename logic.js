const { getConfigPath, getColorsPath, getPreviousStatePath, getGamestatePath } = require('./paths');
const { info, warn, error, debug, getFullSessionHtml, clearSessionLog } = require('./logger');

const path = require('path');
const fsPromises = require('fs').promises;

const http = require('http');
const fs = require('fs');
const HueController = require('./controllers/hueController');
const YeelightController = require('./controllers/yeelightController');
let controller = null;
let provider = 'hue';

let config;
let colors;
let lightIDs = [];
let hueAPI;
let isTimerEnabled;

let server;
let isRunning = false;

let isFirstPoll = true;
let gameState = {};
const HEALTHCHECK_WARN_COOLDOWN = 10000;
const GAMESTATE_MISSING_WARN_COOLDOWN = 10000;
const RETRY_FAIL_COOLDOWN = 10000;
const FIRST_POLL_INFO_COOLDOWN = 10000;
let lastHealthCheck = Date.now();
let lastGamestateMissingWarn = 0;
let lastRetryFailWarn = 0;
let lastFirstPollLog = 0;
let gamestateHadError = false;

let isBombPlanted = false;
let isBombExploded = false;
let isBombDefused = false;
let userTeam = '';
let blinkEffect = [];
let isFading = false;
let isBlinking = false;
let bombCountdown;
let timer;
let lastColorMode = null;
let roundEnded = false;
let delayWinLossColor = false;
let suppressColorUntilNextRound = false;
let hasLoggedFadeWarning = false;
let hasLoggedMissingPlayerWarning = false;
let defusedHandled = false;
let explodedHandled = false;
let hasLoggedBombReset = false;
let pollerActive = false;
let isWritingGameState = false;
let suppressDefaultColor = false;

// logic.js
async function loadConfig() {
    const configPath = getConfigPath();
    const colorsFilePath = getColorsPath();

    if (!fs.existsSync(configPath)) {
        throw new Error("config.json is missing in user data path");
    }

    if (!fs.existsSync(colorsFilePath)) {
        throw new Error("colors.json is missing in user data path");
    }

    config = JSON.parse(await fsPromises.readFile(configPath, 'utf-8'));
    colors = JSON.parse(await fsPromises.readFile(colorsFilePath, 'utf-8'));

    try {
        const raw = (config.LIGHT_ID || '').trim();
        lightIDs = raw ? raw.split(',').map(id => id.trim()).filter(Boolean) : [];
    } catch (err) {
        error(`❌ Failed to get Light IDs from config: ${err.message}`);
        return;
    }

    for (const name in colors) {
        const color = colors[name];
        for (const key in color) {
            if (color[key] === null || key === 'undefined') {
                delete color[key];
            }
        }
        if (!('enabled' in color)) {
            color.enabled = true;
        }
    }

    provider = (config.PROVIDER || 'hue').toLowerCase();

    if (provider === 'yeelight') {
        let devices = String(config.YEELIGHT_DEVICES || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(token => {
                const [host, portStr] = token.split(':');
                return { host, port: Number(portStr || 55443) };
            });

        if (config.YEELIGHT_DISCOVERY === true && devices.length === 0) {
            try {
                const discovered = await YeelightController.discover(2500);
                if (discovered.length) {
                    devices = discovered;
                    info(`🔎 Yeelight discovery found ${devices.length} device(s).`);
                } else {
                    warn("⚠️ Yeelight discovery found no devices.");
                }
            } catch (e) {
                warn(`⚠️ Yeelight discovery failed: ${e.message}`);
            }
        }

        controller = new YeelightController({ devices });

        {
            const zeros = lightIDs.filter(id => Number(id) === 0);
            if (zeros.length) {
                warn('⚠️ Yeelight LIGHT_ID must start at 1. Remove 0 from LIGHT_ID.');
            }
            if (!controller.devices?.length) {
                warn('⚠️ No Yeelight devices configured/reachable.');
            } else {
                const max = controller.devices.length;
                const outOfRange = lightIDs.filter(id => Number(id) < 1 || Number(id) > max);
                if (outOfRange.length) {
                    warn(`⚠️ Some LIGHT_IDs are out of range (1..${max}): ${outOfRange.join(', ')}`);
                }
            }
        }
    } else {
        controller = new HueController({
            bridgeIP: config.BRIDGE_IP,
            apiKey: config.API_KEY
        });

        setHueAPI(`http://${config.BRIDGE_IP}/api/${config.API_KEY}`);
    }

    isTimerEnabled = !!config.SHOW_BOMB_TIMER;
}

async function ensureControllerReady() {
    if (controller) return;
    try {
        await loadConfig(); // this constructs HueController or YeelightController
    } catch (e) {
        error(`❌ Controller init failed: ${e.message}`);
        throw e;
    }
}

function forEachLight(callback) {
    lightIDs.forEach(light => callback(light));
}

async function getLightData(light) {
    try {
        await ensureControllerReady();
        return await controller.getState(light);
    } catch (e) {
        error(e.message);
        return {};
    }
}

const lightQueues = new Map();
const MIN_GAP_MS = 60;              // small per-light pause after each PUT

const sleep = (ms) => new Promise(r => setTimeout(r, ms));


async function updateLightData(light, body) {
    const prev = lightQueues.get(light) || Promise.resolve();

    const next = prev.then(async () => {
        try {
            await ensureControllerReady();
            await controller.setState(light, body);
            await sleep(MIN_GAP_MS);
            return true;
        } catch (e) {
            error(`Update failed for ${light}: ${e.message}`);
            return false;
        }
    });

    lightQueues.set(light, next);
    return next;
}

async function sendColorToAllLights(color) {
    if (!color || color.enabled === false) { info("⛔ Color disabled/missing"); return; }

    const body = { on: true };
    if (color.useCt && typeof color.ct === 'number') {
        body.ct = color.ct;
        if (provider === 'yeelight') body.useCt = true;
    } else if (typeof color.x === 'number' && typeof color.y === 'number') body.xy = [color.x, color.y];
    if (typeof color.bri === 'number') body.bri = color.bri;

    // write with slight staggering to avoid bursts
    for (let i = 0; i < lightIDs.length; i++) {
        updateLightData(lightIDs[i], body);
        await new Promise(r => setTimeout(r, 12)); // ~12ms between PUTs
    }
}

function blinkAllLights(speed, repetition = Infinity) {
    // stop previous blinks
    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
    }

    isBlinking = true;

    let cycles = 0;
    let isOn = false;

    const interval = setInterval(async () => {
        isOn = !isOn;

        // fan out with a tiny stagger to avoid a PUT burst on the bridge
        for (let i = 0; i < lightIDs.length; i++) {
            updateLightData(lightIDs[i], { on: isOn });
            if (i) await new Promise(r => setTimeout(r, 8));
        }

        // keep original “count ON edges” semantics
        if (isOn) {
            cycles++;
            if (repetition !== Infinity && cycles >= repetition) {
                clearInterval(interval);
                isBlinking = false;
            }
        }
    }, Math.max(120, speed | 0)); // clamp a bit for bridge stability

    blinkEffect = [interval];
    return blinkEffect;
}

function changeAllBrightness(value) {
    return Promise.all(lightIDs.map(light => updateLightData(light, { on: true, bri: value })));
}

function resetBombState() {
    if (!hasLoggedBombReset) {
        debug("🔁 Resetting bomb state...");
        hasLoggedBombReset = true;
    }
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
        isBlinking = false;
    }


    isBombPlanted = false;
    isBombExploded = false;
    isBombDefused = false;
    bombCountdown = null;
    lastColorMode = null;
    defusedHandled = false;
    explodedHandled = false;
}

async function bombPlanted() {
    const initialTime = colors.bomb?.initialTime || 40;
    bombCountdown = initialTime;


    const color = colors.bomb;
    if (color && color.enabled !== false) {
        debug("💡 Setting bomb color");

        const hasBri = typeof color.bri === 'number';
        const fallbackBri = 20;

        if (!hasBri) {
            warn(`⚠️ No brightness set for bomb color — using fallback: ${fallbackBri}`);
            changeAllBrightness(fallbackBri);
        }

        await sendColorToAllLights(color);
    } else {
        info("⛔ Bomb color is disabled or missing");
    }

    const initialSpeed = colors.bomb?.initialStage?.speed;

    if (typeof initialSpeed === 'number' && initialSpeed > 0) {
        debug(`💡 Starting blink effect with speed ${initialSpeed}ms`);
        blinkEffect = blinkAllLights(initialSpeed);
    } else {
        debug("💡 Starting default blink (1000ms)");
        blinkEffect = blinkAllLights(1000);
    }

    debug("✅ Bomb planted logic started");

    // Define fallback brightness (seconds:brightness)
    const fallbackBriMap = {
        30: 20,
        20: 35,
        12: 50,
        5: 100,
        2: 150
    };

    // Define fallback speed (seconds:speed in ms)
    const fallbackSpeedMap = {
        30: 750,
        20: 500,
        12: 250,
        5: 150,
        2: 0
    };

    timer = setInterval(() => {
        if (!isBombPlanted || isBombDefused || isBombExploded || roundEnded || suppressColorUntilNextRound) {
            debug(`⛔ Bomb timer stopped due to state change at ${bombCountdown}s`);
            clearInterval(timer);
            timer = null;
            return;
        }

        bombCountdown--;

        if ([30, 20, 12, 5, 2].includes(bombCountdown)) {
            // 🛑 Abort if round ended
            if (roundEnded || suppressColorUntilNextRound) {
                debug(`⛔ Ignoring stage logic at ${bombCountdown}s — new round already started.`);
                return;
            }

            if (isTimerEnabled) info(`⏱ Timer: ${bombCountdown}s`);

            if (blinkEffect.length) {
                blinkEffect.forEach(clearInterval);
                blinkEffect = [];
                isBlinking = false;
            }

            const stage = colors.bomb?.stages?.[bombCountdown] || {};
            const speed = stage.speed ?? fallbackSpeedMap[bombCountdown];
            const bri = stage.bri ?? fallbackBriMap[bombCountdown];

            if (bri != null) {
                debug(`🔆 Changing brightness to ${bri} at ${bombCountdown}s`);
                changeAllBrightness(bri);
            }

            if (speed > 0) {
                debug(`💡 Starting blink at ${speed}ms interval`);
                blinkEffect = blinkAllLights(speed);
            } else if (speed === 0) {
                debug(`💡 Speed is 0 at ${bombCountdown}s — stopping blinking and forcing lights ON.`);
                forEachLight(light => updateLightData(light, { on: true }));
            } else {
                warn(`⚠️ Unexpected speed value: ${speed} at ${bombCountdown}s`);
            }
        }

        if (bombCountdown === 0) {
            clearInterval(timer);
            if (blinkEffect.length) {
                blinkEffect.forEach(clearInterval);
                blinkEffect = [];
                isBlinking = false;
            }
        }
    }, 1000);
}

async function bombExploded() {
    debug("💥 Bomb exploded!");

    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
        isBlinking = false;
    }

    info("💥 BOOM");

    if (colors.exploded) {
        await sendColorToAllLights(colors.exploded);
    }

    delayWinLossColor = true;
    setTimeout(() => delayWinLossColor = false, 2000);
}

async function bombDefused() {
    debug("🛡 Handling bomb defused...");

    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
        isBlinking = false;
    }

    info("🛡 Bomb has been defused");

    if (colors.defused) {
        await sendColorToAllLights(colors.defused);
    }

    delayWinLossColor = true;
    setTimeout(() => delayWinLossColor = false, 2000);
}

function setDefaultColor() {
    if (!isRunning) {
        debug("🛑 Skipping default color — script is not running.");
        return;
    }
    if (suppressDefaultColor) {
        debug("⏸️ Default color temporarily suppressed");
        return;
    }
    if (isBombPlanted || isFading || isBlinking) {
        info("⛔ Default color suppressed — bomb or effect is active");
        return;
    }
    if (lastColorMode && lastColorMode !== 'default') {
        info("ℹ️ Skipping default color — already using mode: " + lastColorMode);
        return;
    }

    const color = colors.default;
    if (!color || color.enabled === false) {
        info("⛔ Default color is disabled or missing");
        return;
    }

    info("🌈 Setting default color");

    const { x, y, ct, bri, on = true } = color;
    const body = { on };

    if (color.useCt && typeof ct === 'number') {
        body.ct = ct;
        if (provider === 'yeelight') body.useCt = true;
    } else if (typeof x === 'number' && typeof y === 'number') {
        body.xy = [x, y];
    }

    if (typeof bri === 'number') {
        body.bri = bri;
    }

    forEachLight(light => updateLightData(light, body));
}

function setUserTeamColor() {
    if (!userTeam || userTeam !== gameState.player.team) {
        userTeam = gameState.player.team;
        debug("User is: " + userTeam);
    }

    const color = colors[userTeam];

    if (!color || color.enabled === false) {
        info(`⛔ Team color for "${userTeam}" is disabled or missing`);
        return;
    }

    const { x, y, ct, bri, on = true } = color;
    const body = { on };

    if (color.useCt && typeof ct === 'number') {
        body.ct = ct;
        if (provider === 'yeelight') body.useCt = true;
    } else if (typeof x === 'number' && typeof y === 'number') {
        body.xy = [x, y];
    }

    if (typeof bri === 'number') {
        body.bri = bri;
    }

    info(`🎨 Sending color to lights for team ${userTeam}: ${JSON.stringify(body)}`);
    forEachLight(light => updateLightData(light, body));
}

async function startScript() {
    if (isRunning) { warn("⚠️ Script is already running."); return; }

    if (!getGamestatePath() || !getPreviousStatePath()) {
        error("❌ Paths not initialized. Please call setBasePath() before starting the script.");
        return;
    }

    try {
        await loadConfig();
    } catch (err) {
        error(`❌ Failed to load config: ${err.message}`);
        return;
    }

    if (!lightIDs || lightIDs.length === 0) {
        warn("⚠️ No light IDs set. Please ensure light IDs are initialized.");
        return;
    }

    if (provider === 'hue') {
        info("🎯 Connecting to Hue Bridge...");
        try {
            await fetchWithTimeout(`http://${config.BRIDGE_IP}`, { method: 'HEAD' }, 1000);
        } catch (err) {
            error(`❌ Could not reach Hue Bridge at ${config.BRIDGE_IP}`);
            error(`🛜 Network error: ${err.message}`);
            error(`💡 Check BRIDGE_IP / firewall.`);
            return;
        }

        try {
            const res = await fetchWithTimeout(`${hueAPI}/lights`, {}, 2000);
            if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}`);
            const lights = await res.json();
            if (!lights || typeof lights !== 'object') throw new Error('Unexpected response format from /lights');
        } catch (err) {
            error(`❌ Failed to query Hue Bridge API — check your API key or IP`);
            error(`🔎 Details: ${err.message}`);
            return;
        }

        const inSync = await anyLightInSyncMode(lightIDs, hueAPI);
        if (inSync) {
            info("🚫 One or more lights are in sync/entertainment mode.");
            return;
        }
    } else {
        info("🟡 Yeelight mode: skipping Hue bridge checks.");
        // Optional: später Discovery/Reachability Checks für Yeelight ergänzen.
    }

    const host = config.SERVER_HOST || '127.0.0.1';
    const port = config.SERVER_PORT || 8080;

    server = http.createServer((req, res) => {
        const url = require('url');

        // Inside your server:
        const parsedUrl = url.parse(req.url);
        const pathname = parsedUrl.pathname;

        // Get HTML Log
        if (req.method === 'GET' && req.url === '/log') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(getFullSessionHtml());
            return;
        }
        // CSS File
        if (req.method === 'GET' && req.url === '/css/log-style.css') {
            const cssPath = path.join(__dirname, 'css', 'log-style.css');

            if (fs.existsSync(cssPath)) {
                res.writeHead(200, { 'Content-Type': 'text/css' });
                fs.createReadStream(cssPath).pipe(res);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('CSS file not found');
            }
            return;
        }
        // Favicon
        if (req.method === 'GET' && pathname.startsWith('/img/favicon/')) {
            const safePath = pathname.replace(/^\/+/, '');
            const filePath = path.join(__dirname, safePath);

            fs.access(filePath, fs.constants.R_OK, (err) => {
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Favicon file not found');
                    return;
                }

                const ext = path.extname(filePath).toLowerCase();
                const contentTypes = {
                    '.ico': 'image/x-icon',
                    '.png': 'image/png',
                    '.svg': 'image/svg+xml',
                    '.webmanifest': 'application/manifest+json'
                };
                const contentType = contentTypes[ext] || 'application/octet-stream';

                res.writeHead(200, { 'Content-Type': contentType });

                const stream = fs.createReadStream(filePath);

                stream.on('error', (err) => {
                    console.error("Stream error:", err);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                    }
                    res.end('Internal Server Error');
                });

                stream.pipe(res);
            });

            return;
        }
        // Serve static files from /docs
        if (req.method === 'GET' && pathname === '/docs') {
            res.writeHead(302, { 'Location': '/docs/index.html' });
            res.end();
            return;
        }
        if (req.method === 'GET' && pathname.startsWith('/docs')) {
            const safePath = pathname.replace(/^\/+/, ''); // remove leading slash
            const filePath = path.join(__dirname, safePath);

            fs.access(filePath, fs.constants.R_OK, (err) => {
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('File not found');
                    return;
                }

                const ext = path.extname(filePath).toLowerCase();
                const contentTypes = {
                    '.html': 'text/html',
                    '.css': 'text/css',
                    '.js': 'application/javascript',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.svg': 'image/svg+xml',
                    '.ico': 'image/x-icon',
                    '.json': 'application/json'
                };
                const contentType = contentTypes[ext] || 'application/octet-stream';

                res.writeHead(200, { 'Content-Type': contentType });

                const stream = fs.createReadStream(filePath);
                stream.on('error', err => {
                    console.error("Stream error:", err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error');
                });
                stream.pipe(res);
            });
            return;
        }
        // Gamestate file
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                isWritingGameState = true;
                try {
                    JSON.parse(body);
                    fs.writeFile(getGamestatePath(), body, err => {
                        if (err) {
                            console.error("Error writing gamestate:", err);
                        }
                        isWritingGameState = false;
                    });
                } catch (err) {
                    console.error("⚠️ Invalid JSON received in POST:", err.message);
                    isWritingGameState = false;
                }
                res.writeHead(200);
                res.end('');
            });
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Hue Light Sync</title>
                <link rel="stylesheet" type="text/css" href="/css/log-style.css">
                <link rel="icon" type="image/png" href="/img/favicon/favicon-96x96.png" sizes="96x96">
                <link rel="icon" type="image/svg+xml" href="/img/favicon/favicon.svg">
                <link rel="shortcut icon" href="/img/favicon/favicon.ico">
                <link rel="apple-touch-icon" sizes="180x180" href="/img/favicon/apple-touch-icon.png">
                <meta name="apple-mobile-web-app-title" content="CS2Hue">
                <link rel="manifest" href="/img/favicon/site.webmanifest">
            </head>
            <body>
                <div class="page-wrapper">
                    <div class="log-header">
                        <h1>Hue Light Sync Active</h1>
                    </div>
                </div>
            </body>
            </html>
            `);
        }
    });

    server.listen(port, host, () => {
        info(`🟢 Server listening on http://${host}:${port}`);
    });

    // Save previous state
    try {
        const states = await Promise.all(lightIDs.map(getLightData));
        const stateToSave = {};
        lightIDs.forEach((id, i) => {
            stateToSave[id] = states[i];
        });

        fs.writeFileSync(getPreviousStatePath(), JSON.stringify(stateToSave, null, 4));
        info("📦 Saved previous light states");
    } catch (err) {
        error(`❌ Failed to get or save light state: ${err.message}`);
    }

    // Start polling
    pollerActive = true;
    pollLoop();

    // Set fallback color if no team color was set
    setTimeout(() => {
        if (!lastColorMode && !isBombPlanted && !isFading && !isBlinking) {
            setDefaultColor();
        }
    }, 1000);

    isRunning = true;
    return true;
}

async function pollLoop() {
    if (!pollerActive) return;

    await handlePoll();

    setTimeout(pollLoop, 200);
}

async function handlePoll() {
    // 🔒 Skip poll until write finishes
    if (isWritingGameState) {
        return;
    }

    try {
        const body = fs.readFileSync(getGamestatePath());
        gameState = JSON.parse(body);
        if (gamestateHadError) {
            info("✅ gamestate.txt is readable again, resuming normal operation.");
            gamestateHadError = false;
        }

        if (isFirstPoll) {
            isFirstPoll = false;
        }
    } catch (err) {
        const now = Date.now();

        // Throttle healthcheck warning
        if (!isFirstPoll) {
            if (now - lastHealthCheck > HEALTHCHECK_WARN_COOLDOWN) {
                warn(`❌ Failed to read or parse gamestate.txt: ${err.message} - Retrying...`);
                lastHealthCheck = now;
            } else {
                debug(`(Suppressed) Failed to read or parse gamestate.txt: ${err.message}`);
            }
        }

        // Specific missing file warning (separate cooldown)
        if (err.code === 'ENOENT') {
            if (isFirstPoll) {
                if (now - lastFirstPollLog > FIRST_POLL_INFO_COOLDOWN) {
                    info("⏳ Waiting for CS2 to create gamestate.txt...");
                    lastFirstPollLog = now;
                } else {
                    debug("(Suppressed) Waiting for gamestate.txt...");
                }
            }
            else if (now - lastGamestateMissingWarn > GAMESTATE_MISSING_WARN_COOLDOWN) {
                warn(`❌ gamestate.txt missing: ${err.message}. - Retrying...`);
                warn(`ℹ️ CS2 is not sending data. Please check the gamestate_integration_cs2hue.cfg file. (See: https://github.com/dringewald/CS2HUE#readme)`);
                lastGamestateMissingWarn = now;
            } else {
                debug(`(Suppressed) gamestate.txt missing: ${err.message}`);
            }
        }

        // Retry once after short delay
        setTimeout(() => {
            if (isWritingGameState) return;
            try {
                const retryBody = fs.readFileSync(getGamestatePath());
                gameState = JSON.parse(retryBody);
            } catch (retryErr) {
                if (!isFirstPoll) {
                    const retryNow = Date.now();
                    if (retryNow - lastRetryFailWarn > RETRY_FAIL_COOLDOWN) {
                        error(`❌ Retry failed: ${retryErr.message} - Retrying...`);
                        lastRetryFailWarn = retryNow;
                    } else {
                        debug(`(Suppressed) Retry failed: ${retryErr.message}`);
                    }
                }
            }
        }, 100);
        gamestateHadError = true;

        return;
    }

    // Skip if isFading is true
    if (isFading) {
        if (!hasLoggedFadeWarning) {
            debug("⏳ Currently fading out, skipping this poll cycle.");
            hasLoggedFadeWarning = true;
        }
        return;
    }

    // 📋 Check if user is in menu
    if (gameState?.player?.activity === "menu") {
        if (lastColorMode !== "menu") {
            info("📋 User is in menu, setting menu color");
            resetBombState();

            if (colors.menu) {
                await sendColorToAllLights(colors.menu);
                lastColorMode = "menu";
            } else {
                warn("⚠️ Menu color is disabled or not defined in colors.json");
            }
        }

        return;
    }

    // 💡 Warmup phase logic
    if (gameState.map?.phase === "warmup") {
        if (lastColorMode !== "warmup") {
            info("🔥 Warmup phase detected, setting warmup color");
            resetBombState();

            const warmupColor = colors.warmup;
            if (warmupColor && warmupColor.enabled !== false) {
                await sendColorToAllLights(warmupColor);
                lastColorMode = "warmup";
            } else {
                warn("⚠️ Warmup color is disabled or not defined in colors.json");
            }
        }
        return;
    }

    if (gameState.round) {
        if ((!gameState.round.bomb || gameState.round.bomb === "none") && isBombPlanted) {
            setTimeout(() => {
                if (!gameState.round?.bomb || gameState.round.bomb === "none") {
                    resetBombState();
                }
            }, 500); // Give a small grace period before resetting
        }

        if (gameState.round?.bomb === "planted" && !isBombPlanted) {
            isBombPlanted = true;
            await bombPlanted();
            info("💣 Bomb has been planted");
        }

        if (gameState.round.bomb === "exploded" && !isBombExploded && !explodedHandled) {
            debug(`Bomb Exploded: bomb=${gameState.round.bomb}, isBombExploded=${isBombExploded}, explodedHandled=${explodedHandled}`);
            isBombExploded = true;
            isBombPlanted = false;
            explodedHandled = true;
            try {
                await bombExploded();
            } catch (err) {
                error(`❌ Error in bombExploded(): ${err.message}`);
            }
        }

        if (gameState.round.bomb === "defused" && !isBombDefused && !defusedHandled) {
            debug(`Bomb Defused: bomb=${gameState.round.bomb}, isBombDefused=${isBombExploded}, defusedHandled=${explodedHandled}`);
            isBombDefused = true;
            isBombPlanted = false;
            defusedHandled = true;
            try {
                await bombDefused();
            } catch (err) {
                error(`❌ Error in bombDefused(): ${err.message}`);
            }
        }
    }

    // 🟢 Reset suppression after round end (first!)
    if (gameState.round?.phase !== "over") {
        if (roundEnded || suppressColorUntilNextRound) {
            info("🔄 New round started, resuming color logic");

            roundEnded = false;
            suppressColorUntilNextRound = false;
            explodedHandled = false;
            defusedHandled = false;
            hasLoggedBombReset = false;

            resetBombState();

            const team = gameState?.player?.team;
            if (team && colors[team]) {
                setUserTeamColor();
                lastColorMode = team;
            } else {
                setDefaultColor();
                lastColorMode = 'default';
            }
        }
    }

    // 🟨 Team/default color logic (only skip *after* reset check)
    if (!gameState.round || !gameState.round.bomb || gameState.round.bomb === "none") {
        if (suppressColorUntilNextRound) return;

        const team = gameState?.player?.team;

        if (team && colors[team]) {
            if (lastColorMode !== team) {
                info(`🎯 Switching to team color: ${team}`);
                setUserTeamColor();
                lastColorMode = team;
            }
            hasLoggedMissingPlayerWarning = false; //
        } else {
            if (!gameState.player) {
                if (!hasLoggedMissingPlayerWarning) {
                    info("👻 Player data missing — likely spectating or dead. Skipping...");
                    hasLoggedMissingPlayerWarning = true;
                }
            } else if (!team) {
                warn("⚠️ Player exists but no team assigned. Waiting...");
            } else if (!colors[team]) {
                warn(`⚠️ No color defined for team "${team}"`);
            }

            if (lastColorMode !== 'default') {
                info("🌈 Switching to default color");
                setDefaultColor();
                lastColorMode = 'default';
            }
        }
    }

    // 🟥 Round end: fade and suppress
    if (gameState.round?.phase === "over" && gameState.round?.win_team && !roundEnded) {
        if (delayWinLossColor) {
            debug("⏳ Delaying win/loss color to allow bomb effect to show...");
            return;
        }
        const playerTeam = gameState.player?.team;
        const winningTeam = gameState.round.win_team;

        roundEnded = true;
        suppressColorUntilNextRound = true;

        // Clear any active blinks
        if (blinkEffect.length) {
            blinkEffect.forEach(clearInterval);
            blinkEffect = [];
            isBlinking = false;
        }

        if (playerTeam && playerTeam === winningTeam) {
            info("🏆 Round won! Showing win color");
            if (colors.win) {
                isFading = true;
                await sendColorToAllLights(colors.win);
                await Promise.all(lightIDs.map(light => fadeOutLight(light, 5000)));
                // Delay Healthcheck
                //setTimeout(() => {
                isFading = false;
                hasLoggedFadeWarning = false;

                forEachLight(light => updateLightData(light, { on: true }));

                // Stop any rogue blinking
                if (blinkEffect.length) {
                    blinkEffect.forEach(clearInterval);
                    blinkEffect = [];
                    isBlinking = false;
                }
                //}, 4000);
            }
        } else {
            info("💀 Round lost.");
            if (colors.lose) {
                isFading = true;
                await sendColorToAllLights(colors.lose);
                await Promise.all(lightIDs.map(light => fadeOutLight(light, 5000)));
                // Delay Healthcheck
                isFading = false;
                hasLoggedFadeWarning = false;

                forEachLight(light => updateLightData(light, { on: true }));

                // Stop any rogue blinking
                if (blinkEffect.length) {
                    blinkEffect.forEach(clearInterval);
                    blinkEffect = [];
                    isBlinking = false;
                }
            }
        }
    }

    // 🟢 Reset suppression after round end (Failsave)
    if (gameState.round?.phase !== "over") {
        if (roundEnded || suppressColorUntilNextRound) {
            info("🔄 New round started, resuming color logic");

            roundEnded = false;
            suppressColorUntilNextRound = false;

            // Reset explosion flag AFTER round reset
            isBombExploded = false;

            // Force lights to turn on again
            forEachLight(light => updateLightData(light, { on: true }));

            const team = gameState?.player?.team;
            if (team && colors[team]) {
                setUserTeamColor();
                lastColorMode = team;
            } else {
                setDefaultColor();
                lastColorMode = 'default';
            }
        }
    }
    if (!isFading && !isBlinking && !isBombPlanted && Date.now() - lastHealthCheck > 2000) {
        lastHealthCheck = Date.now();
        await Promise.all(lightIDs.map(async (light) => {
            const state = await getLightData(light);
            if (state && !state.on) {
                info(`⚠️ Light ${light} is off unexpectedly. Re-enabling.`);
                await updateLightData(light, { on: true, bri: 100 });
            }
        }));
    }
}

async function fadeOutLight(light, duration = 1000, steps = 10) {
    const state = await getLightData(light);
    const initialBri = state.bri || 254;

    return new Promise(resolve => {
        let currentStep = 0;

        const interval = setInterval(() => {
            const newBri = Math.max(1, Math.round(initialBri * ((steps - currentStep) / steps)));
            updateLightData(light, { bri: newBri });

            currentStep++;
            if (currentStep >= steps) {
                updateLightData(light, { on: false });
                clearInterval(interval);
                resolve();
            }
        }, duration / steps);
    });
}

async function stopScript(apiFromMain = null) {
    debug("🏃 stopScript is running");
    if (!isRunning) { info("⚠️ Script is not running."); return; }

    if (provider === 'hue') {
        if (!hueAPI && apiFromMain) {
            hueAPI = apiFromMain;
            info(`[MAIN->LOGIC] hueAPI injected from main process: ${hueAPI}`);
        }
        if (!hueAPI) {
            warn("⚠️ hueAPI missing, but continuing shutdown (provider=hue).");
        }
    } else {
        debug("🟡 Yeelight mode: no hueAPI needed during shutdown.");
    }

    isRunning = false;
    debug("🛑 Stopping script...");

    if (server) {
        await new Promise((resolve) => {
            server.close(() => {
                info("🔌 Server closed");
                server = null;
                resolve();
            });
        });
    }

    pollerActive = false;

    if (timer) clearInterval(timer);
    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
        isBlinking = false;
    }

    // 🧠 Restore previous light state or turn lights off
    if (fs.existsSync(getPreviousStatePath())) {
        try {
            debug("📂 PreviousStatePath exists");
            const previousStates = JSON.parse(fs.readFileSync(getPreviousStatePath(), 'utf-8'));

            debug(`🔁 Starting to restore ${lightIDs.length} lights...`);
            for (const light of lightIDs) {
                const prev = previousStates[light];
                if (!prev) {
                    warn(`⚠️ No previous state found for light ${light}`);
                    continue;
                }

                const body = {
                    on: prev.on,
                    bri: prev.bri,
                };

                if (Array.isArray(prev.xy)) body.xy = prev.xy;
                if (typeof prev.ct === 'number') {
                    body.ct = prev.ct;
                    if (provider === 'yeelight') body.useCt = true;
                }
                debug(`🔋 Restored Light ${light}: ${JSON.stringify(body)}`);
                const success = await updateLightData(light, body);
                if (!success) {
                    warn(`⚠️ Failed to restore state for light ${light}`);
                }
            }
            suppressDefaultColor = true;
            setTimeout(() => {
                fs.unlinkSync(getPreviousStatePath());
                info("🔁 Restored previous light states");

                // Allow default color again after a short grace period
                setTimeout(() => suppressDefaultColor = false, 3000);
            }, 500);
        } catch (err) {
            warn(`⚠️ Failed to restore previous states: ${err.message}`);
            await Promise.all(lightIDs.map(light =>
                updateLightData(light, { on: false })
            ));
            warn("🔌 Turned off lights as fallback");
        }
    } else {
        await Promise.all(lightIDs.map(light =>
            updateLightData(light, { on: false })
        ));
        info("🔌 Turned off lights (no previous state)");
    }

    resetInternalFlags();

    debug("🛑 Script stopped");
}

function resetInternalFlags() {
    gameState = {};
    userTeam = '';
    lastColorMode = null;
    isBombPlanted = false;
    isBombExploded = false;
    isBombDefused = false;
    roundEnded = false;
    suppressColorUntilNextRound = false;
    isFading = false;
    isBlinking = false;
    hasLoggedFadeWarning = false;
    hasLoggedMissingPlayerWarning = false;
    defusedHandled = false;
    explodedHandled = false;
    delayWinLossColor = false;
    isWritingGameState = false;
    hasLoggedBombReset = false;
    bombCountdown = null;
    lastHealthCheck = Date.now();
    blinkEffect = [];
    clearSessionLog();
}

const anyLightInSyncMode = async (ids, hueAPI) => {
    if (!ids || ids.length === 0) {
        console.warn("⚠️ lightIDs not ready yet.");
        return false;
    }

    for (const id of ids) {
        try {
            const res = await fetch(`${hueAPI}/lights/${id}`);
            const json = await res.json();
            const mode = json?.config?.mode || json?.state?.mode;
            if (mode === "stream" || mode === "streaming") {
                return true;
            }
        } catch (err) {
            console.error(`❌ Failed to fetch light ${id}: ${err.message}`);
        }
    }
    return false;
};

function fetchWithTimeout(resource, options = {}, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error("Timeout connecting to Hue Bridge"));
        }, timeout);

        fetch(resource, options)
            .then(response => {
                clearTimeout(timer);
                resolve(response);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

function setLightIDs(ids) {
    lightIDs = ids;
}

function setHueAPI(url) {
    debug(`[SET] hueAPI assigned to: ${url}`);
    hueAPI = url;

    // Only send IPC if running in renderer
    if (typeof window !== 'undefined' && window?.process?.type === 'renderer') {
        try {
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('set-hue-api', url);
        } catch (err) {
            warn("⚠️ Failed to send hueAPI to main via IPC:", err.message);
        }
    }
}

function getHueAPI() {
    return hueAPI;
}

module.exports = {
    startScript,
    stopScript,
    isScriptRunning: () => isRunning,
    setIsRunning: (status) => { isRunning = status; },
    setLightIDs,
    setHueAPI,
    getHueAPI,
    anyLightInSyncMode,
    getLightData,
    updateLightData,
};