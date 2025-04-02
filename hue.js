const http = require('http');
const fs = require('fs');
const config = require('./config.json');
const colors = require('./colors.json');

const hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`

const lightIDs = config.LIGHT_ID.split(',').map(id => id.trim());
let isTimerEnabled = config.SHOW_BOMB_TIMER;

let gameState = {};
let isBombPlanted = false;
let isBombExploded = false;
let isBombDefused = false;
let userTeam = '';
let blinkEffect = [];
let bombCountdown;
let timer;

function forEachLight(callback) {
    lightIDs.forEach(light => callback(light));
}

function startScript(){
    console.log("Connecting...");
    fetch(`${hueAPI}/lights/${lightIDs[0]}`)
    .then(async response => {
        console.log("Connected to Hue bridge.");
        const data = await response.json();
        if(data.state){
            console.log("Ready!");
        }else if(data[0]){
            const error = data[0].error
            if(error.type === 1){
                throw new Error("Error: API key is rejected by the server. Verify the one you provided.");
            }
            if(error.type === 3){
                throw new Error("Error: Can't find your light. Verify the ID you provided.");
            }
        }
    })
    .catch((error) => {
        if(error.message === "fetch failed"){
            console.log("Error: Can't connect to your Hue bridge. Verify IP address.");
        }else{
            console.log(error.message);
        }
    });
}

async function getLightData(light) {
    try {
        const response = await fetch(`${hueAPI}/lights/${light}`);
        const body = await response.json();
        return body.state;
    } catch(error) {
        console.error(error);
    }
}

function updateLightData(light, body){
    fetch(`${hueAPI}/lights/${light}/state`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" }
    })
    .then(async response => {
        try{
            const result = await response.json();
            return result;
        }catch(e){
            console.log(e);
        }
    });
}

function changeBrightness(light, value){
    getLightData(light).then(previousState => {
        if(previousState.on === false){
            updateLightData(light, {"on": true, "bri": value});
            updateLightData(light, {"on": false});
        }else{
            updateLightData(light, {"bri": value});
        }
    });
}

function blinkLight(light, speed, repetition){
    let repeater = 0;
    const interval = setInterval(async () => {
        const state = await getLightData(light);
        if(state.on === true){
            updateLightData(light, { on : false });
        }else{
            updateLightData(light, { on : true });
            repeater++;
            if(repeater === repetition){
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

function bombPlanted(){
    bombCountdown = 40;
    forEachLight(light => updateLightData(light, colors.bomb));
    blinkEffect = blinkAllLights(1000);

    timer = setInterval(() => {
        bombCountdown--;
        if(bombCountdown === 30){
            if(isTimerEnabled === true){
                console.log("Timer: 30s");
            }
            blinkEffect.forEach(clearInterval);
            blinkEffect = blinkAllLights(750);
        }
        if(bombCountdown === 20){
            if(isTimerEnabled === true){
                console.log("Timer: 20s");
            }
            blinkEffect.forEach(clearInterval);
            blinkEffect = blinkAllLights(500);
        }
        if(bombCountdown === 12){
            if(isTimerEnabled === true){
                console.log("Timer: 12s");
            }
            changeAllBrightness(50);
            blinkEffect.forEach(clearInterval);
            blinkEffect = blinkAllLights(250);
        }
		if(bombCountdown === 10 && isTimerEnabled === true){
            console.log("Timer: 10s");
        }
		if(bombCountdown === 9 && isTimerEnabled === true){
            console.log("Timer: 9s");
        }
		if(bombCountdown === 8 && isTimerEnabled === true){
            console.log("Timer: 8s");
        }
		if(bombCountdown === 7 && isTimerEnabled === true){
            console.log("Timer: 7s");
        }
		if(bombCountdown === 6 && isTimerEnabled === true){
            console.log("Timer: 6s");
        }
        if(bombCountdown === 5){
            if(isTimerEnabled === true){
                console.log("Timer: 5s");
            }
            changeAllBrightness(100);
            blinkEffect.forEach(clearInterval);
            blinkEffect = blinkAllLights(100);
        }
		if(bombCountdown === 4 && isTimerEnabled === true){
            console.log("Timer: 4s");
        }
		if(bombCountdown === 3 && isTimerEnabled === true){
            console.log("Timer: 3s");
        }
        if(bombCountdown === 2){
            if(isTimerEnabled === true){
                console.log("Timer: 2s");
            }
            blinkEffect.forEach(clearInterval);
            clearInterval(timer);
        }
		if(bombCountdown === 1 && isTimerEnabled === true){
            console.log("Timer: 1s");
        }
    }, 1000);
}

function bombExploded(){
    blinkEffect.forEach(clearInterval);
    bombCountdown = null;
    forEachLight(light => updateLightData(light, colors.exploded));
    console.log("BOOM");
}

function bombDefused(){
    blinkEffect.forEach(clearInterval);
    bombCountdown = null;
    forEachLight(light => updateLightData(light, colors.defused));
    console.log("Bomb has been defused");
    blinkAllLights(100, 3);
}

function setUserTeamColor(){
    if(!userTeam){
        userTeam = gameState.player.team;
        console.log("User is: " + userTeam);
    }else{
        if(userTeam != gameState.player.team){
            userTeam = gameState.player.team
            console.log("User is: " + userTeam);
        }
    }
    forEachLight(light => updateLightData(light, colors[userTeam]));
}

startScript();

setInterval(() => {
    try{
        let body = fs.readFileSync('gamestate.txt');
        gameState = JSON.parse(body);
    }catch{
        console.log("Error while fetching game state.")
    }

    if(gameState.round){
        if(gameState.round.bomb){
            if(isBombPlanted === false && gameState.round.bomb === "planted"){
                isBombPlanted = true;
                bombPlanted();
                console.log("Bomb has been planted");
            }
            if(gameState.round.bomb === "exploded" && isBombExploded === false){
                isBombExploded = true;
                isBombPlanted = false;
                bombExploded();
            }
            if(isBombDefused === false && gameState.round.bomb === "defused"){
                isBombPlanted = false;
                isBombDefused = true;
                bombDefused();
            }
        }else{
            if(gameState.player && gameState.player.team){
                setUserTeamColor();
            }
        }
    }
}, 200);