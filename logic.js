const { info, warn, error, debug, getFullSessionHtml, clearSessionLog, initializeLogger } = require('./logger');
const path = require('path');
const fsPromises = require('fs').promises;

let basePath = __dirname;
let previousStatePath;
let gamestatePath;

const http = require('http');
const fs = require('fs');

let config;
let colors;
let lightIDs;
let hueAPI;
let isTimerEnabled;

let server;
let isRunning = false;

let gameState = {};
const HEALTHCHECK_WARN_COOLDOWN = 10000;
const GAMESTATE_MISSING_WARN_COOLDOWN = 10000;
const RETRY_FAIL_COOLDOWN = 10000;
let lastHealthCheck = Date.now();
let lastGamestateMissingWarn = 0;
let lastRetryFailWarn = 0;
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

function sanitizeColorObject(obj) {
    for (const key in obj) {
        if (obj[key] === null || key === 'undefined') {
            delete obj[key];
        }
    }
    return obj;
}

async function loadConfig() {
    const configPath = path.join(basePath, 'config.json');
    const colorsFilePath = path.join(basePath, 'colors.json');

    if (!fs.existsSync(configPath)) {
        throw new Error("config.json is missing in user data path");
    }

    if (!fs.existsSync(colorsFilePath)) {
        throw new Error("colors.json is missing in user data path");
    }

    config = JSON.parse(await fsPromises.readFile(configPath, 'utf-8'));
    colors = JSON.parse(await fsPromises.readFile(colorsFilePath, 'utf-8'));

    for (const name in colors) {
        const color = colors[name];

        sanitizeColorObject(color);

        if (!('enabled' in color)) {
            color.enabled = true;
        }
    }

    hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`;
    lightIDs = config.LIGHT_ID.split(',').map(id => id.trim());
    isTimerEnabled = config.SHOW_BOMB_TIMER;
}

function forEachLight(callback) {
    lightIDs.forEach(light => callback(light));
}

async function getLightData(light) {
    try {
        const response = await fetch(`${hueAPI}/lights/${light}`);
        const body = await response.json();
        return body.state;
    } catch (error) {
        console.error(error);
    }
}

function updateLightData(light, body) {
    fetch(`${hueAPI}/lights/${light}/state`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" }
    }).catch(console.error);
}

function changeBrightness(light, value) {
    getLightData(light).then(previousState => {
        if (previousState.on === false) {
            updateLightData(light, { "on": true, "bri": value });
            updateLightData(light, { "on": false });
        } else {
            updateLightData(light, { "bri": value });
        }
    });
}

function blinkLight(light, speed, repetition, onDone = () => { }) {
    let repeater = 0;

    const interval = setInterval(async () => {
        const state = await getLightData(light);
        if (state.on === true) {
            updateLightData(light, { on: false });
        } else {
            updateLightData(light, { on: true });
            repeater++;
            if (repetition !== Infinity && repeater >= repetition) {
                clearInterval(interval);
                onDone();
            }
        }
    }, speed);

    return interval;
}

async function sendColorToAllLights(color) {
    if (!color || color.enabled === false) {
        info("⛔ Color is disabled or missing, skipping...");
        return;
    }

    const body = {
        on: true
    };

    if (typeof color.ct === 'number' && color.useCt) {
        body.ct = color.ct;
    } else if (typeof color.x === 'number' && typeof color.y === 'number') {
        body.xy = [color.x, color.y];
    }

    if (typeof color.bri === 'number') {
        body.bri = color.bri;
    }

    debug(`🚨 Sending color to all lights: ${JSON.stringify(body)}`);

    await Promise.all(lightIDs.map(light => updateLightData(light, body)));
}

function blinkAllLights(speed, repetition = Infinity) {
    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
    }

    isBlinking = true;

    let active = lightIDs.length;

    blinkEffect = lightIDs.map(light => {
        return blinkLight(light, speed, repetition, () => {
            active--;
            if (active === 0) {
                isBlinking = false;
                debug("✅ All blinking finished.");
            }
        });
    });

    return blinkEffect;
}

function changeAllBrightness(value) {
    forEachLight(light => changeBrightness(light, value));
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
    if (isRunning) {
        warn("⚠️ Script is already running.");
        return;
    }

    if (!gamestatePath || !previousStatePath) {
        error("❌ Base path not set. Please call setBasePath() before starting the script.");
        return;
    }

    try {
        await loadConfig(); // ⬅ await it
    } catch (err) {
        error(`❌ Failed to load config: ${err.message}`);
        return;
    }

    info("🎯 Connecting...");

    // Check sync mode BEFORE starting server
    const inSync = await anyLightInSyncMode();
    if (inSync) {
        info("🚫 One or more lights are in sync/entertainment mode.");
        return;
    }

    isRunning = true;

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
                    fs.writeFile(gamestatePath, body, err => {
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

        fs.writeFileSync(previousStatePath, JSON.stringify(stateToSave, null, 4));
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
}

async function pollLoop() {
    if (!pollerActive) return;

    await handlePoll();

    setTimeout(pollLoop, 200);
}

async function handlePoll() {
    if (isWritingGameState) {
        return; // 🔒 Skip poll until write finishes
    }

    try {
        const body = fs.readFileSync(gamestatePath);
        gameState = JSON.parse(body);
        if (gamestateHadError) {
            info("✅ gamestate.txt is readable again, resuming normal operation.");
            gamestateHadError = false;
        }
    } catch (err) {
        const now = Date.now();

        // Throttle healthcheck warning
        if (now - lastHealthCheck > HEALTHCHECK_WARN_COOLDOWN) {
            warn(`❌ Failed to read or parse gamestate.txt: ${err.message} - Retrying...`);
            lastHealthCheck = now;
        } else {
            debug(`(Suppressed) Failed to read or parse gamestate.txt: ${err.message}`);
        }

        // Specific missing file warning (separate cooldown)
        if (err.code === 'ENOENT') {
            if (now - lastGamestateMissingWarn > GAMESTATE_MISSING_WARN_COOLDOWN) {
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
                const retryBody = fs.readFileSync(gamestatePath);
                gameState = JSON.parse(retryBody);
            } catch (retryErr) {
                const retryNow = Date.now();
                if (retryNow - lastRetryFailWarn > RETRY_FAIL_COOLDOWN) {
                    error(`❌ Retry failed: ${retryErr.message} - Retrying...`);
                    lastRetryFailWarn = retryNow;
                } else {
                    debug(`(Suppressed) Retry failed: ${retryErr.message}`);
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
                warn("⚠️ No menu color defined in colors.json");
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

function stopScript() {
    if (!isRunning) {
        info("⚠️ Script is not running.");
        return;
    }

    isRunning = false;
    info("🛑 Stopping script...");

    if (server) {
        server.close(() => {
            info("🔌 Server closed");
            server = null;
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
    if (fs.existsSync(previousStatePath)) {
        try {
            const previousStates = JSON.parse(fs.readFileSync(previousStatePath, 'utf-8'));

            forEachLight(light => {
                const prev = previousStates[light];
                if (prev) {
                    const body = {
                        on: prev.on,
                        bri: prev.bri,
                    };
                    if (Array.isArray(prev.xy)) body.xy = prev.xy;
                    if (typeof prev.ct === 'number') body.ct = prev.ct;

                    updateLightData(light, body);
                }
            });

            fs.unlinkSync(previousStatePath);
            info("🔁 Restored previous light states");

        } catch (err) {
            warn(`⚠️ Failed to restore previous states: ${err.message}`);
            forEachLight(light => updateLightData(light, { on: false }));
            warn("🔌 Turned off lights as fallback");
        }
    } else {
        forEachLight(light => updateLightData(light, { on: false }));
        info("🔌 Turned off lights (no previous state)");
    }

    // Resetting variables
    resetInternalFlags();

    info("🛑 Script stopped");
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

const anyLightInSyncMode = async () => {
    for (const id of lightIDs) {
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

async function setBasePath(path) {
    basePath = path;
    initializePaths();

    try {
        await initializeLogger();
        debug(`📁 Using basePath: ${basePath}`);
        debug(`📝 Gamestate path: ${gamestatePath}`);
        debug(`🧠 Previous state path: ${previousStatePath}`);
    } catch (err) {
        console.log("[ERROR] ❌ Failed to initialize logger:", err.message);
    }
}

function initializePaths() {
    previousStatePath = path.join(basePath, 'previousState.json');
    gamestatePath = path.join(basePath, 'gamestate.txt');
}

module.exports = {
    startScript,
    stopScript,
    isScriptRunning: () => isRunning,
    anyLightInSyncMode,
    setBasePath
};