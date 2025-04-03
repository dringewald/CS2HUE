const fs = require('fs');
let logCallback = null;

function setLogger(callback) {
    logCallback = callback;
}

function log(message) {
    const fullMessage = `[${new Date().toLocaleTimeString()}] ${message}`;
    if (logCallback) logCallback(fullMessage);
    console._log(fullMessage); // preserve original logging
}

// Patch native console.log
console._log = console.log;
console.log = log;

module.exports = { setLogger, log };