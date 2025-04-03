const { log } = require('./logger');

const http = require('http');
const fs = require('fs');
const path = require('path');

let config;
let colors;
let lightIDs;
let hueAPI;
let isTimerEnabled;

let gameState = {};
let isBombPlanted = false;
let isBombExploded = false;
let isBombDefused = false;
let userTeam = '';
let blinkEffect = [];
let bombCountdown;
let timer;

function loadConfig() {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
    colors = JSON.parse(fs.readFileSync(path.join(__dirname, 'colors.json')));
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

function blinkLight(light, speed, repetition) {
    let repeater = 0;
    const interval = setInterval(async () => {
        const state = await getLightData(light);
        if (state.on === true) {
            updateLightData(light, { on: false });
        } else {
            updateLightData(light, { on: true });
            repeater++;
            if (repeater === repetition) {
                clearInterval(interval);
            }
        }
    }, speed);
    return interval;
}

function blinkAllLights(speed, repetition = Infinity) {
    return lightIDs.map(light => blinkLight(light, speed, repetition));
}

function changeAllBrightness(value) {
    forEachLight(light => changeBrightness(light, value));
}

function resetBombState() {
    if (timer) clearInterval(timer);
    if (blinkEffect.length) blinkEffect.forEach(clearInterval);

    isBombPlanted = false;
    isBombExploded = false;
    isBombDefused = false;
    bombCountdown = null;

    if (gameState.player && gameState.player.team) {
        setUserTeamColor();
    }
}

function bombPlanted() {
    bombCountdown = 40;
    forEachLight(light => updateLightData(light, colors.bomb));
    setTimeout(() => {
        blinkEffect = blinkAllLights(1000);
    }, 300);

    timer = setInterval(() => {
        bombCountdown--;
        if ([30, 20, 12, 5, 2].includes(bombCountdown)) {
            if (isTimerEnabled) log(`Timer: ${bombCountdown}s`);
            blinkEffect.forEach(clearInterval);
            let speed = bombCountdown === 30 ? 750 :
                        bombCountdown === 20 ? 500 :
                        bombCountdown === 12 ? 250 :
                        bombCountdown === 5  ? 100 :
                        0;
            if (bombCountdown === 12) changeAllBrightness(50);
            if (bombCountdown === 5) changeAllBrightness(100);
            if (speed > 0) blinkEffect = blinkAllLights(speed);
        }

        if (bombCountdown === 0) {
            clearInterval(timer);
            blinkEffect.forEach(clearInterval);
        }
    }, 1000);
}

function bombExploded() {
    blinkEffect.forEach(clearInterval);
    forEachLight(light => updateLightData(light, colors.exploded));
    log("💥 BOOM");
}

function bombDefused() {
    blinkEffect.forEach(clearInterval);
    forEachLight(light => updateLightData(light, colors.defused));
    blinkAllLights(100, 3);
    log("🛡 Bomb has been defused");
}

function setUserTeamColor() {
    if (!userTeam || userTeam !== gameState.player.team) {
        userTeam = gameState.player.team;
        log("User is: " + userTeam);
    }
    forEachLight(light => updateLightData(light, colors[userTeam]));
}

function startScript() {
    loadConfig();
    log("🎯 Connecting...");

    // Start local server
    const server = http.createServer((req, res) => {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', data => body = data.toString());
            req.on('end', () => {
                fs.writeFile('gamestate.txt', body, err => {
                    if (err) console.error("Error writing gamestate:", err);
                });
                res.writeHead(200);
                res.end('');
            });
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body>Hue Light Sync Active</body></html>`);
        }
    });

    server.listen(8080, '127.0.0.1', () => {
        log('🟢 Server listening on http://127.0.0.1:8080');
    });

    // Game state polling
    setInterval(() => {
        try {
            const body = fs.readFileSync('gamestate.txt');
            gameState = JSON.parse(body);
        } catch {
            return;
        }

        if (gameState.round) {
            if (!gameState.round.bomb && (isBombPlanted || isBombExploded || isBombDefused)) {
                resetBombState();
            }

            if (gameState.round.bomb === "planted" && !isBombPlanted) {
                isBombPlanted = true;
                bombPlanted();
                log("💣 Bomb has been planted");
            }

            if (gameState.round.bomb === "exploded" && !isBombExploded) {
                isBombExploded = true;
                isBombPlanted = false;
                bombExploded();
            }

            if (gameState.round.bomb === "defused" && !isBombDefused) {
                isBombDefused = true;
                isBombPlanted = false;
                bombDefused();
            }
        }

        if (
            gameState.player &&
            gameState.player.team &&
            (!gameState.round.bomb || gameState.round.bomb === "none")
        ) {
            setUserTeamColor();
        }
    }, 200);
}

module.exports = { startScript };
