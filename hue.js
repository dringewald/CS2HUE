const http = require('http');
const fs = require('fs');

const hueAPI = "http://192.168.1.194/api/WWNKlzc7RrWWvU8NXuUBkJCi6zt2SPsLi32Zo9EH"

const colors =
{
    "bomb": {
        "on": true,
        "xy": [
            0.6904,
            0.3091
        ],
    },
    "CT": {
        "on": true,
        "bri": 20,
        "xy": [
			0.1553,
			0.1284
		],
    },
    "T": {
        "on": true,
        "bri": 20,
        "xy": [
			0.5964,
			0.3797
		],
    },
    "default": {
        "on": true,
        "colormode": "ct",
        "ct": 399,
    },
    "exploded": {
        "on": true,
        "colormode": "ct",
        "ct": 318
    },
    "defused": {
        "on": true,
        "bri": 100,
        "xy": [
			0.1553,
			0.1284
		],
    },
}

const cockpitLights = [];
const ambientLights = [];

let gameState = {};
let isBombPlanted = false;
let isBombExploded = false;
let userTeam = '';
let blinkEffect;
let bombTimer;

async function getLightData(light) {
    try {
        const response = await fetch(`${hueAPI}/lights/${light}`);
        const body = await response.json();
        const state = body.state;
        return state;
    } catch (error) {
        console.error(error);
    }
}

function updateLightData(light, body){
    const request = fetch(`${hueAPI}/lights/${light}/state`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" }
    })

    request.then(async response => {
        try{
            const request = await response.json()
        }catch(e){
            console.log(e);
        }
    })

}

function blinkLight(light, interval){
    return setInterval(async () => {
        const state = await getLightData(light);
        if(state.on === true){
            updateLightData(42, { on : false });
        }else{
            updateLightData(42, { on : true });
        }
    }, interval);
}

function bombPlanted(){
    bombTimer = 40;
    updateLightData(42, colors.bomb);
    blinkEffect = blinkLight(42, 1000);
    let timer = setInterval(() => {
        bombTimer--
        if(bombTimer === 30){
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(42, 750);
        }
        if(bombTimer === 20){
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(42, 500);
        }
        if(bombTimer === 10){
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(42, 250);
        }
        if(bombTimer === 5){
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(42, 100);
        }
        if(bombTimer === 2){
            clearInterval(blinkEffect);
            clearInterval(timer);
        }
    }, 1000)
}

function bombExploded(){
    clearInterval(blinkEffect);
    bombTimer = null;
    updateLightData(42, colors.exploded);
    console.log("BOOM");
}

function bombDefused(){
    clearInterval(blinkEffect);
    bombTimer = null;
    updateLightData(42, colors.defused);
    console.log("Bomb has been defused.");
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
    updateLightData(42, colors[userTeam]);
}

setInterval(() => {
    
    let body = fs.readFileSync('gamestate.txt');
    gameState = JSON.parse(body);

    // Verify if game is ongoing
    if(gameState.round){

        // Bomb management
        if(gameState.round.bomb){
            if(isBombPlanted === false){
                if(gameState.round.bomb === "planted"){
                    isBombPlanted = true;
                    const bombCoucou = bombPlanted();
                    console.log("Bomb is planted");
                }
            }
            if(gameState.round.bomb === "exploded" && isBombExploded === false){
                isBombExploded = true;
                isBombPlanted = false;
                bombExploded();
            }
            if(gameState.round.bomb === "defused"){
                isBombPlanted = false;
                bombDefused();
            }
        }else{
            setUserTeamColor();  
        }
    }


}, 200)