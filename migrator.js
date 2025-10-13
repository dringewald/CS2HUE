const fs = require('fs');
const path = require('path');
const { getColorsPath, getBackupPath, getConfigPath } = require('./paths');
const { info, warn, error } = require('./logger');

/** ---------- DEFAULTS ---------- **/

const COLOR_TEMPLATES = {
    "menu": { "bri": 100, "x": 0.3227, "y": 0.329, "useCt": false, "enabled": true },
    "warmup": { "bri": 100, "x": 0.3552, "y": 0.398, "useCt": false, "enabled": true },
    "CT": { "bri": 20, "x": 0.1553, "y": 0.1284, "useCt": false, "enabled": true },
    "T": { "bri": 20, "x": 0.5964, "y": 0.3797, "useCt": false, "enabled": true },
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
    "exploded": { "bri": 100, "x": 0.5, "y": 0.5, "ct": 318, "useCt": false, "enabled": true },
    "defused": { "bri": 100, "x": 0.1553, "y": 0.1284, "useCt": false, "enabled": true },
    "win": { "bri": 254, "x": 0.3246, "y": 0.5805, "useCt": false, "enabled": true },
    "lose": { "bri": 254, "x": 0.6401, "y": 0.33, "useCt": false, "enabled": true },
    "default": { "bri": 100, "x": 0.2952, "y": 0.5825, "useCt": false, "enabled": true }
};

// Vollständige Default-Config inkl. Discord
const DEFAULT_CONFIG = {
    PROVIDER: "hue",
    BRIDGE_IP: "",
    API_KEY: "",
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: 8080,
    LIGHT_ID: "",
    SHOW_BOMB_TIMER: false,

    HTML_LOG: false,
    DEBUG_MODE: false,
    LIVE_LOG_LINES: 1000,

    YEELIGHT_DISCOVERY: false,
    YEELIGHT_DEVICES: "",

    DISCORD_RPC_ENABLED: false,
    DISCORD_SHOW_ELAPSED: true,
    DISCORD_USE_PARTY: true,
    DISCORD_RESET_ON_ROUND: false,
    DISCORD_UPDATE_RATE: 15,
    DISCORD_EVENTS: {
        menu: true,
        roundStart: true,
        bombPlanted: true,
        bombDefused: true,
        bombExploded: true,
        roundWon: true,
        roundLost: true
    }
};

/** ---------- HELPERS ---------- **/
function safeParseJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }
function clampInt(n, min, max, fallback) {
    const num = Number(n);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}
function ensureBackupDirExists(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:T]/g, '-').split('.')[0];
}
function cleanOldBackups(dir) {
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('-colors-backup.json') || f.endsWith('-config-backup.json'))
        .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    const maxBackups = 5;
    for (let i = maxBackups; i < files.length; i++) {
        try { fs.unlinkSync(path.join(dir, files[i])); info(`🧹 Removed old backup: ${files[i]}`); }
        catch (err) { warn(`⚠️ Could not delete old backup ${files[i]}: ${err.message}`); }
    }
}

function migrateMissingColors() {
    const colorsPath = getColorsPath();

    if (!fs.existsSync(colorsPath)) {
        warn("⚠️ colors.json not found — migration skipped.");
        return;
    }

    let colors;
    let originalRaw;

    try {
        originalRaw = fs.readFileSync(colorsPath, 'utf-8');
        colors = JSON.parse(originalRaw);
    } catch (err) {
        const backupDir = getBackupPath();
        ensureBackupDirExists(backupDir);
        const backupName = `${getTimestamp()}-colors-backup.json`;
        try {
            fs.copyFileSync(colorsPath, path.join(backupDir, backupName));
            info(`📦 Backed up malformed colors.json to backups/${backupName}`);
        } catch (copyErr) {
            error(`❌ Failed to back up colors.json: ${copyErr.message}`);
        }
        fs.writeFileSync(colorsPath, JSON.stringify(COLOR_TEMPLATES, null, 4));
        info("✅ colors.json was malformed and has been replaced with default template.");
        cleanOldBackups(backupDir);
        return;
    }

    // Track whether we actually mutated anything
    let didChange = false;

    // Add missing top-level keys (disabled by default so it's non-invasive)
    const missingKeys = Object.keys(COLOR_TEMPLATES).filter(k => !(k in colors));
    for (const key of missingKeys) {
        colors[key] = { ...COLOR_TEMPLATES[key], enabled: false };
        didChange = true;
        warn(`⚠️ Added missing color: "${key}" (enabled: false)`);
    }

    // Complete missing properties per color key
    for (const key of Object.keys(COLOR_TEMPLATES)) {
        const tmpl = COLOR_TEMPLATES[key];
        const obj = colors[key];
        if (!obj) continue;
        let added = 0;
        for (const prop of Object.keys(tmpl)) {
            if (!(prop in obj)) { obj[prop] = tmpl[prop]; added++; didChange = true; }
        }
        if (added > 0) warn(`⚠️ Completed missing properties for color "${key}" (${added} added).`);
    }

    // Only write when something changed; avoid churn + useless logs
    if (!didChange) {
        info("✅ colors.json is up-to-date (no migration needed).");
        return;
    }

    const nextRaw = JSON.stringify(colors, null, 4);
    if (nextRaw !== originalRaw) {
        fs.writeFileSync(colorsPath, nextRaw);
    }

    info(`✅ Color migration complete. ${missingKeys.length} new color key(s) added.`);
}

/** ---------- CONFIG MIGRATION ---------- **/

function sanitizeProvider(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'yeelight' || s === 'hue') ? s : 'hue';
}

// migrator.js

function migrateConfig() {
    const configPath = getConfigPath();

    if (!fs.existsSync(configPath)) {
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 4));
        info("🆕 config.json missing — wrote DEFAULT_CONFIG.");
        return;
    }

    let raw = '';
    try { raw = fs.readFileSync(configPath, 'utf-8'); }
    catch (err) { error(`❌ Failed to read config.json: ${err.message}`); return; }

    let cfg = safeParseJSON(raw);
    const backupDir = getBackupPath();
    ensureBackupDirExists(backupDir);

    // Malformed JSON → backup once + reset to defaults
    if (!cfg || typeof cfg !== 'object') {
        const backupName = `${getTimestamp()}-config-backup.json`;
        try { fs.writeFileSync(path.join(backupDir, backupName), raw || ''); info(`📦 Backed up malformed config.json to backups/${backupName}`); }
        catch (copyErr) { warn(`⚠️ Could not back up malformed config.json: ${copyErr.message}`); }
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 4));
        info("✅ config.json was malformed — replaced with DEFAULT_CONFIG.");
        cleanOldBackups(backupDir);
        return;
    }

    // Remove legacy keys once
    for (const legacy of ['DISCORD_DETAILS_TPL', 'DISCORD_STATE_TPL']) {
        if (legacy in cfg) { delete cfg[legacy]; info(`🧹 Removed legacy key: ${legacy}`); }
    }

    let changed = false;

    // Helpers that avoid flipping from "" to default (treat empty as intentional)
    const ensureStringLenient = (key, defVal) => {
        const v = cfg[key];
        if (v === undefined) { cfg[key] = String(defVal ?? ''); changed = true; return; }
        if (typeof v !== 'string') { cfg[key] = String(v ?? ''); changed = true; return; }
        // keep empty string as-is (don’t mark changed)
    };
    const ensure = (key, defVal) => { if (cfg[key] === undefined) { cfg[key] = defVal; changed = true; } };
    const ensureBool = (key, defVal) => { if (typeof cfg[key] !== 'boolean') { cfg[key] = !!cfg[key]; if (cfg[key] !== !!cfg[key]) changed = true; } };
    const ensureIntClamp = (key, defVal, min, max) => {
        const v = clampInt(cfg[key], min, max, defVal);
        if (!Number.isFinite(cfg[key])) {
            // only set default if value was missing/invalid; don’t “fix” a harmless string-number unless it changes the numeric value
            if (cfg[key] !== v) { cfg[key] = v; changed = true; }
        } else if (cfg[key] !== v) { cfg[key] = v; changed = true; }
    };

    // Provider
    const prevProvider = cfg.PROVIDER;
    cfg.PROVIDER = sanitizeProvider(cfg.PROVIDER || DEFAULT_CONFIG.PROVIDER);
    if (cfg.PROVIDER !== prevProvider) changed = true;

    // Base
    ensureStringLenient('BRIDGE_IP', DEFAULT_CONFIG.BRIDGE_IP);
    ensureStringLenient('API_KEY', DEFAULT_CONFIG.API_KEY);
    ensureStringLenient('SERVER_HOST', DEFAULT_CONFIG.SERVER_HOST);
    ensureIntClamp('SERVER_PORT', DEFAULT_CONFIG.SERVER_PORT, 1, 65535);
    ensureStringLenient('LIGHT_ID', DEFAULT_CONFIG.LIGHT_ID);
    ensure('SHOW_BOMB_TIMER', DEFAULT_CONFIG.SHOW_BOMB_TIMER);

    // Logger/UI
    ensure('HTML_LOG', DEFAULT_CONFIG.HTML_LOG);
    ensure('DEBUG_MODE', DEFAULT_CONFIG.DEBUG_MODE);
    ensureIntClamp('LIVE_LOG_LINES', DEFAULT_CONFIG.LIVE_LOG_LINES, 100, 20000);

    // Yeelight
    ensure('YEELIGHT_DISCOVERY', DEFAULT_CONFIG.YEELIGHT_DISCOVERY);
    ensureStringLenient('YEELIGHT_DEVICES', DEFAULT_CONFIG.YEELIGHT_DEVICES);

    // Discord toggles/options
    ensure('DISCORD_RPC_ENABLED', DEFAULT_CONFIG.DISCORD_RPC_ENABLED);
    ensure('DISCORD_SHOW_ELAPSED', DEFAULT_CONFIG.DISCORD_SHOW_ELAPSED);
    ensure('DISCORD_USE_PARTY', DEFAULT_CONFIG.DISCORD_USE_PARTY);
    ensure('DISCORD_RESET_ON_ROUND', DEFAULT_CONFIG.DISCORD_RESET_ON_ROUND);
    ensureIntClamp('DISCORD_UPDATE_RATE', DEFAULT_CONFIG.DISCORD_UPDATE_RATE, 5, 120);

    // Events object: fill known keys, drop unknowns
    if (!cfg.DISCORD_EVENTS || typeof cfg.DISCORD_EVENTS !== 'object') {
        cfg.DISCORD_EVENTS = { ...DEFAULT_CONFIG.DISCORD_EVENTS };
        changed = true;
    } else {
        const ev = cfg.DISCORD_EVENTS;
        for (const k of Object.keys(DEFAULT_CONFIG.DISCORD_EVENTS)) {
            if (typeof ev[k] !== 'boolean') { ev[k] = DEFAULT_CONFIG.DISCORD_EVENTS[k]; changed = true; }
        }
        for (const k of Object.keys(ev)) {
            if (!(k in DEFAULT_CONFIG.DISCORD_EVENTS)) { delete ev[k]; changed = true; }
        }
    }

    // If nothing changed logically, bail early
    if (!changed) {
        info("✅ config.json is up-to-date (no migration needed).");
        return;
    }

    // Serialize and compare against previous raw to avoid churn-only backups
    const nextRaw = JSON.stringify(cfg, null, 4);
    if (nextRaw === raw) {
        info("✅ config.json normalized but unchanged — skipped backup/write.");
        return;
    }

    // Real change → create backup (once), write, then prune old backups
    const backupName = `${getTimestamp()}-config-backup.json`;
    try { fs.writeFileSync(path.join(backupDir, backupName), raw); info(`📦 Backed up config.json to backups/${backupName}`); }
    catch (err) { warn(`⚠️ Could not create config backup: ${err.message}`); }

    try { fs.writeFileSync(configPath, nextRaw); info("✅ Config migration complete."); }
    catch (err) { error(`❌ Failed to write config.json: ${err.message}`); }

    cleanOldBackups(backupDir);
}


/** ---------- EXPORT ---------- **/
module.exports = {
    migrateMissingColors,
    migrateConfig,
};