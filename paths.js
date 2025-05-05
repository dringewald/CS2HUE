// paths.js
const path = require('path');

let basePath = __dirname;
let configPath, colorsPath, logPath, previousStatePath, gamestatePath;

function setBasePath(userBasePath) {
    basePath = userBasePath;
    configPath = path.join(basePath, 'config.json');
    colorsPath = path.join(basePath, 'colors.json');
    logPath = path.join(basePath, 'logs');
    previousStatePath = path.join(basePath, 'previousState.json');
    gamestatePath = path.join(basePath, 'gamestate.txt');
}

module.exports = {
    setBasePath,
    getBasePath: () => basePath,
    getConfigPath: () => configPath,
    getColorsPath: () => colorsPath,
    getLogPath: () => logPath,
    getPreviousStatePath: () => previousStatePath,
    getGamestatePath: () => gamestatePath
};