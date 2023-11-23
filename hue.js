const http = require('http');
const fs = require('fs');
const config = require('./config.json');
const colors = require('./colors.json');

const hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`

const currentLight = config.LIGHT_ID;

let gameState = {};
let isBombPlanted = false;
let isBombExploded = false;
let isBombDefused = false;
let userTeam = '';
let blinkEffect;
let bombCountdown;
let timer;

function startScript(){
    console.log("Connecting...");
    fetch(`${hueAPI}/lights/${currentLight}`)
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
        const state = body.state;
        return state;
    } catch(error) {
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
            return request;
        }catch(e){
            console.log(e);
        }
    })

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
};

function blinkLight(light, speed, repetition){
    let repeater = 0;
    const interval = setInterval(async () => {
        const state = await getLightData(light);
        if(state.on === true){
            updateLightData(currentLight, { on : false });
        }else{
            updateLightData(currentLight, { on : true });
            repeater++;
            if(repeater === repetition){
                clearInterval(interval);
            }
        }
    }, speed);
    return interval;
}

function bombPlanted(){
    bombCountdown = 40;
    updateLightData(currentLight, colors.bomb);
    blinkEffect = blinkLight(currentLight, 1000);
    timer = setInterval(() => {
        bombCountdown--
        if(bombCountdown === 30){
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(currentLight, 750);
        }
        if(bombCountdown === 20){
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(currentLight, 500);
        }
        if(bombCountdown === 12){
            changeBrightness(currentLight, 50);
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(currentLight, 250);
        }
        if(bombCountdown === 5){
            console.log("Timer at 5");
            changeBrightness(currentLight, 100);
            clearInterval(blinkEffect);
            blinkEffect = blinkLight(currentLight, 100);
        }
        if(bombCountdown === 2){
            clearInterval(blinkEffect);
            clearInterval(timer);
        }
    }, 1000)
}

function bombExploded(){
    clearInterval(blinkEffect);
    bombCountdown = null;
    updateLightData(currentLight, colors.exploded);
    console.log("BOOM");
}

function bombDefused(){
    clearInterval(blinkEffect);
    bombCountdown = null;
    updateLightData(currentLight, colors.defused);
    console.log("Bomb has been defused");
    blinkLight(currentLight, 100, 3);
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
    updateLightData(currentLight, colors[userTeam]);
}

startScript();

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
                    bombPlanted();
                    console.log("Bomb has been planted");
                }
            }
            if(gameState.round.bomb === "exploded" && isBombExploded === false){
                isBombExploded = true;
                isBombPlanted = false;
                bombExploded();
            }
            if(isBombDefused === false){
                if(gameState.round.bomb === "defused"){
                   isBombPlanted = false;
                   isBombDefused = true;
                   bombDefused();
               }
            }
        }else{
            setUserTeamColor();  
        }
    }


}, 200)
