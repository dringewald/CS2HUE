const fs = require('fs');
const path = require('path');
const { getColorsPath, getBackupPath } = require('./paths');
const { info, warn, error } = require('./logger');

const COLOR_TEMPLATES = {
    "menu": {
        "bri": 100, "x": 0.3227, "y": 0.329, "useCt": false, "enabled": true
    },
    "warmup": {
        "x": 0.3552, "y": 0.398, "bri": 100, "useCt": false, "enabled": true
    },
    "CT": {
        "bri": 20, "x": 0.1553, "y": 0.1284, "useCt": false, "enabled": true
    },
    "T": {
        "bri": 20, "x": 0.5964, "y": 0.3797, "useCt": false, "enabled": true
    },
    "bomb": {
        "enabled": true,
        "x": 0.675, "y": 0.322, "bri": 25,
        "initialTime": 40,
        "initialBlinkSpeed": 1000,
        "stages": {
            "30": { "bri": 20, "speed": 750 },
            "20": { "bri": 35, "speed": 500 },
            "12": { "bri": 50, "speed": 250 },
            "5": { "bri": 100, "speed": 150 },
            "2": { "bri": 150, "speed": 0 }
        }
    },
    "exploded": {
        "bri": 100, "x": 0.5, "y": 0.5, "ct": 318, "useCt": false, "enabled": true
    },
    "defused": {
        "bri": 100, "x": 0.1553, "y": 0.1284, "useCt": false, "enabled": true
    },
    "win": {
        "bri": 254, "x": 0.3246, "y": 0.5805, "useCt": false, "enabled": true
    },
    "lose": {
        "bri": 254, "x": 0.6401, "y": 0.33, "useCt": false, "enabled": true
    },
    "default": {
        "bri": 100, "x": 0.2952, "y": 0.5825, "useCt": false, "enabled": true
    }
};

function ensureBackupDirExists(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function cleanOldBackups(dir) {
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('-colors-backup.json'))
        .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);

    const maxBackups = 5;
    for (let i = maxBackups; i < files.length; i++) {
        try {
            fs.unlinkSync(path.join(dir, files[i]));
            info(`🧹 Removed old backup: ${files[i]}`);
        } catch (err) {
            warn(`⚠️ Could not delete old backup ${files[i]}: ${err.message}`);
        }
    }
}

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:T]/g, '-').split('.')[0];
}

function migrateMissingColors() {
    const colorsPath = getColorsPath();

    if (!fs.existsSync(colorsPath)) {
        warn("⚠️ colors.json not found — migration skipped.");
        return;
    }

    let colors;

    try {
        const raw = fs.readFileSync(colorsPath, 'utf-8');
        colors = JSON.parse(raw);
    } catch (err) {
        // Malformed file – backup and replace
        const backupDir = getBackupPath();
        ensureBackupDirExists(backupDir);

        const timestamp = getTimestamp();
        const backupName = `${timestamp}-colors-backup.json`;
        const backupPath = path.join(backupDir, backupName);

        try {
            fs.copyFileSync(colorsPath, backupPath);
            info(`📦 Backed up malformed colors.json to backups/${backupName}`);
        } catch (copyErr) {
            error(`❌ Failed to back up colors.json: ${copyErr.message}`);
        }

        fs.writeFileSync(colorsPath, JSON.stringify(COLOR_TEMPLATES, null, 4));
        info("✅ colors.json was malformed and has been replaced with default template.");

        cleanOldBackups(backupDir);
        return;
    }

    const missingKeys = Object.keys(COLOR_TEMPLATES).filter(key => !(key in colors));

    if (missingKeys.length === 0) {
        return;
    }

    for (const key of missingKeys) {
        const patch = { ...COLOR_TEMPLATES[key], enabled: false };
        colors[key] = patch;
        warn(`⚠️ Added missing color: "${key}" (enabled: false)`);
    }

    fs.writeFileSync(colorsPath, JSON.stringify(colors, null, 4));
    info(`✅ Migration complete. ${missingKeys.length} missing color(s) added to colors.json`);
}

module.exports = { migrateMissingColors };