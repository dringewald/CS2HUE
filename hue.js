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
        "xy": [
			0.1553,
			0.1284
		],
    },
    "T": {
        "on": true,
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
    }
}

const cockpitLights = [];
const ambientLights = [];

let isBlinking = false;
let isBombPlanted = false;
let isBombExploded = false;
let userTeam = '';

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

async function blinkLight(light, interval){
    setInterval(async () => {
        const state = await getLightData(light);
        if(state.on === true){
            updateLightData(42, { on : false });
        }else{
            updateLightData(42, { on : true });
        }
    }, interval);
}

function bombPlanted(){
    let bombCountdown = 40;
    updateLightData(42, colors.bomb);
    blinkLight(42, 1000);
}

function bombExploded(){
    updateLightData(42, colors.exploded);
}

let gameState = {};

// setInterval(() => {
    
//     let body = fs.readFileSync('gamestate.txt');
//     gameState = JSON.parse(body);

//     // Bomb management
//     if(gameState.round.bomb){
//         if(isBlinking === false){
//             if(gameState.round.bomb === "planted"){
//                 isBombPlanted = true;
//                 bombPlanted();
//                 isBlinking = true;
//                 console.log("Bomb is planted");
//             }
//         }
//         if(gameState.round.bomb === "exploded" && isBombExploded === false){
//             isBombExploded = true;
//             isBombPlanted = false;
//             isBlinking = false;
//             console.log("BOOM");
//         }
//     }

//     // Team management
//     if(!userTeam){
//         userTeam = gameState.player.team;
//         updateLightData(42, colors[userTeam]);
//         console.log("User is: " + userTeam);
//     }else{
//         if(userTeam != gameState.player.team){
//             userTeam = gameState.player.team
//             updateLightData(42, colors[userTeam]);
//             console.log("User is: " + userTeam);
//         }
//     }

// }, 100)