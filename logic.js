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
let sceneEpoch = 0;
const allowedOffUntil = new Map();
let healthcheckMutedUntil = 0;
let suppressSinceTs = 0;
let keepPollingUntilTs = 0;

const POLL_INTERVAL_MS = () => (provider === 'yeelight' ? 25 : 100);
const PER_LIGHT_THROTTLE_MS = () => (provider === 'hue' ? 150 : 60);
const POST_WRITE_GAP_MS = () => (provider === 'hue' ? 80 : 40);

function muteHealthcheck(ms, why = '') {
    healthcheckMutedUntil = Date.now() + Math.max(0, ms | 0);
    if (why) debug(`🔇 Healthcheck muted for ${ms}ms — ${why}`);
}

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

// Lazily build the controller if the script isn't running (used by color test)
async function ensureControllerReady() {
    if (controller) return true;

    try {
        if (!fs.existsSync(getConfigPath())) {
            warn('⚠️ config.json missing, cannot initialize controller.');
            return false;
        }

        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
        config = cfg;

        // Provider + LIGHT_IDs
        provider = (cfg.PROVIDER || 'hue').toLowerCase();
        try {
            const raw = (cfg.LIGHT_ID || '').trim();
            lightIDs = raw ? raw.split(',').map(id => id.trim()).filter(Boolean) : [];
        } catch {
            lightIDs = [];
        }

        if (provider === 'yeelight') {
            // Parse YEELIGHT_DEVICES into {host,port}[]
            let devices = String(cfg.YEELIGHT_DEVICES || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(token => {
                    const [host, portStr] = token.split(':');
                    return { host, port: Number(portStr || 55443) };
                });

            // Optional discovery if enabled and none configured
            if (cfg.YEELIGHT_DISCOVERY === true && devices.length === 0) {
                try {
                    const discovered = await YeelightController.discover(2000);
                    devices = discovered;
                    info(`🔎 Yeelight discovery found ${devices.length} device(s).`);
                } catch (e) {
                    warn(`⚠️ Yeelight discovery failed: ${e.message}`);
                }
            }

            controller = new YeelightController({ devices });
            if (!devices.length) {
                warn('⚠️ Yeelight: no devices configured/reachable.');
            }
        } else {
            controller = new HueController({
                bridgeIP: cfg.BRIDGE_IP,
                apiKey: cfg.API_KEY
            });
            setHueAPI(`http://${cfg.BRIDGE_IP}/api/${cfg.API_KEY}`);
        }

        isTimerEnabled = !!cfg.SHOW_BOMB_TIMER;
        return true;
    } catch (e) {
        error(`❌ ensureControllerReady failed: ${e.message}`);
        return false;
    }
}

function forEachLight(callback) {
    lightIDs.forEach(light => callback(light));
}

async function getLightData(light) {
    try {
        if (!controller) {
            const ok = await ensureControllerReady();
            if (!ok) throw new Error('Controller not initialized');
        }
        return await controller.getState(light);
    } catch (e) {
        error(e.message);
        return {};
    }
}

const lightQueues = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Track when/what we last sent to each light (for dedupe + throttle)
const lastUpdateAt = new Map();
const lastSentBody = new Map();

// “Intent”: the desired target state for each light (sorted as a stable string)
const lastIntentBody = new Map();

function nearlyEqual(a, b, eps = 0.002) {
    return Math.abs((a ?? 0) - (b ?? 0)) <= eps;
}

function stateMatchesIntent(deviceState, intent) {
    if (!deviceState || !intent) return false;
    // Hue/Yeelight are working differently – we only check relevant fields robustly
    if (typeof intent.on === 'boolean' && deviceState.on !== intent.on) return false;
    if (typeof intent.bri === 'number' && Math.abs((deviceState.bri ?? 0) - intent.bri) > 2) return false;

    if (Array.isArray(intent.xy)) {
        const sxy = Array.isArray(deviceState.xy) ? deviceState.xy : deviceState.xy || deviceState.color?.xy;
        if (!Array.isArray(sxy) || sxy.length !== 2) return false;
        if (!nearlyEqual(sxy[0], intent.xy[0]) || !nearlyEqual(sxy[1], intent.xy[1])) return false;
    }
    if (typeof intent.ct === 'number') {
        const sct = deviceState.ct ?? deviceState.color_temp;
        if (typeof sct !== 'number' || Math.abs(sct - intent.ct) > 2) return false;
    }
    return true;
}

function clearLightCaches(reason = '') {
    lastSentBody.clear();
    lastIntentBody.clear();
    lastUpdateAt.clear();
    if (reason) debug(`🧹 Cleared per-light caches: ${reason}`);
}

// Track gamestate changes to avoid unnecessary work
let lastGamestateMTime = 0;

// Stable stringify so object key order doesn't cause false mismatches
function stableStringify(obj) {
    if (!obj || typeof obj !== 'object') return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    const ordered = {};
    for (const k of keys) ordered[k] = obj[k];
    return JSON.stringify(ordered);
}

async function updateLightData(light, body, opts = {}) {
    const { force = false, verify = false, retries = 0 } = opts;

    if (!controller) {
        const ok = await ensureControllerReady();
        if (!ok) { error('⛔ Controller not initialized'); return false; }
    }

    const intentStr = stableStringify(body);
    lastIntentBody.set(light, intentStr);

    const now = Date.now();
    const lastAt = lastUpdateAt.get(light) || 0;
    const alreadySent = lastSentBody.get(light) === intentStr;

    if (!force) {
        if (now - lastAt < PER_LIGHT_THROTTLE_MS()) return true;
        if (alreadySent) return true;
    }

    // Capture current scene generation to cancel stale queued writes
    const epochAtEnqueue = sceneEpoch;

    const prev = lightQueues.get(light) || Promise.resolve();
    const next = prev.then(async () => {
        // If scene changed while we were queued, skip this write
        if (epochAtEnqueue !== sceneEpoch) {
            debug(`⏭️ Skip stale write for light ${light} (scene changed)`);
            return true;
        }

        const latestIntentStr = lastIntentBody.get(light) || intentStr;
        const latestIntent = JSON.parse(latestIntentStr);

        try {
            await controller.setState(light, latestIntent);
            lastUpdateAt.set(light, Date.now());
            lastSentBody.set(light, latestIntentStr);
            await sleep(POST_WRITE_GAP_MS());

            if (verify) {
                let attempts = 0;
                while (attempts <= retries) {
                    try {
                        const st = await controller.getState(light);
                        if (stateMatchesIntent(st, latestIntent)) return true;
                    } catch (_) { /* ignore */ }
                    attempts++;
                    if (attempts <= retries) await sleep(60);
                    // Re-send same intent (only if still same scene)
                    if (epochAtEnqueue !== sceneEpoch) return true;
                    try {
                        await controller.setState(light, latestIntent);
                        lastUpdateAt.set(light, Date.now());
                        lastSentBody.set(light, latestIntentStr);
                        await sleep(POST_WRITE_GAP_MS());
                    } catch (e2) {
                        error(`Retry setState failed for ${light}: ${e2.message}`);
                    }
                }
                warn(`⚠️ Verify mismatch for light ${light} after ${retries} retries`);
            }
            return true;
        } catch (e) {
            error(`Update failed for ${light}: ${e.message}`);
            return false;
        }
    });

    lightQueues.set(light, next);
    return next;
}

async function sendColorToAllLights(color, { force = true, verify = false, retries = 0 } = {}) {
    if (!color || color.enabled === false) { info("⛔ Color disabled/missing"); return; }

    const body = { on: true };
    if (color.useCt && typeof color.ct === 'number') {
        body.ct = color.ct;
        if (provider === 'yeelight') body.useCt = true;
    } else if (typeof color.x === 'number' && typeof color.y === 'number') {
        body.xy = [color.x, color.y];
    }
    if (typeof color.bri === 'number') body.bri = color.bri;

    // Barrier: we wait until *all* lights are ready
    const tasks = lightIDs.map((id, i) => (async () => {
        // small staggering against bursts
        if (i) await sleep(12);
        return updateLightData(id, body, { force, verify, retries });
    })());
    await Promise.allSettled(tasks);
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
            updateLightData(lightIDs[i], { on: isOn }, { force: true, verify: false });
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

// Scene generation guard to prevent stale/racing writes
function beginScene(label = '') {
    sceneEpoch++;
    debug(`🎬 Begin scene #${sceneEpoch}${label ? ' — ' + label : ''}`);
    muteHealthcheck(2000, `beginScene(${label})`);

    // Stop any blinking immediately
    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
        isBlinking = false;
    }

    // Flush per-light queues by replacing them with resolved promises
    lightQueues.forEach((_, k) => lightQueues.set(k, Promise.resolve()));

    // Clear dedupe/throttle caches so the next intents are not skipped
    clearLightCaches(`beginScene(${label})`);
    allowedOffUntil.clear();
}

// Verify after a short delay and fix any mismatches
async function assertAllLights(body, { delayMs = 120, retries = 1 } = {}) {
    await sleep(delayMs);
    const intentStr = stableStringify(body);
    await Promise.all(lightIDs.map(async (id) => {
        try {
            const st = await getLightData(id);
            if (!stateMatchesIntent(st, body)) {
                debug(`🔁 Assert resend on light ${id}`);
                await updateLightData(id, JSON.parse(intentStr), { force: true, verify: true, retries });
            }
        } catch (_) { /* ignore */ }
    }));
}

// Generic setter with layered fallbacks for many-light setups.
async function applyColorWithFallback(color, label = 'generic') {
    if (!color || color.enabled === false) { info("⛔ Color disabled/missing"); return; }

    // Capture the scene at call time; if it changes, abort later steps
    const plannedEpoch = sceneEpoch;

    // Bail if an effect started or scene changed
    const shouldAbort = (why = '') => {
        if (sceneEpoch !== plannedEpoch) { debug(`⏭️ Abort fallback (${label}) — scene changed ${why || ''}`); return true; }
        if (isFading || suppressColorUntilNextRound) { debug(`⏭️ Abort fallback (${label}) — effect/suppression active ${why || ''}`); return true; }
        return false;
    };

    // Build expected state we want to see on lights
    const expect = { on: true };
    if (color.useCt && typeof color.ct === 'number') {
        expect.ct = color.ct;
        if (provider === 'yeelight') expect.useCt = true; // yeelight flag
    } else if (typeof color.x === 'number' && typeof color.y === 'number') {
        expect.xy = [color.x, color.y];
    }
    if (typeof color.bri === 'number') expect.bri = color.bri;

    debug(`🎨 Applying ${label} color with layered fallback...`);

    // Primary send with per-light verify
    await sendColorToAllLights(color, { force: true, verify: true, retries: 2 });
    if (shouldAbort('(after primary)')) return;

    // Group-level assertion (slightly larger delay & retries)
    await assertAllLights(expect, { delayMs: 180, retries: 2 });
    if (shouldAbort('(after assert)')) return;

    // Final targeted sweep: re-send only mismatched lights
    await sleep(160);
    if (shouldAbort('(before sweep)')) return;

    const mismatches = [];
    for (const id of lightIDs) {
        try {
            const st = await getLightData(id);
            if (!stateMatchesIntent(st, expect)) mismatches.push(id);
        } catch { /* ignore */ }
        // Check mid-loop to abort quickly if a new scene/effect starts
        if (shouldAbort('(mid sweep)')) return;
    }

    if (mismatches.length) {
        debug(`🔁 Final sweep for lights: ${mismatches.join(', ')}`);
        for (let i = 0; i < mismatches.length; i++) {
            if (shouldAbort('(sweep loop)')) return;
            const id = mismatches[i];
            // gentle stagger
            if (i) await sleep(20);
            await updateLightData(id, expect, { force: true, verify: true, retries: 1 });
        }
        // One last short assert (guarded)
        if (!shouldAbort('(pre last assert)')) {
            await assertAllLights(expect, { delayMs: 120, retries: 1 });
        }
    }
}

function changeAllBrightness(value) {
    return Promise.all(lightIDs.map(light =>
        updateLightData(light, { on: true, bri: value }, { force: true, verify: false })
    ));
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
    beginScene('bomb:planted');
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
        await assertAllLights(
            (color.useCt ? { on: true, ct: color.ct, ...(typeof color.bri === 'number' ? { bri: color.bri } : {}) }
                : { on: true, xy: [color.x, color.y], ...(typeof color.bri === 'number' ? { bri: color.bri } : {}) }),
            { delayMs: 160, retries: 1 }
        );
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
            // Abort if round ended
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
    beginScene('bomb:exploded');
    debug("💥 Bomb exploded!");
    keepPollingUntilTs = Date.now() + 8000;

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
        await sendColorToAllLights(colors.exploded, { force: true, verify: true, retries: 2 });
        await assertAllLights(
            (colors.exploded.useCt
                ? { on: true, ct: colors.exploded.ct, ...(typeof colors.exploded.bri === 'number' ? { bri: colors.exploded.bri } : {}) }
                : { on: true, xy: [colors.exploded.x, colors.exploded.y], ...(typeof colors.exploded.bri === 'number' ? { bri: colors.exploded.bri } : {}) }),
            { delayMs: 160, retries: 1 }
        );
    }

    delayWinLossColor = true;
    setTimeout(() => delayWinLossColor = false, 2000);

    // Failover Round End
    setTimeout(async () => {
        if (roundEnded) return;

        const hasRealWinner = !!gameState?.round?.win_team;
        const winner = hasRealWinner ? gameState.round.win_team : 'T';

        try {
            await applyRoundResultByWinner(winner, 'explode-fallback');

            const playerTeam = gameState?.player?.team;

            // Logging logic
            if (hasRealWinner) {
                if (playerTeam && playerTeam === winner) {
                    info("🏆 Round won! Showing win color");
                } else {
                    info("💀 Round lost.");
                }
            } else {
                // Only log fallback if GSI had no result
                info(`🏁 Applying round result after explosion (fallback → ${winner})`);
            }
        } catch (e) {
            error(`❌ Fallback round result after explosion failed: ${e.message}`);
        }
    }, 1800);

    // If no result has been applied by now, force apply one
    setTimeout(() => {
        if (!roundEnded) {
            const winner = gameState?.round?.win_team || 'T';
            info(`🧯 Watchdog: forcing round result after explosion (${winner})`);
            applyRoundResultByWinner(winner, 'explode-watchdog')
                .catch(e => error(`❌ Watchdog apply failed: ${e.message}`));
        } else {
            resumeRoundIfStuck('post-result');
        }
    }, 6000);
}

async function bombDefused() {
    beginScene('bomb:defused');
    debug("🛡 Handling bomb defused...");
    keepPollingUntilTs = Date.now() + 8000;

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
        await sendColorToAllLights(colors.defused, { force: true, verify: true, retries: 2 });
        await assertAllLights(
            (colors.defused.useCt
                ? { on: true, ct: colors.defused.ct, ...(typeof colors.defused.bri === 'number' ? { bri: colors.defused.bri } : {}) }
                : { on: true, xy: [colors.defused.x, colors.defused.y], ...(typeof colors.defused.bri === 'number' ? { bri: colors.defused.bri } : {}) }),
            { delayMs: 160, retries: 1 }
        );
    }

    delayWinLossColor = true;
    setTimeout(() => delayWinLossColor = false, 2000);

    // Failover Round End
    // Failover Round End
    setTimeout(async () => {
        if (roundEnded) return;

        const hasRealWinner = !!gameState?.round?.win_team;
        const winner = hasRealWinner ? gameState.round.win_team : 'CT';

        try {
            await applyRoundResultByWinner(winner, 'defuse-fallback');

            const playerTeam = gameState?.player?.team;

            // Logging logic
            if (hasRealWinner) {
                if (playerTeam && playerTeam === winner) {
                    info("🏆 Round won! Showing win color");
                } else {
                    info("💀 Round lost.");
                }
            } else {
                // Only log fallback if GSI had no result
                info(`🏁 Applying round result after defuse (fallback → ${winner})`);
            }
        } catch (e) {
            error(`❌ Fallback round result after defuse failed: ${e.message}`);
        }
    }, 1800);

    setTimeout(() => {
        // If no result has been applied by now, force apply one
        if (!roundEnded) {
            const winner = gameState?.round?.win_team || 'CT';
            info(`🧯 Watchdog: forcing round result after explosion (${winner})`);
            applyRoundResultByWinner(winner, 'explode-watchdog')
                .catch(e => error(`❌ Watchdog apply failed: ${e.message}`));
        } else {
            resumeRoundIfStuck('post-result');
        }
    }, 6000);
}

async function applyRoundResultByWinner(winningTeam, reason = 'fallback') {
    if (roundEnded) return;
    roundEnded = true;
    suppressColorUntilNextRound = true;
    suppressSinceTs = Date.now();
    delayWinLossColor = false;

    // Check win against own team
    const playerTeam = gameState.player?.team;
    const isWin = playerTeam && winningTeam && playerTeam === winningTeam;
    const color = isWin ? colors.win : colors.lose;
    if (!color) return;

    beginScene(`round:${isWin ? 'win' : 'lose'} (${reason})`);
    isFading = true;

    await sendColorToAllLights(color, { force: true, verify: true, retries: 2 });
    await assertAllLights(
        (color.useCt
            ? { on: true, ct: color.ct, ...(typeof color.bri === 'number' ? { bri: color.bri } : {}) }
            : { on: true, xy: [color.x, color.y], ...(typeof color.bri === 'number' ? { bri: color.bri } : {}) }),
        { delayMs: 160, retries: 1 }
    );

    await Promise.all(lightIDs.map(light => fadeOutLight(light, 5000)));
    isFading = false;
    hasLoggedFadeWarning = false;

    forEachLight(light => updateLightData(light, { on: true }));

    // Make sure that no blink is running
    if (blinkEffect.length) {
        blinkEffect.forEach(clearInterval);
        blinkEffect = [];
        isBlinking = false;
    }
}

function resumeRoundIfStuck(reason = 'watchdog') {
    if (!suppressColorUntilNextRound || !roundEnded) return;
    if (!suppressSinceTs || (Date.now() - suppressSinceTs) < 4500) return;

    info(`🧯 Forcing round resume (${reason})`);
    muteHealthcheck(2500, `resume (${reason})`);

    roundEnded = false;
    suppressColorUntilNextRound = false;
    suppressSinceTs = 0;
    explodedHandled = false;
    defusedHandled = false;
    hasLoggedBombReset = false;

    clearLightCaches(`resume(${reason})`);
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

    beginScene('default');
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

    forEachLight(light => updateLightData(light, body, { force: true, verify: false }));
    assertAllLights(body, { delayMs: 140, retries: 1 });
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

    beginScene(`team:${userTeam}`);

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
    applyColorWithFallback(
        (color.useCt ? { ...color, useCt: true } : color),
        `team:${userTeam}`
    );
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
            await probeHueBridge(config.BRIDGE_IP, config.API_KEY);
        } catch (err) {
            error(`❌ Could not reach Hue Bridge at ${config.BRIDGE_IP}`);
            error(`🛜 Network error: ${err.message}`);
            error(`💡 Check BRIDGE_IP / firewall.`);
            return;
        }

        const inSync = await anyLightInSyncMode(lightIDs, hueAPI);
        if (inSync) {
            info("🚫 One or more lights are in sync/entertainment mode.");
            return;
        }
    } else {
        info("🟡 Yeelight mode: skipping Hue bridge checks.");
    }

    const host = config.SERVER_HOST || '127.0.0.1';
    const port = config.SERVER_PORT || 8080;

    server = http.createServer((req, res) => {
        const url = require('url');

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

    // Lights could be off, so mute health check for a second
    muteHealthcheck(4000, 'startup');

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

    let shouldPoll = true;

    // Cheap file mtime check to avoid heavy work if nothing changed.
    // Still poll when bomb effects need timing (blink/timer), since they don’t always depend on file updates.
    try {
        const stat = fs.statSync(getGamestatePath());
        const changed = stat.mtimeMs !== lastGamestateMTime;
        // Keep polling while the lights are in any transitional state:
        // - suppressColorUntilNextRound: waiting for round resume
        // - roundEnded: end-of-round scene just applied
        // - isBombPlanted / isBlinking: time-driven effects
        // Otherwise we can safely skip when the file hasn't changed.
        if (
            !changed &&
            !isBombPlanted &&
            !isBlinking &&
            !roundEnded &&
            !suppressColorUntilNextRound && Date.now() > keepPollingUntilTs
        ) {
            shouldPoll = false;
        } else {
            lastGamestateMTime = stat.mtimeMs;
        }
    } catch {
        // If the file can't be stat, fall back to normal handling (handlePoll has its own retry logic)
        shouldPoll = true;
    }

    if (shouldPoll) {
        await handlePoll();
    }

    setTimeout(pollLoop, POLL_INTERVAL_MS());
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
                await applyColorWithFallback(colors.menu, 'menu');
                lastColorMode = "menu";
            } else {
                warn("⚠️ Menu color is disabled or not defined in colors.json");
            }
            // Discord RPC Text
            if (config?.DISCORD_EVENTS?.menu !== false) sendRpc('Menu');
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
                await applyColorWithFallback(colors.warmup, 'warmup');
                lastColorMode = "warmup";
            } else {
                warn("⚠️ Warmup color is disabled or not defined in colors.json");
            }
            // Discord RPC Text
            if (config?.DISCORD_EVENTS?.roundStart !== false) sendRpc('Warmup', { resetTimer: true });
        }
        return;
    }

    if (gameState.round) {
        if ((!gameState.round.bomb || gameState.round.bomb === "none") && isBombPlanted) {
            // Give a small grace period before resetting bomb state
            setTimeout(() => {
                if (!gameState.round?.bomb || gameState.round.bomb === "none") {
                    resetBombState();
                }
            }, 500);
        }

        if (gameState.round?.bomb === "planted" && !isBombPlanted) {
            isBombPlanted = true;
            await bombPlanted();
            info("💣 Bomb has been planted");
            // Discord Text
            if (config?.DISCORD_EVENTS?.bombPlanted !== false) sendRpc('Planted');
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
            // Discord Text
            if (config?.DISCORD_EVENTS?.bombExploded !== false) sendRpc('Exploded');
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
            // Discord Text
            if (config?.DISCORD_EVENTS?.bombDefused !== false) sendRpc('Defused');
        }
    }

    // 🟢 Reset suppression after round end (first!)
    if (gameState.round?.phase !== "over") {
        if (roundEnded || suppressColorUntilNextRound) {
            info("🔄 New round started, resuming color logic");

            muteHealthcheck(2500, 'round resumed');
            keepPollingUntilTs = 0;

            roundEnded = false;
            suppressColorUntilNextRound = false;
            suppressSinceTs = 0;
            explodedHandled = false;
            defusedHandled = false;
            hasLoggedBombReset = false;

            clearLightCaches('round resumed');
            resetBombState();

            const team = gameState?.player?.team;
            if (team && colors[team]) {
                setUserTeamColor();
                lastColorMode = team;
            } else {
                setDefaultColor();
                lastColorMode = 'default';
            }
            // Discord Text
            if (config?.DISCORD_EVENTS?.roundStart !== false) sendRpc('RoundStart', { resetTimer: !!config.DISCORD_RESET_ON_ROUND });
        }
    }

    // 🟨 Team/default color logic (only skip *after* reset check)
    if (!gameState.round || !gameState.round.bomb || gameState.round.bomb === "none") {
        if (suppressColorUntilNextRound) {
            if (suppressSinceTs && (Date.now() - suppressSinceTs) > 5000) {
                warn("⏲️ Suppression expired — resuming colors (no gamestate update).");
                resumeRoundIfStuck('team/default');
            }
            return;
        }
        const team = gameState?.player?.team;

        if (team && colors[team]) {
            if (lastColorMode !== team) {
                info(`🎯 Switching to team color: ${team}`);
                setUserTeamColor();
                lastColorMode = team;
            }
            hasLoggedMissingPlayerWarning = false;
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
                beginScene('round:win');
                isFading = true;
                await sendColorToAllLights(colors.win, { force: true, verify: true, retries: 2 });
                await assertAllLights(
                    (colors.win.useCt
                        ? { on: true, ct: colors.win.ct, ...(typeof colors.win.bri === 'number' ? { bri: colors.win.bri } : {}) }
                        : { on: true, xy: [colors.win.x, colors.win.y], ...(typeof colors.win.bri === 'number' ? { bri: colors.win.bri } : {}) }),
                    { delayMs: 160, retries: 1 }
                );
                await Promise.all(lightIDs.map(light => fadeOutLight(light, 5000)));
                // Delay Healthcheck
                isFading = false;
                hasLoggedFadeWarning = false;

                forEachLight(light => updateLightData(light, { on: true }));

                if (blinkEffect.length) {
                    blinkEffect.forEach(clearInterval);
                    blinkEffect = [];
                    isBlinking = false;
                }
                // Discord Text
                if (config?.DISCORD_EVENTS?.roundWon !== false) sendRpc('RoundWon');
            }
        } else {
            info("💀 Round lost.");
            if (colors.lose) {
                beginScene('round:lose');
                isFading = true;
                await sendColorToAllLights(colors.lose, { force: true, verify: true, retries: 2 });
                await assertAllLights(
                    (colors.lose.useCt
                        ? { on: true, ct: colors.lose.ct, ...(typeof colors.lose.bri === 'number' ? { bri: colors.lose.bri } : {}) }
                        : { on: true, xy: [colors.lose.x, colors.lose.y], ...(typeof colors.lose.bri === 'number' ? { bri: colors.lose.bri } : {}) }),
                    { delayMs: 160, retries: 1 }
                );
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
                // Discord Text
                if (config?.DISCORD_EVENTS?.roundLost !== false) sendRpc('RoundLost');
            }
        }
    }

    // 🟢 Reset suppression after round end (Failsave)
    if (gameState.round?.phase !== "over") {
        if (roundEnded || suppressColorUntilNextRound) {
            info("🔄 New round started, resuming color logic");
            muteHealthcheck(2500, 'round resumed (failsafe)');

            roundEnded = false;
            suppressColorUntilNextRound = false;

            // Reset explosion flag AFTER round reset
            isBombExploded = false;

            clearLightCaches('round resumed (failsafe)');
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
            // Discord Text
            if (config?.DISCORD_EVENTS?.roundStart !== false) sendRpc('RoundStart', { resetTimer: !!config.DISCORD_RESET_ON_ROUND });
        }
    }
    if (!isFading && !isBlinking && !isBombPlanted && !suppressColorUntilNextRound &&
        Date.now() >= healthcheckMutedUntil && Date.now() - lastHealthCheck > 2000) {
        lastHealthCheck = Date.now();
        await Promise.all(lightIDs.map(async (light) => {
            const state = await getLightData(light);
            if (state && state.on === false) {

                const intentStr = lastIntentBody.get(light);
                if (intentStr) {
                    try {
                        const intent = JSON.parse(intentStr);
                        if (intent && intent.on === false) return;
                    } catch { }
                }
                const grace = allowedOffUntil.get(light) || 0;
                if (Date.now() <= grace) {
                    return;
                }
                const lastAt = lastUpdateAt.get(light) || 0;
                if (Date.now() - lastAt < 900) {
                    return;
                }
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
                allowedOffUntil.set(light, Date.now() + Math.max(800, duration + 500));
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

    // Restore previous light state or turn lights off
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
    suppressSinceTs = 0;
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

// Try a few real Hue endpoints with modest timeouts + one short backoff.
async function probeHueBridge(bridgeIP, apiKey) {
    const base = `http://${bridgeIP}`;

    // Try description.xml (Hue advertises here)
    try {
        const r = await fetchWithTimeout(`${base}/description.xml`, {}, 2500);
        if (r.ok) return;
    } catch { }

    // Try /api/<key>/config (very light, no payload)
    try {
        const r = await fetchWithTimeout(`${base}/api/${apiKey}/config`, {}, 2500);
        if (r.ok) return;
    } catch { }

    // Try /api/<key>/lights
    try {
        const r = await fetchWithTimeout(`${base}/api/${apiKey}/lights`, {}, 2500);
        if (r.ok) return;
    } catch { }

    // Tiny backoff, then one last try on /lights with a slightly longer timeout
    await new Promise(r => setTimeout(r, 400));
    const last = await fetchWithTimeout(`${base}/api/${apiKey}/lights`, {}, 3000);
    if (!last.ok) throw new Error(`Bridge returned HTTP ${last.status}`);
}

function getIpc() {
    try {
        if (typeof window !== 'undefined' && window?.process?.type === 'renderer') {
            const { ipcRenderer } = require('electron');
            return ipcRenderer;
        }
    } catch (_) { }
    return null;
}

// Optional sanitizing (remains even if no user input is used anymore)
function sanitizeText(s) {
    if (!s) return '';
    return String(s).slice(0, 96);
}

function labelForMode(mode) {
    if (!mode) return '';
    if (/wingman/i.test(mode)) return 'Wingman';
    if (/deathmatch/i.test(mode)) return 'Deathmatch';
    if (/casual/i.test(mode)) return 'Casual';
    return 'Competitive';
}

function sideLabel(team) {
    if (!team) return '';
    const t = String(team).toUpperCase();
    if (t === 'CT') return 'CT';
    if (t === 'T') return 'T';
    return t;
}

function buildFixedLines(gs) {
    const map = gs?.map?.name || '';
    const mode = gs?.map?.mode || '';
    const side = sideLabel(gs?.player?.team || '');
    const ct = gs?.map?.team_ct?.score;
    const t = gs?.map?.team_t?.score;

    const parts1 = [];
    const modeLabel = labelForMode(mode);
    if (modeLabel) parts1.push(modeLabel);
    if (map) parts1.push(map);

    const ot = detectOT(mode, ct, t);
    if (ot > 0) parts1[parts1.length - 1] = `${parts1[parts1.length - 1]} (OT${ot})`;

    const detailsStr = parts1.join(' — ').trim();
    const details = detailsStr ? sanitizeText(detailsStr) : undefined;

    let state;
    if (side && Number.isFinite(ct) && Number.isFinite(t)) {
        const enemy = side === 'CT' ? 'T' : 'CT';
        const teamScore = side === 'CT' ? ct : t;
        const enemyScore = side === 'CT' ? t : ct;
        state = `In Team ${side} ${teamScore} - ${enemyScore} ${enemy}`;
    } else if (side) {
        state = `In Team ${side}`;
    }

    return { details, state: state ? sanitizeText(state) : undefined };
}

function detectOT(mode, ctScore, tScore) {
    const baseMax = /wingman/i.test(mode) ? 16 : 24;
    const total = (ctScore ?? 0) + (tScore ?? 0);
    if (total <= baseMax) return 0;
    const extra = Math.max(1, total - baseMax);
    return Math.floor((extra - 1) / 6) + 1;
}

function computeParty(gs) {
    const round = gs?.map?.round ?? gs?.round?.round;
    const mode = gs?.map?.mode;
    const baseMax = /wingman/i.test(mode) ? 16 : 24;

    const ct = gs?.map?.team_ct?.score ?? 0;
    const t = gs?.map?.team_t?.score ?? 0;
    const otN = detectOT(mode, ct, t);
    const rounds_max = baseMax + otN * 6;

    if (!Number.isFinite(round)) return null;
    return [Number(round) || 0, rounds_max];
}

let lastRpcSent = 0;
function sendRpc({ resetTimer = false } = {}) {
    try {
        if (!config?.DISCORD_RPC_ENABLED) return;

        if (!resetTimer && Date.now() - lastRpcSent < 900) return;

        const ipc = getIpc();
        if (!ipc) return;

        const lines = buildFixedLines(gameState);
        const partial = {
            details: lines.details,
            state: lines.state,
            showElapsed: config.DISCORD_SHOW_ELAPSED === true, // <- wichtig
            resetTimer: !!resetTimer
        };

        const party = config.DISCORD_USE_PARTY ? computeParty(gameState) : null;
        if (party) partial.partySize = party;

        ipc.send('rpc-update', partial);
        lastRpcSent = Date.now();
    } catch (_) { }
}

// --- Runtime reload of config + colors (no full restart required) ---
async function reloadRuntimeConfig() {
    try {
        await loadConfig();
        clearLightCaches('reloadRuntimeConfig');

        if (!isRunning) {
            info('🔁 Runtime config/colors reloaded (script is not running).');
            return true;
        }

        if (!isBombPlanted && !isBlinking && !isFading && !suppressColorUntilNextRound) {
            const team = gameState?.player?.team;
            if (team && colors[team]) {
                setUserTeamColor();
                lastColorMode = team;
            } else {
                setDefaultColor();
                lastColorMode = 'default';
            }
        }

        info('✅ Runtime config/colors reloaded and applied.');
        return true;
    } catch (e) {
        error(`❌ reloadRuntimeConfig failed: ${e.message}`);
        return false;
    }
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
    reloadRuntimeConfig
};