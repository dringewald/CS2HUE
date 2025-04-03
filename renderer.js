const { startScript } = require('./logic.js');
const { setLogger } = require('./logger');

const fs = require('fs');
const path = require('path');
const logBox = document.getElementById('log');

// Path to config file
const configPath = path.join(__dirname, 'config.json');

// Load stuff on page load
window.onload = () => {
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        document.getElementById('bridgeIP').value = config.BRIDGE_IP || '';
        document.getElementById('apiKey').value = config.API_KEY || '';
        document.getElementById('lightIds').value = config.LIGHT_ID || '';
        document.getElementById('showTimer').value = config.SHOW_BOMB_TIMER ? 'true' : 'false';
        log("🔧 Loaded config.json");
    } else {
        log("config.json not found. Please fill out the form and save.");
    }

    loadColors();

    // 👇 Hook up the log callback
    setLogger(log);
};

// Save config button
document.getElementById('saveConfig').addEventListener('click', () => {
    const config = {
        BRIDGE_IP: document.getElementById('bridgeIP').value,
        API_KEY: document.getElementById('apiKey').value,
        LIGHT_ID: document.getElementById('lightIds').value,
        SHOW_BOMB_TIMER: document.getElementById('showTimer').value === 'true'
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    log("✅ Config saved.");
});

// Start the script
document.getElementById('startScript').addEventListener('click', () => {
    log("▶️ Starting bomb script...");
    startScript();
});

// Logging helper
function log(message) {
    logBox.textContent += message + '\n';
    logBox.scrollTop = logBox.scrollHeight;
}

function xyToRgb(xy) {
    if (!xy || xy.length !== 2) return '200, 200, 200';

    const [x, y] = xy;
    const z = 1.0 - x - y;
    const Y = 1.0;
    const X = (Y / y) * x;
    const Z = (Y / y) * z;

    // Convert to RGB using Wide RGB D65 conversion
    let r =  X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b =  X * 0.051713 - Y * 0.121364 + Z * 1.011530;

    // Normalize
    r = r <= 0.0031308 ? 12.92 * r : 1.055 * (r ** (1 / 2.4)) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * (g ** (1 / 2.4)) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * (b ** (1 / 2.4)) - 0.055;

    r = Math.min(Math.max(0, r), 1);
    g = Math.min(Math.max(0, g), 1);
    b = Math.min(Math.max(0, b), 1);

    return `${Math.floor(r * 255)}, ${Math.floor(g * 255)}, ${Math.floor(b * 255)}`;
}

// Load and show colors from colors.json
const colorsPath = path.join(__dirname, 'colors.json');

function loadColors() {
    const colorsContainer = document.getElementById('colorsDisplay');
    colorsContainer.innerHTML = '';

    if (!fs.existsSync(colorsPath)) {
        log('⚠️ colors.json not found.');
        return;
    }

    const colors = JSON.parse(fs.readFileSync(colorsPath, 'utf-8'));

    for (const [name, color] of Object.entries(colors)) {
        const wrapper = document.createElement('div');
        wrapper.style.border = '1px solid #444';
        wrapper.style.padding = '10px';
        wrapper.style.background = '#222';
        wrapper.style.borderRadius = '8px';

        // Color preview (based on xy — approximate!)
        const preview = document.createElement('div');
        preview.style.height = '25px';
        preview.style.borderRadius = '4px';
        preview.style.marginBottom = '8px';
        preview.style.background = color.xy ? `rgb(${xyToRgb(color.xy)})` : '#888';
        preview.title = `Preview of ${name}`;
        wrapper.appendChild(preview);

        wrapper.innerHTML += `
            <strong>${name}</strong><br/>

            <label>Brightness (bri):</label>
            <input type="number" min="1" max="254" data-name="${name}" data-key="bri" value="${color.bri ?? ''}"/>

            <label>XY:</label>
            <input type="text" placeholder="[x, y]" data-name="${name}" data-key="xy" value="${color.xy ? `[${color.xy.join(',')}]` : ''}"/>

            <label>Color Temp (ct):</label>
            <input type="number" min="153" max="500" data-name="${name}" data-key="ct" value="${color.ct ?? ''}"/>
        `;

        colorsContainer.appendChild(wrapper);
    }
}

document.getElementById('saveColors').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#colorsDisplay input');
    const newColors = {};

    inputs.forEach(input => {
        const name = input.dataset.name;
        const key = input.dataset.key;
        if (!newColors[name]) newColors[name] = { on: true };

        if (key === 'xy') {
            try {
                newColors[name][key] = JSON.parse(input.value);
            } catch {
                newColors[name][key] = [0.5, 0.5]; // fallback
            }
        } else if (input.value !== '') {
            newColors[name][key] = parseInt(input.value);
        }
    });

    fs.writeFileSync(colorsPath, JSON.stringify(newColors, null, 4));
    log("✅ Saved updated colors.json");
    loadColors(); // refresh UI
});
