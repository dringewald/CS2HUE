const { info, warn, error, debug, setHtmlLogEnabled, setDebugMode, setRendererLogFunction, setMaxSessionLines, initializeLogger } = require('./logger');
const { startScript, stopScript, isScriptRunning, anyLightInSyncMode, getHueAPI } = require('./logic.js');
const { setBasePath, getConfigPath, getColorsPath, getBackupPath } = require('./paths');
const { migrateMissingColors, migrateConfig } = require('./migrator');
const { ipcRenderer } = require('electron');
const HueBridgeHelper = require('./hueBridgeHelper');
const fs = require('fs');
const path = require('path');
let scriptIsRunning = false;
let lightIDs = [];
let lightIDsReady = false;
let scriptIsStarting = false;
let scriptIsStopping = false;

ipcRenderer.on('set-light-ids', (event, ids) => {
    lightIDs = ids;
    lightIDsReady = true;
    debug("🔧 lightIDs set in renderer:", lightIDs);
});

ipcRenderer.on('log-line', (_e, message) => {
    const logBox = document.getElementById('log');
    if (!logBox) return;
    logBox.textContent += message + '\n';
    logBox.scrollTop = logBox.scrollHeight;
});

ipcRenderer.on('reset-lights', async () => {
    if (isTestingColor) {
        info("🔙 Stopping color test and resetting lights...");
        await restorePreviousLightState();
        isTestingColor = false;
        testedColorName = null;
    }

    ipcRenderer.send('lights-reset-complete');
});

ipcRenderer.on('app-is-shutting-down', () => {
    document.body.innerHTML = '<h1 style="color:white;text-align:center">Shutting down...</h1>';
});

setRendererLogFunction((message) => {
    if (
        message.startsWith('[INFO]') ||
        message.startsWith('[WARN]') ||
        message.startsWith('[ERROR]')
    ) {
        const logBox = document.getElementById('log');
        if (logBox) {
            logBox.textContent += message + '\n';
            logBox.scrollTop = logBox.scrollHeight;
        }
    }

    if (message.startsWith('[DEBUG]')) {
        console.log(message);
    } else {
        console.log(message);
    }
});

const logBox = document.getElementById('log');
if (!logBox) {
    console.warn("⚠️ logBox not found. Is #log missing in your HTML?");
}

window.addEventListener('DOMContentLoaded', async () => {
    const isPackaged = await ipcRenderer.invoke('get-is-packaged');

    const defaultConfigPath = isPackaged
        ? path.join(__dirname, 'config.json')
        : path.join(__dirname, 'config.json');

    const defaultColorsPath = isPackaged
        ? path.join(__dirname, 'colors.json')
        : path.join(__dirname, 'colors.json');

    await setupPaths(defaultConfigPath, defaultColorsPath);
    initializeLogger();

    // Migrate missing color and Discord config fields
    migrateMissingColors();
    migrateConfig();
    initializeApp();

    window.addEventListener('focus', () => {
        const v = document.getElementById('discordRpcToggle')?.value;
        if (v === 'true') ipcRenderer.send('rpc-bump');
    });
});

function sanitizeColorObject(obj) {
    for (const key in obj) {
        if (obj[key] === null || key === 'undefined') {
            delete obj[key];
        }
    }
    return obj;
}

function showLightSelectionModal(lightList, options = {}) {
    // Ensure all required DOM nodes exist; create missing ones exactly once.
    function ensureScaffold() {
        const modal = document.getElementById('lightSelectionModal');
        if (!modal) {
            warn('⚠️ lightSelectionModal not found; falling back to alert.');
            alert('Select Lights dialog missing in HTML.');
            return null;
        }

        // Prefer the inner modal content container if present
        const content = modal.querySelector('.modal-content') || modal;

        // --- Title (ensure there is exactly one <h2>) -----------------------------
        let titleEl = content.querySelector('h2');
        if (!titleEl) {
            titleEl = document.createElement('h2');
            content.prepend(titleEl);
        }

        // --- Warning box (hidden by default) --------------------------------------
        let warningBox = content.querySelector('#modalWarning');
        if (!warningBox) {
            warningBox = document.createElement('p');
            warningBox.id = 'modalWarning';
            warningBox.style.display = 'none';
            warningBox.className = 'modal-warning';
            content.appendChild(warningBox);
        }

        // === Tabs: use existing HTML (.tab-container + .tab-content) ==============
        let tabContainer = content.querySelector('.tab-container');
        let tabContent = content.querySelector('.tab-content');

        if (!tabContainer || !tabContent) {
            warn('⚠️ Missing .tab-container/.tab-content in modal HTML.');
        }

        // --- Clean up legacy structures from older builds -------------------------
        // Remove any previously injected ".tab-bar" / ".tab-panes" to prevent duplicates
        content.querySelectorAll('.tab-bar, .tab-panes').forEach(n => n.remove());

        // Keep only the first copy of the modern containers (defensive against duplicates)
        [...content.querySelectorAll('.tab-container')].slice(1).forEach(n => n.remove());
        [...content.querySelectorAll('.tab-content')].slice(1).forEach(n => n.remove());

        // Keep only the first instances of the panes by id
        [...content.querySelectorAll('#groupedTab')].slice(1).forEach(n => n.remove());
        [...content.querySelectorAll('#allTab')].slice(1).forEach(n => n.remove());

        // Re-resolve after cleanup
        tabContainer = content.querySelector('.tab-container');
        tabContent = content.querySelector('.tab-content');

        // Lists
        const groupedList = content.querySelector('#groupedLightsList');
        const allList = content.querySelector('#allLightsList');

        // Legacy single-list container: keep (hidden) for backward compatibility
        let legacyList = content.querySelector('#lightCheckboxList');
        if (!legacyList) {
            legacyList = document.createElement('div');
            legacyList.id = 'lightCheckboxList';
            legacyList.style.display = 'none';
            content.appendChild(legacyList);
        }

        // Footer action buttons (create only if missing)
        let confirmBtn = content.querySelector('#confirmLightSelection');
        let cancelBtn = content.querySelector('#cancelLightSelection');
        if (!confirmBtn && !cancelBtn) {
            const footer = document.createElement('div');
            footer.className = 'modal-footer';
            footer.innerHTML = `
            <button id="confirmLightSelection">✅ OK</button>
            <button id="cancelLightSelection">❌ Cancel</button>
          `;
            content.appendChild(footer);
            confirmBtn = footer.querySelector('#confirmLightSelection');
            cancelBtn = footer.querySelector('#cancelLightSelection');
        }

        // Wire tab switching once (idempotent, scoped to this modal)
        if (tabContainer && tabContent) {
            tabContainer.querySelectorAll('.tab-btn').forEach(btn => {
                if (btn._wired) return;            // avoid double binding
                btn._wired = true;
                btn.addEventListener('click', () => {
                    // deactivate all
                    tabContainer.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    tabContent.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                    // activate selected
                    btn.classList.add('active');
                    const pane = tabContent.querySelector(`#${btn.dataset.tab}Tab`);
                    if (pane) pane.classList.add('active');
                });
            });
        }

        // Return all handles needed by callers
        return {
            modal,
            content,
            titleEl,
            warningBox,
            groupedList,
            allList,
            legacyList,
            confirmBtn,
            cancelBtn
        };
    }

    // Render one checkbox entry and keep its state synced across tabs
    function makeCheckboxRenderer(previouslySelected, registry) {
        return function renderCheckbox(light) {
            const { id, name } = light;

            const label = document.createElement('label');
            label.className = 'modal-checkbox';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = id;
            checkbox.checked = previouslySelected.includes(id);

            if (!registry[id]) registry[id] = [];
            registry[id].push(checkbox);

            checkbox.addEventListener('change', () => {
                // Keep all clones of the same ID in sync
                registry[id].forEach(cb => { if (cb !== checkbox) cb.checked = checkbox.checked; });
            });

            const checkmark = document.createElement('span');
            checkmark.className = 'modal-checkbox-checkmark';

            const text = document.createElement('span');
            text.textContent = `${name} [ID: ${id}]`;
            text.className = 'modal-checkbox-text';

            label.appendChild(checkbox);
            label.appendChild(checkmark);
            label.appendChild(text);
            return label;
        };
    }

    // Add non-duplicating bulk controls (Select/Deselect all)
    function ensureBulkControls(content, anchorEl) {
        // Remove old instance if present to avoid stacking
        const old = content.querySelector('#bulkControls');
        if (old) old.remove();

        const wrap = document.createElement('div');
        wrap.id = 'bulkControls';
        wrap.style.display = 'flex';
        wrap.style.justifyContent = 'flex-end';
        wrap.style.gap = '10px';
        wrap.style.marginBottom = '10px';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.textContent = '✔️ Select All';

        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.textContent = '❌ Deselect All';

        selectAllBtn.onclick = () => {
            content.querySelectorAll('.tab-pane.active input[type="checkbox"]').forEach(cb => cb.checked = true);
        };
        deselectAllBtn.onclick = () => {
            content.querySelectorAll('.tab-pane.active input[type="checkbox"]').forEach(cb => cb.checked = false);
        };

        wrap.appendChild(selectAllBtn);
        wrap.appendChild(deselectAllBtn);

        anchorEl.parentElement.insertBefore(wrap, anchorEl);
    }

    const scaffold = ensureScaffold();
    if (!scaffold) return;
    resetModalHeader(options.title || '💡 Select Your Hue Lights');

    const {
        modal, content, titleEl, warningBox,
        groupedList, allList, legacyList,
        confirmBtn, cancelBtn
    } = scaffold;

    // Title + reset messages
    titleEl.textContent = options.title || 'Select Lights';
    warningBox.textContent = '';
    warningBox.style.display = 'none';

    // Clear lists to avoid duplicates
    groupedList.innerHTML = '';
    allList.innerHTML = '';
    legacyList.innerHTML = '';

    // Read previously selected IDs from config.json (best effort)
    let previouslySelected = [];
    try {
        if (fs.existsSync(getConfigPath())) {
            const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
            previouslySelected = cfg.LIGHT_ID?.split(',').map(s => s.trim()) || [];
        }
    } catch (e) {
        warn('⚠️ Failed to read previous LIGHT_ID from config.json');
    }

    // Create bulk controls bar once (no duplicates)
    ensureBulkControls(content, groupedList);

    // Fill the lists depending on the input format
    const isGrouped = !Array.isArray(lightList);

    // Build checkbox renderer + registry
    const checkboxRegistry = {};
    const renderCheckbox = makeCheckboxRenderer(previouslySelected, checkboxRegistry);

    // clear
    groupedList.innerHTML = '';
    allList.innerHTML = '';

    // Helper refs (resolve from DOM each time)
    const groupedBtn = content.querySelector('.tab-btn[data-tab="grouped"]');
    const allBtn = content.querySelector('.tab-btn[data-tab="all"]');
    const groupedPaneEl = content.querySelector('#groupedTab');
    const allPaneEl = content.querySelector('#allTab');

    // Reset active state
    content.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    content.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

    if (isGrouped) {
        for (const [groupName, lights] of Object.entries(lightList)) {
            const section = document.createElement('div');
            section.className = 'room-section';

            const header = document.createElement('h3');
            header.textContent = `🏠 ${groupName}`;
            section.appendChild(header);

            lights.forEach(light => section.appendChild(renderCheckbox(light)));
            groupedList.appendChild(section);
        }

        // Also build a flat "All" list from grouped:
        const seen = new Set();
        const flatAll = [];
        for (const lights of Object.values(lightList)) {
            lights.forEach(l => {
                if (!seen.has(l.id)) { seen.add(l.id); flatAll.push(l); }
            });
        }
        flatAll.forEach(light => allList.appendChild(renderCheckbox(light)));

        // Default to Grouped tab
        content.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        content.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        content.querySelector('.tab-btn[data-tab="grouped"]')?.classList.add('active');
        groupedBtn?.classList.add('active');
        groupedPaneEl?.classList.add('active');
    } else {
        lightList.forEach(light => allList.appendChild(renderCheckbox(light)));

        // Default to All tab
        content.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        content.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        content.querySelector('.tab-btn[data-tab="all"]')?.classList.add('active');
        allBtn?.classList.add('active');
        allPaneEl?.classList.add('active');
    }

    // Wire action buttons
    if (confirmBtn) {
        confirmBtn.textContent = options.confirmText || '✅ OK';
        confirmBtn.onclick = () => {
            const checked = [...content.querySelectorAll('input[type="checkbox"]:checked')]
                .map(cb => cb.value)
                .filter((v, i, a) => a.indexOf(v) === i)
                .sort((a, b) => Number(a) - Number(b));

            const idsStr = checked.join(', ');
            const idsField = document.getElementById('lightIds');
            if (idsField) idsField.value = idsStr;

            ipcRenderer.send('set-light-ids', checked);
            info(`✅ Selected Light IDs: ${idsStr}`);

            // Persist selection to config.json
            try {
                const cfg = fs.existsSync(getConfigPath())
                    ? JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
                    : {};
                cfg.LIGHT_ID = idsStr;
                fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 4));
                info('💾 Saved selected light IDs to config.json');
            } catch (err) {
                error(`❌ Failed to update config: ${err.message}`);
            }

            modal.style.display = 'none';
        };
    }

    if (cancelBtn) {
        cancelBtn.onclick = () => {
            modal.style.display = 'none';
        };
    }

    // Finally show the modal (ensure selection UI is visible)
    content.querySelectorAll('.tab-btn, .tab-pane').forEach(el => el.style.display = '');
    // keep legacy list hidden
    legacyList.style.display = 'none';
    modal.style.display = 'flex';
}

// Toggle visibility using the provider dropdown (#provider)
function applyProviderVisibility() {
    const providerEl = document.getElementById('provider');
    const provider = (providerEl?.value || 'hue').toLowerCase();

    const isHue = provider === 'hue';
    const isYeelight = provider === 'yeelight';

    const toggle = (el, show) => { if (el) el.style.display = show ? '' : 'none'; };
    const toggleField = (inputId, show) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        const wrapper = input.closest('.toggle-secret') || input.parentElement;
        if (wrapper) wrapper.style.display = show ? '' : 'none';
        const maybeLabel = wrapper?.previousElementSibling;
        if (maybeLabel && maybeLabel.tagName === 'LABEL') {
            maybeLabel.style.display = show ? '' : 'none';
        }
    };

    // Hue-only UI
    toggle(document.getElementById('autoDetectBridge'), isHue);
    toggleField('bridgeIP', isHue);
    toggleField('apiKey', isHue);
    toggle(document.getElementById('reselectLightsBtn'), isHue);

    // Yeelight-Block
    toggle(document.getElementById('yeelightBlock'), isYeelight);

    // Light-IDs UX
    const lightIdsInput = document.getElementById('lightIds');
    if (lightIdsInput) {
        if (isHue) {
            lightIdsInput.placeholder = 'e.g. 1,2,3';
            lightIdsInput.title = 'Comma-separated list of Hue light IDs.';
        } else if (isYeelight) {
            lightIdsInput.placeholder = 'e.g. 1,2';
            lightIdsInput.title = 'Comma-separated indices of Yeelight devices (order of YEELIGHT_DEVICES, starting at 1).';
        }
    }
}

// Load stuff on page load
function initializeApp() {
    document.querySelectorAll('.toggle-secret').forEach(wrapper => {
        const input = wrapper.querySelector('.secret-input');
        const btn = wrapper.querySelector('.reveal-btn');
        const img = btn.querySelector('img');

        btn.addEventListener('click', () => {
            const visible = input.classList.toggle('visible');
            img.src = visible ? 'img/eye-password-show.svg' : 'img/eye-password-hide.svg';
        });
    });

    // Load and fill config
    let config = {};
    if (fs.existsSync(getConfigPath())) {
        try {
            config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

            // Load log to HTML file and Debug mode
            setHtmlLogEnabled(config.HTML_LOG);
            setDebugMode(config.DEBUG_MODE);
            if (config.LIVE_LOG_LINES !== undefined) {
                setMaxSessionLines(config.LIVE_LOG_LINES);
            }

            // Set light IDs from config
            lightIDs = config.LIGHT_ID.split(',').map(id => id.trim());
            lightIDsReady = true;
            ipcRenderer.send('set-light-ids', lightIDs);

            document.getElementById('bridgeIP').value = config.BRIDGE_IP || '';
            debug('Bridge IP field value:', document.getElementById('bridgeIP').value);
            document.getElementById('apiKey').value = config.API_KEY || '';
            debug('API-Key field value:', document.getElementById('apiKey').value);
            document.getElementById('serverHost').value = config.SERVER_HOST || '127.0.0.1';
            debug('serverHost field value:', document.getElementById('serverHost').value);
            document.getElementById('serverPort').value = config.SERVER_PORT || 8080;
            debug('serverPort field value:', document.getElementById('serverPort').value);
            document.getElementById('lightIds').value = config.LIGHT_ID || '';
            debug('LightIDs field value:', document.getElementById('lightIds').value);
            document.getElementById('showTimer').value = config.SHOW_BOMB_TIMER ? 'true' : 'false';
            debug('showTimer field value:', document.getElementById('showTimer').value);
            document.getElementById('htmlLog').value = config.HTML_LOG ? 'true' : 'false';
            debug('htmlLog field value:', document.getElementById('htmlLog').value);
            document.getElementById('debugMode').value = config.DEBUG_MODE ? 'true' : 'false';
            debug('debugMode field value:', document.getElementById('debugMode').value);
            document.getElementById('liveLogNumber').value = config.LIVE_LOG_LINES || 1000;
            debug('liveLogNumber field value:', document.getElementById('liveLogNumber').value);
            document.getElementById('provider').value = (config.PROVIDER || 'hue');
            debug('provider field value:', document.getElementById('provider').value);
            document.getElementById('yeelightDiscovery').value = String(config.YEELIGHT_DISCOVERY === true);
            debug('yeelightDiscovery field value:', document.getElementById('yeelightDiscovery').value);
            document.getElementById('yeelightDevices').value = config.YEELIGHT_DEVICES || '';

            // Discord settings
            const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };

            setVal('discordShowElapsed', config.DISCORD_SHOW_ELAPSED === true);
            setVal('discordUseParty', config.DISCORD_USE_PARTY === true);
            setVal('discordResetOnRound', config.DISCORD_RESET_ON_ROUND === true);
            document.getElementById('discordUpdateRate').value = config.DISCORD_UPDATE_RATE ?? 15;

            const ev = config.DISCORD_EVENTS || {};
            document.getElementById('rpcEvt_menu').checked = ev.menu !== false;
            document.getElementById('rpcEvt_roundStart').checked = ev.roundStart !== false;
            document.getElementById('rpcEvt_bombPlanted').checked = ev.bombPlanted !== false;
            document.getElementById('rpcEvt_bombDefused').checked = ev.bombDefused !== false;
            document.getElementById('rpcEvt_bombExploded').checked = ev.bombExploded !== false;
            document.getElementById('rpcEvt_roundWon').checked = ev.roundWon !== false;
            document.getElementById('rpcEvt_roundLost').checked = ev.roundLost !== false;

            // Discord RPC Toggle (select)
            const rpcToggle = document.getElementById('discordRpcToggle');
            if (rpcToggle) {
                rpcToggle.value = String(config.DISCORD_RPC_ENABLED === true);
                debug('discordRpcToggle field value:', rpcToggle.value);
            }

            applyProviderVisibility();
            info("🔧 Loaded config.json");

        } catch (err) {
            error(`❌ Failed to parse config.json: ${err.message}`);
        }
    } else {
        console.warn("⚠️ config.json not found. Please fill out the form and save.");
    }

    // Link Provider-UI
    document.getElementById('provider')?.addEventListener('change', applyProviderVisibility);
    applyProviderVisibility();

    const debugSelect = document.getElementById('debugMode');
    if (config.DEBUG_MODE !== undefined) {
        debugSelect.value = config.DEBUG_MODE.toString();
        setDebugMode(config.DEBUG_MODE);
    } else {
        // default fallback
        setDebugMode(false);
    }
    debugSelect.addEventListener('change', (e) => {
        const enabled = e.target.value === 'true';
        setDebugMode(enabled);
        debug('🐞 Debug mode toggled:', enabled);
    });

    // Bind events
    document.getElementById('saveConfig').addEventListener('click', () => {
        const config = {
            PROVIDER: document.getElementById('provider').value || 'hue',
            BRIDGE_IP: document.getElementById('bridgeIP').value,
            API_KEY: document.getElementById('apiKey').value,
            SERVER_HOST: document.getElementById('serverHost').value || '127.0.0.1',
            SERVER_PORT: parseInt(document.getElementById('serverPort').value) || 8080,
            LIGHT_ID: document.getElementById('lightIds').value,
            SHOW_BOMB_TIMER: document.getElementById('showTimer').value === 'true',
            DISCORD_RPC_ENABLED: document.getElementById('discordRpcToggle')?.value === 'true',
            HTML_LOG: document.getElementById('htmlLog').value === 'true',
            DEBUG_MODE: document.getElementById('debugMode').value === 'true',
            LIVE_LOG_LINES: document.getElementById('liveLogNumber').value || 1000,
            YEELIGHT_DISCOVERY: document.getElementById('yeelightDiscovery').value === 'true',
            YEELIGHT_DEVICES: document.getElementById('yeelightDevices').value || '',
            DISCORD_SHOW_ELAPSED: document.getElementById('discordShowElapsed').value === 'true',
            DISCORD_USE_PARTY: document.getElementById('discordUseParty').value === 'true',
            DISCORD_RESET_ON_ROUND: document.getElementById('discordResetOnRound').value === 'true',
            DISCORD_UPDATE_RATE: parseInt(document.getElementById('discordUpdateRate').value) || 15,
            DISCORD_EVENTS: {
                menu: document.getElementById('rpcEvt_menu').checked,
                roundStart: document.getElementById('rpcEvt_roundStart').checked,
                bombPlanted: document.getElementById('rpcEvt_bombPlanted').checked,
                bombDefused: document.getElementById('rpcEvt_bombDefused').checked,
                bombExploded: document.getElementById('rpcEvt_bombExploded')?.checked ?? true,
                roundWon: document.getElementById('rpcEvt_roundWon').checked,
                roundLost: document.getElementById('rpcEvt_roundLost').checked
            },
        };

        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 4));
        info("✅ Config saved.");

        // Reload fields
        reloadSettings();
        info("🔁 Reloaded config fields after saving.");
    });

    // Separate save button for Discord section
    const saveDiscordBtn = document.getElementById('saveDiscordConfig');
    if (saveDiscordBtn) {
        saveDiscordBtn.addEventListener('click', () => {
            info("💾 Saving Discord configuration...");

            const config = fs.existsSync(getConfigPath())
                ? JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
                : {};

            // Update only Discord-related fields
            config.DISCORD_RPC_ENABLED = document.getElementById('discordRpcToggle')?.value === 'true';
            config.DISCORD_SHOW_ELAPSED = document.getElementById('discordShowElapsed').value === 'true';
            config.DISCORD_USE_PARTY = document.getElementById('discordUseParty').value === 'true';
            config.DISCORD_RESET_ON_ROUND = document.getElementById('discordResetOnRound').value === 'true';
            config.DISCORD_UPDATE_RATE = parseInt(document.getElementById('discordUpdateRate').value) || 15;

            config.DISCORD_EVENTS = {
                menu: document.getElementById('rpcEvt_menu').checked,
                roundStart: document.getElementById('rpcEvt_roundStart').checked,
                bombPlanted: document.getElementById('rpcEvt_bombPlanted').checked,
                bombDefused: document.getElementById('rpcEvt_bombDefused').checked,
                bombExploded: document.getElementById('rpcEvt_bombExploded')?.checked ?? true,
                roundWon: document.getElementById('rpcEvt_roundWon').checked,
                roundLost: document.getElementById('rpcEvt_roundLost').checked
            };

            // Write full config back to disk
            fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 4));
            info("✅ Discord config saved.");

            // Refresh UI to reflect changes
            reloadSettings();
        });
    }

    document.getElementById('startScript').addEventListener('click', async () => {
        if (!lightIDsReady) {
            warn("⚠️ lightIDs not ready, cannot start script.");
            return;
        }

        if (isTestingColor) {
            warn("🚫 Cannot start script while color test is active.");
            return;
        }

        if (scriptIsRunning) {
            warn("⚠️ Script already running..");
            return;
        }

        if (scriptIsStarting) {
            warn("⚠️ Script is currently starting.");
            return;
        }

        scriptIsStarting = true;
        setScriptControlsEnabled(false);

        info("▶️ Starting bomb script...");
        const success = await startScript();

        if (document.getElementById('discordRpcToggle')?.value === 'true') {
            ipcRenderer.send('rpc-toggle', true);
        }

        scriptIsStarting = false;
        scriptIsRunning = !!success;
        ipcRenderer.send('set-script-running', scriptIsRunning);
        updateLogButtonVisibility();
        setScriptControlsEnabled(true);

        if (!success) {
            warn("❌ Script failed to start.");
        }
    });

    document.getElementById('stopScript').addEventListener('click', async () => {
        if (scriptIsStarting) {
            warn("⚠️ Script is still starting. Please wait...");
            return;
        }

        if (!scriptIsRunning) {
            warn("⚠️ Script is not currently running.");
            return;
        }

        if (scriptIsStopping) {
            warn("⏳ Script is already stopping...");
            return;
        }

        scriptIsStopping = true;
        setScriptControlsEnabled(false);
        info("🛑 Stopping script...");

        ipcRenderer.send('rpc-toggle', false);
        
        await stopScript(getHueAPI());

        scriptIsRunning = false;
        scriptIsStopping = false;
        ipcRenderer.send('set-script-running', false);
        updateLogButtonVisibility();
        setScriptControlsEnabled(true);
        info("✅ Script stopped!");
    });

    document.getElementById('reloadConfig').addEventListener('click', async () => {
        info("🔁 Reloading Settings...");
        // Reload UI + Files
        reloadSettings();

        try {
            const { reloadRuntimeConfig, startScript, stopScript, isScriptRunning, getHueAPI } = require('./logic.js');

            if (isScriptRunning()) {
                const fs = require('fs');
                const { getConfigPath } = require('./paths');
                const fresh = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

                const criticalChanged =
                    true;

                if (criticalChanged) {
                    info("♻️ Applying config to running script via safe restart...");
                    setScriptControlsEnabled(false);
                    await stopScript(getHueAPI());
                    const ok = await startScript();
                    setScriptControlsEnabled(true);
                    if (!ok) warn("⚠️ Restart after reload failed.");
                } else {
                    await reloadRuntimeConfig();
                }
            } else {
                await require('./logic.js').reloadRuntimeConfig();
            }
        } catch (e) {
            error(`❌ Failed to apply reload at runtime: ${e.message}`);
        }

        info("✅ Reload completed and applied.");
    });

    document.getElementById('restartScript').addEventListener('click', async () => {
        if (isTestingColor) { warn("🚫 Cannot restart script while color test is active."); return; }
        if (scriptIsStarting || scriptIsStopping) { warn("⚠️ Script is busy. Please wait..."); return; }

        setScriptControlsEnabled(false);
        info("🔁 Restarting Script...");

        const wantRpc = document.getElementById('discordRpcToggle')?.value === 'true';
        if (wantRpc) ipcRenderer.send('rpc-toggle', false);

        scriptIsStopping = true;
        await stopScript(getHueAPI());
        scriptIsStopping = false;
        scriptIsRunning = false;

        await new Promise(r => setTimeout(r, 200));

        scriptIsStarting = true;
        const success = await startScript();
        scriptIsStarting = false;
        scriptIsRunning = !!success;

        if (success && wantRpc) {
            setTimeout(() => ipcRenderer.send('rpc-toggle', true), 150);
        }

        ipcRenderer.send('set-script-running', scriptIsRunning);
        updateLogButtonVisibility();
        setScriptControlsEnabled(true);
    });

    document.getElementById('openLogBtn').addEventListener('click', () => {
        const serverHost = document.getElementById('serverHost').value || '127.0.0.1';
        const serverPort = document.getElementById('serverPort').value || '8080';
        const url = `http://${serverHost}:${serverPort}/log`;
        require('electron').shell.openExternal(url);
    });

    document.getElementById('openDocBtn').addEventListener('click', () => {
        const serverHost = document.getElementById('serverHost').value || '127.0.0.1';
        const serverPort = document.getElementById('serverPort').value || '8080';
        const url = `http://${serverHost}:${serverPort}/docs/index.html`;
        require('electron').shell.openExternal(url);
    });

    document.getElementById('openConfig').addEventListener('click', () => {
        const folderPath = path.dirname(getConfigPath());
        ipcRenderer.invoke('open-folder', folderPath);
    });

    document.getElementById('autoDetectBridge').addEventListener('click', async () => {
        const spinnerOverlay = document.getElementById('globalSpinner');
        const statusText = document.getElementById('spinnerStatusText');

        spinnerOverlay.style.display = 'flex';
        statusText.textContent = '';

        let delayedMessageTimeout = setTimeout(() => {
            statusText.textContent = '⏳ Searching for the Hue Bridge, please ensure it’s on and connected to the same network.';
        }, 2500);

        try {
            const bridgeIP = await HueBridgeHelper.discoverBridgeIP();
            clearTimeout(delayedMessageTimeout);
            statusText.textContent = '';

            document.getElementById('bridgeIP').value = bridgeIP;
            info(`🌐 Hue Bridge found: ${bridgeIP}`);

            const confirmed = await showMessageModal(
                "Please press the link button on your Hue Bridge, then click OK to continue.",
                {
                    title: "Press the Hue Bridge Button",
                    confirmText: "✅ OK",
                    showCancel: true,
                    useWarningBox: false
                }
            );

            if (!confirmed) {
                info("User canceled bridge authorization.");
                return;
            }

            const apiKey = await HueBridgeHelper.createUser(bridgeIP);
            document.getElementById('apiKey').value = apiKey;
            info(`🔑 API Key created.`);

            const config = fs.existsSync(getConfigPath())
                ? JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
                : {};

            config.BRIDGE_IP = bridgeIP;
            config.API_KEY = apiKey;

            fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 4));
            info("💾 Saved BRIDGE_IP and API_KEY to config.json");

            reloadSettings();

            const updatedConfig = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
            const groupedLights = await fetchGroupedLights(updatedConfig.BRIDGE_IP, updatedConfig.API_KEY);

            ipcRenderer.send('set-hue-api', `http://${updatedConfig.BRIDGE_IP}/api/${updatedConfig.API_KEY}`);

            showLightSelectionModal(groupedLights, {
                title: "💡 Select Your Hue Lights",
                callout: "Choose which lights you want to control with CS2HUE. You can always update this later."
            });

        } catch (err) {
            clearTimeout(delayedMessageTimeout);
            statusText.textContent = '';
            error(`❌ Hue Bridge setup failed: ${err.message}`);
            await showMessageModal(`Error: ${err.message}`, {
                title: "Hue Bridge Error",
                confirmText: "❌ Close",
                showCancel: false,
                useWarningBox: true,
                hideMessage: false
            });
        } finally {
            clearTimeout(delayedMessageTimeout);
            statusText.textContent = '';
            spinnerOverlay.style.display = 'none';
        }
    });

    // Bind event
    document.getElementById('reselectLightsBtn').addEventListener('click', async () => {
        const ip = document.getElementById('bridgeIP')?.value?.trim();
        const apiKey = document.getElementById('apiKey')?.value?.trim();

        const warningBox = document.getElementById('modalWarning');
        const modal = document.getElementById('lightSelectionModal');
        const confirmBtn = document.getElementById('confirmLightSelection');
        const cancelBtn = document.getElementById('cancelLightSelection');
        const spinnerOverlay = document.getElementById('globalSpinner');

        warningBox.style.display = 'none';
        warningBox.textContent = '';
        confirmBtn.textContent = '✅ OK';

        if (!ip || !apiKey) {
            warningBox.textContent = '⚠️ Please set both BRIDGE_IP and API_KEY before selecting lights.';
            warningBox.style.display = 'block';
            confirmBtn.textContent = '❌ Close';
            cancelBtn.style.display = 'none';
            confirmBtn.onclick = () => {
                modal.style.display = 'none';
            };
            modal.style.display = 'flex';
            return;
        }

        spinnerOverlay.style.display = 'flex';

        try {
            const [groupedLights, allLights] = await Promise.all([
                fetchGroupedLights(ip, apiKey),
                HueBridgeHelper.fetchLightIDsWithNames(ip, apiKey),
            ]);

            spinnerOverlay.style.display = 'none';
            resetModalHeader('💡 Select Your Hue Lights');
            populateLightsUI(groupedLights, allLights);
            modal.style.display = 'flex';

            // ADD event listeners after UI is ready
            confirmBtn.onclick = () => {
                const checked = [...document.querySelectorAll('.modal-checkbox input:checked')]
                    .map(cb => cb.value)
                    .filter((v, i, arr) => arr.indexOf(v) === i)
                    .sort((a, b) => Number(a) - Number(b));

                document.getElementById('lightIds').value = checked.join(', ');
                ipcRenderer.send('set-light-ids', checked);
                modal.style.display = 'none';
            };

            cancelBtn.onclick = () => {
                modal.style.display = 'none';
            };

            modal.style.display = 'flex';
        } catch (err) {
            spinnerOverlay.style.display = 'none';
            warningBox.textContent = `❌ ${err.message}`;
            warningBox.style.display = 'block';
            confirmBtn.textContent = '❌ Close';
            cancelBtn.style.display = 'none';
            confirmBtn.onclick = () => {
                modal.style.display = 'none';
            };
            modal.style.display = 'flex';
        }
    });

    updateLogButtonVisibility();

    scriptIsRunning = isScriptRunning();
    updateLogButtonVisibility();
}

function pointInTriangle(p, a, b, c) {
    const v0 = [c[0] - a[0], c[1] - a[1]];
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [p[0] - a[0], p[1] - a[1]];

    const dot00 = v0[0] * v0[0] + v0[1] * v0[1];
    const dot01 = v0[0] * v1[0] + v0[1] * v1[1];
    const dot02 = v0[0] * v2[0] + v0[1] * v2[1];
    const dot11 = v1[0] * v1[0] + v1[1] * v1[1];
    const dot12 = v1[0] * v2[0] + v1[1] * v2[1];

    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return u >= 0 && v >= 0 && (u + v < 1);
}

function closestPointOnLine(a, b, p) {
    const ap = [p[0] - a[0], p[1] - a[1]];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const ab2 = ab[0] * ab[0] + ab[1] * ab[1];
    const ap_ab = ap[0] * ab[0] + ap[1] * ab[1];
    const t = Math.max(0, Math.min(1, ap_ab / ab2));
    return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

function closestInGamut(p, gamut) {
    const a = gamut.red;
    const b = gamut.green;
    const c = gamut.blue;

    const pAB = closestPointOnLine(a, b, p);
    const pAC = closestPointOnLine(a, c, p);
    const pBC = closestPointOnLine(b, c, p);

    const d = (p1, p2) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);

    const distances = [
        { pt: pAB, dist: d(p, pAB) },
        { pt: pAC, dist: d(p, pAC) },
        { pt: pBC, dist: d(p, pBC) }
    ];

    distances.sort((a, b) => a.dist - b.dist);
    return distances[0].pt;
}

function rgbToHex(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3) return "#cccccc";

    return (
        "#" +
        rgb
            .map(x => {
                const val = Number(x);
                if (isNaN(val)) return "cc";
                return Math.min(255, Math.max(0, Math.round(val)))
                    .toString(16)
                    .padStart(2, "0");
            })
            .join("")
    );
}

function hexToRgb(hex) {
    const bigint = parseInt(hex.slice(1), 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToXy([r, g, b]) {
    // Normalize
    r /= 255;
    g /= 255;
    b /= 255;

    // Gamma correction
    r = r > 0.04045 ? ((r + 0.055) / 1.055) ** 2.4 : r / 12.92;
    g = g > 0.04045 ? ((g + 0.055) / 1.055) ** 2.4 : g / 12.92;
    b = b > 0.04045 ? ((b + 0.055) / 1.055) ** 2.4 : b / 12.92;

    // Convert to XYZ (Wide RGB D65)
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    let cx = X / (X + Y + Z);
    let cy = Y / (X + Y + Z);

    // Fallback
    if (isNaN(cx)) cx = 0;
    if (isNaN(cy)) cy = 0;

    let xy = [parseFloat(cx.toFixed(4)), parseFloat(cy.toFixed(4))];

    // Clamp to Hue Gamut C
    const GAMUT_C = {
        red: [0.701, 0.299],
        green: [0.172, 0.747],
        blue: [0.135, 0.039]
    };

    if (!pointInTriangle(xy, GAMUT_C.red, GAMUT_C.green, GAMUT_C.blue)) {
        xy = closestInGamut(xy, GAMUT_C);
    }

    return xy;
}

function xyToRgb(xy, bri = 254) {
    const fallback = [200, 200, 200];
    if (!xy) return fallback;

    if (typeof xy === 'string') {
        try {
            const parsed = JSON.parse(xy);
            if (!Array.isArray(parsed) || parsed.length !== 2) return fallback;
            xy = parsed;
        } catch {
            return fallback;
        }
    }

    if (!Array.isArray(xy) || xy.length !== 2 || isNaN(xy[0]) || isNaN(xy[1])) {
        return fallback;
    }

    const [x, y] = xy.map(Number);
    const z = 1.0 - x - y;

    const Y = 1.0;
    const X = (Y / y) * x;
    const Z = (Y / y) * z;

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;

    // Gamma correction
    r = r <= 0.0031308 ? 12.92 * r : 1.055 * (r ** (1 / 2.4)) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * (g ** (1 / 2.4)) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * (b ** (1 / 2.4)) - 0.055;

    // Apply brightness after color conversion
    const brightnessScale = bri / 254;

    let rFinal = Math.min(255, Math.max(0, r * 255));
    let gFinal = Math.min(255, Math.max(0, g * 255));
    let bFinal = Math.min(255, Math.max(0, b * 255));

    rFinal = rFinal * brightnessScale;
    gFinal = gFinal * brightnessScale;
    bFinal = bFinal * brightnessScale;

    return [
        Math.round(rFinal),
        Math.round(gFinal),
        Math.round(bFinal)
    ];
}

function getBrightnessFromRgb([r, g, b]) {
    return Math.round(Math.max(r, g, b) / 255 * 254);
}

// Load and show colors from colors.json
let isTestingColor = false;
let testedColorName = null;
let previousStateCache = {};

function loadColors() {
    const colorsContainer = document.getElementById('colorsDisplay');
    colorsContainer.innerHTML = '';

    const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));

    let needsMigration = false;

    Object.entries(colors).forEach(([name, color]) => {
        const xy = color.xy;

        let parsed = null;
        if (Array.isArray(xy) && xy.length === 2) {
            parsed = xy;
        } else if (typeof xy === 'string') {
            try {
                const temp = JSON.parse(xy);
                if (Array.isArray(temp) && temp.length === 2) {
                    parsed = temp;
                }
            } catch {
                warn("⚠️ Migration of XY values failed.")
            }
        }

        if (parsed) {
            color.x = parsed[0];
            color.y = parsed[1];
            delete color.xy;
            needsMigration = true;
        }
    });

    if (needsMigration) {
        fs.writeFileSync(getColorsPath(), JSON.stringify(colors, null, 4));
        info("✅ Migrated old xy format to x/y and saved to colors.json");
    }

    const colorKeys = Object.keys(colors);

    for (const name of colorKeys) {
        const color = colors[name];

        if (!('enabled' in color)) {
            color.enabled = true;
        }

        const wrapper = document.createElement('div');
        wrapper.classList.add('color-item');

        let rgb = [200, 200, 200];
        const bri = typeof color.bri === 'number' ? color.bri : 254;

        if (typeof color.x === 'number' && typeof color.y === 'number') {
            try {
                const xy = [color.x, color.y];
                rgb = xyToRgb(xy, bri);

                // Override hex ONLY if xy+brightness exactly matches original RGB color
                if (color.bri === 254 && color.x === 0.6401 && color.y === 0.33) {
                    rgb = [255, 0, 0];
                }
            } catch {
                warn(`⚠️ Failed to convert xy for ${name}`);
            }
        }
        const hex = rgbToHex(rgb);
        debug(`🔍 ${name}: XY [${color.x}, ${color.y}] @ bri ${bri} → ${hex}`);

        const label = document.createElement('strong');
        label.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        wrapper.appendChild(label);

        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.value = hex;
        colorPicker.style.width = '100%';
        colorPicker.style.margin = '10px 0';
        colorPicker.dataset.name = name;
        wrapper.appendChild(colorPicker);

        const briLabel = document.createElement('label');
        briLabel.textContent = 'Brightness (bri):';
        wrapper.appendChild(briLabel);

        const briInput = document.createElement('input');
        briInput.type = 'number';
        briInput.min = 1;
        briInput.max = 254;
        briInput.value = color.bri ?? '';
        briInput.dataset.name = name;
        briInput.dataset.key = 'bri';
        wrapper.appendChild(briInput);

        const xyLabel = document.createElement('label');
        xyLabel.textContent = 'XY:';
        wrapper.appendChild(xyLabel);

        const xInput = document.createElement('input');
        xInput.type = 'number';
        xInput.step = '0.0001';
        xInput.min = 0;
        xInput.max = 1;
        xInput.placeholder = 'x';
        xInput.value = typeof color.x === 'number' ? color.x : '';
        xInput.dataset.name = name;
        xInput.dataset.key = 'x';
        wrapper.appendChild(xInput);

        const yInput = document.createElement('input');
        yInput.type = 'number';
        yInput.step = '0.0001';
        yInput.min = 0;
        yInput.max = 1;
        yInput.placeholder = 'y';
        yInput.value = typeof color.y === 'number' ? color.y : '';
        yInput.dataset.name = name;
        yInput.dataset.key = 'y';
        wrapper.appendChild(yInput);

        const ctLabel = document.createElement('label');
        ctLabel.textContent = 'Color Temp (ct):';
        wrapper.appendChild(ctLabel);

        const ctInput = document.createElement('input');
        ctInput.type = 'number';
        ctInput.min = 153;
        ctInput.max = 500;
        ctInput.value = color.ct ?? '';
        ctInput.dataset.name = name;
        ctInput.dataset.key = 'ct';
        wrapper.appendChild(ctInput);

        const useCtLabel = document.createElement('label');
        useCtLabel.style.display = "flex";
        useCtLabel.style.alignItems = "center";
        useCtLabel.style.gap = "6px";

        const toggleContainer = document.createElement('div');
        toggleContainer.className = 'toggle-container';

        // Left side text with icon
        const toggleText = document.createElement('span');
        toggleText.className = 'toggle-text';
        toggleText.textContent = color.useCt ? '🌡️ CT' : '🎨 XY';

        // Actual toggle switch container
        const toggleSwitch = document.createElement('label');
        toggleSwitch.className = 'toggle-switch';

        // Checkbox input
        const useCtCheckbox = document.createElement('input');
        useCtCheckbox.type = 'checkbox';
        useCtCheckbox.dataset.name = name;
        useCtCheckbox.dataset.key = 'useCt';
        useCtCheckbox.checked = color.useCt === true;

        // Slider span
        const sliderSpan = document.createElement('span');
        sliderSpan.className = 'toggle-slider';

        // Put checkbox and slider inside label
        toggleSwitch.appendChild(useCtCheckbox);
        toggleSwitch.appendChild(sliderSpan);

        const toggleWrapper = document.createElement('span');
        toggleWrapper.className = 'toggle-wrapper';
        toggleWrapper.appendChild(toggleText);
        toggleWrapper.appendChild(toggleSwitch);

        toggleContainer.appendChild(toggleWrapper);
        wrapper.appendChild(toggleContainer);

        // Enable/disable logic
        ctInput.disabled = !useCtCheckbox.checked;
        xInput.disabled = yInput.disabled = useCtCheckbox.checked;
        useCtCheckbox.addEventListener('change', () => {
            const useCt = useCtCheckbox.checked;
            ctInput.disabled = !useCt;
            xInput.disabled = yInput.disabled = useCt;
            toggleText.textContent = useCt ? '🌡️ CT' : '🎨 XY';
        });

        colorPicker.addEventListener('input', () => {
            const newRgb = hexToRgb(colorPicker.value);
            const [newX, newY] = rgbToXy(newRgb);
            const newBri = getBrightnessFromRgb(newRgb);

            xInput.value = newX;
            yInput.value = newY;
            briInput.value = newBri;

            color.x = newX;
            color.y = newY;
            color.bri = newBri;
        });

        // Create Wrapper for Enabled Toggle
        const enabledWrapper = document.createElement('div');
        enabledWrapper.className = 'enabled-wrapper';

        wrapper.appendChild(enabledWrapper);

        // "Enabled" toggle
        const enabledToggleContainer = document.createElement('div');
        enabledToggleContainer.className = 'toggle-container';

        const enabledToggleText = document.createElement('span');
        enabledToggleText.className = 'toggle-text';
        enabledToggleText.textContent = color.enabled !== false ? '✅ Enabled' : '🚫 Disabled';

        const enabledToggleSwitch = document.createElement('label');
        enabledToggleSwitch.className = 'toggle-switch';

        const enabledCheckbox = document.createElement('input');
        enabledCheckbox.type = 'checkbox';
        enabledCheckbox.dataset.name = name;
        enabledCheckbox.dataset.key = 'enabled';
        enabledCheckbox.checked = color.enabled !== false;

        const enabledSlider = document.createElement('span');
        enabledSlider.className = 'toggle-slider';

        enabledToggleSwitch.appendChild(enabledCheckbox);
        enabledToggleSwitch.appendChild(enabledSlider);

        const enabledToggleWrapper = document.createElement('span');
        enabledToggleWrapper.className = 'toggle-wrapper';
        enabledToggleWrapper.appendChild(enabledToggleText);
        enabledToggleWrapper.appendChild(enabledToggleSwitch);

        enabledToggleContainer.appendChild(enabledToggleWrapper);

        if (color.enabled === false) {
            // Make sure the enabled checkbox works normally
            enabledCheckbox.disabled = false;

            wrapper.classList.add('disabled');
        }

        // Make toggle live
        enabledCheckbox.addEventListener('change', () => {
            const isEnabled = enabledCheckbox.checked;
            wrapper.classList.toggle('disabled', !isEnabled);

            enabledToggleText.textContent = isEnabled ? '✅ Enabled' : '🚫 Disabled';

            // Disable inner controls
            colorPicker.disabled = !isEnabled;
            briInput.disabled = !isEnabled;
            xInput.disabled = !isEnabled && !useCtCheckbox.checked;
            yInput.disabled = !isEnabled && !useCtCheckbox.checked;
            ctInput.disabled = !isEnabled || !useCtCheckbox.checked;
            useCtCheckbox.disabled = !isEnabled;
        });

        // Test Button
        const testSavedButton = document.createElement('button');
        testSavedButton.textContent = '💾 Test Saved';
        testSavedButton.className = 'oldborder test-color-btn';
        testSavedButton.dataset.name = name;
        wrapper.appendChild(testSavedButton);

        // Test Live View Button
        const testLiveButton = document.createElement('button');
        testLiveButton.textContent = '🎨 Test Live';
        testLiveButton.className = 'oldborder test-live-color-btn';
        testLiveButton.dataset.name = name;
        wrapper.appendChild(testLiveButton);

        // Shared test function
        async function handleColorTest(colorSourceFn) {
            // Load config early so we know the provider even in the Stop case
            if (!fs.existsSync(getConfigPath())) return;
            const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
            const provider = (config.PROVIDER || 'hue').toLowerCase();
            const ids = (config.LIGHT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

            // === STOP CASE (second click on the same color) ===
            if (isTestingColor && testedColorName === name) {
                try {
                    if (provider === 'yeelight') {
                        // Yeelight: restore using the controller via IPC (best effort)
                        if (previousStateCache && typeof previousStateCache === 'object') {
                            for (const id of Object.keys(previousStateCache)) {
                                const st = previousStateCache[id];
                                if (!st) continue;
                                const restoreBody = {};
                                if (typeof st.on === 'boolean') restoreBody.on = st.on;
                                if (typeof st.bri === 'number') restoreBody.bri = st.bri;
                                if (Array.isArray(st.xy)) restoreBody.xy = st.xy;
                                if (typeof st.ct === 'number') { restoreBody.ct = st.ct; restoreBody.useCt = true; }
                                await ipcRenderer.invoke('controller-set-state', { id, body: restoreBody });
                            }
                        }
                    } else {
                        // Hue: use existing restore logic (PUT the previous state back)
                        await restorePreviousLightState();
                    }
                } catch (e) {
                    error(`❌ Failed to restore previous state: ${e.message}`);
                }

                info(`🔙 Stopped testing "${name}"`);
                isTestingColor = false;
                testedColorName = null;
                testSavedButton.textContent = '💾 Test Saved';
                testLiveButton.textContent = '🎨 Test Live';
                ipcRenderer.send('color-test-status', isTestingColor);
                return;
            }

            // Prevent parallel tests
            if (isTestingColor) {
                warn(`⚠️ Already testing "${testedColorName}". Stop that first.`);
                return;
            }

            // Do not allow testing while the main script is running
            if (isScriptRunning()) {
                info("🚫 Cannot test while script is running.");
                return;
            }

            if (ids.length === 0) {
                warn("⚠️ No LIGHT_ID configured.");
                return;
            }

            // Expose light IDs globally (used by other parts of the app)
            lightIDs = ids;
            lightIDsReady = true;
            ipcRenderer.send('set-light-ids', ids);

            // === YEELIGHT PATH ===
            if (provider === 'yeelight') {
                // Snapshot current state (best effort; controller may return minimal info)
                previousStateCache = {};
                for (const id of ids) {
                    try {
                        const state = await ipcRenderer.invoke('controller-get-state', { id });
                        // Fallback if controller returns nothing
                        previousStateCache[id] = state || { on: true, bri: 254 };
                    } catch (err) {
                        error(`❌ Failed to get yeelight state for ${id}: ${err.message}`);
                        return;
                    }
                }

                // Build the desired color/state body from the source function
                const color = await colorSourceFn();
                const body = { on: true, bri: color.bri ?? 200 };
                if (color.useCt && typeof color.ct === 'number') {
                    body.ct = color.ct; body.useCt = true;
                } else if (typeof color.x === 'number' && typeof color.y === 'number') {
                    body.xy = [color.x, color.y];
                }

                // Apply via controller IPC
                for (const id of ids) {
                    try {
                        await ipcRenderer.invoke('controller-set-state', { id, body });
                    } catch (err) {
                        error(`❌ Failed to set yeelight color on ${id}: ${err.message}`);
                    }
                }

                // Update UI/testing state
                isTestingColor = true;
                testedColorName = name;
                testSavedButton.textContent = '⛔ Stop Test';
                testLiveButton.textContent = '⛔ Stop Test';
                ipcRenderer.send('color-test-status', isTestingColor);

                // No periodic watchdog for Yeelight (optional to add later)
                return;
            }

            // === HUE PATH ===
            const hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`;
            ipcRenderer.send('set-hue-api', hueAPI);

            // Hue-only: check for entertainment/sync mode to avoid conflicts
            const inSync = await anyLightInSyncMode(ids, hueAPI);
            if (inSync) {
                info("🚫 One or more lights are in sync/entertainment mode.");
                isTestingColor = false;
                testedColorName = null;
                testSavedButton.textContent = '💾 Test Saved';
                testLiveButton.textContent = '🎨 Test Live';
                ipcRenderer.send('color-test-status', isTestingColor);
                return;
            }

            // Snapshot current Hue state for later restoration
            previousStateCache = {};
            for (const id of ids) {
                try {
                    const res = await fetch(`${hueAPI}/lights/${id}`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const body = await res.json();
                    previousStateCache[id] = body.state;
                } catch (err) {
                    error(`❌ Failed to fetch state for light ${id}: ${err.message}`);
                    return;
                }
            }

            // Build the state payload from the provided color source
            const color = await colorSourceFn();  // Get color dynamically
            const body = { on: true, bri: color.bri ?? 200 };
            if (color.useCt && typeof color.ct === 'number') {
                body.ct = color.ct;
            } else if (typeof color.x === 'number' && typeof color.y === 'number') {
                body.xy = [color.x, color.y];
            }

            // Apply to Hue via REST
            for (const id of ids) {
                try {
                    const response = await fetch(`${hueAPI}/lights/${id}/state`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                } catch (err) {
                    error(`❌ Failed to set color on light ${id}: ${err.message}`);
                }
            }

            // Update UI/testing state and start a simple connectivity watchdog for Hue
            isTestingColor = true;
            testedColorName = name;
            testSavedButton.textContent = '⛔ Stop Test';
            testLiveButton.textContent = '⛔ Stop Test';
            ipcRenderer.send('color-test-status', isTestingColor);

            let watchdogInterval = setInterval(async () => {
                if (!isTestingColor) {
                    clearInterval(watchdogInterval);
                    return;
                }

                try {
                    for (const id of ids) {
                        const res = await fetch(`${hueAPI}/lights/${id}`);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const data = await res.json();
                        if (data.state?.reachable === false) {
                            throw new Error(`Light ${id} not reachable`);
                        }
                    }
                } catch (err) {
                    error(`❌ Lost connection during test: ${err.message}`);
                    await restorePreviousLightState();
                    isTestingColor = false;
                    testedColorName = null;
                    testSavedButton.textContent = '💾 Test Saved';
                    testLiveButton.textContent = '🎨 Test Live';
                    ipcRenderer.send('color-test-status', isTestingColor);
                    clearInterval(watchdogInterval);
                }
            }, 3000);
        }

        // Button Events
        testSavedButton.addEventListener('click', () =>
            handleColorTest(async () => {
                const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));
                return colors[name];
            }, testSavedButton)
        );

        testLiveButton.addEventListener('click', () =>
            handleColorTest(async () => {
                return getLiveColor(name);
            }, testLiveButton)
        );

        enabledWrapper.appendChild(enabledToggleContainer);
        colorsContainer.appendChild(wrapper);
    }

    // Add invisible filler blocks to balance layout
    const columns = 4;
    const remainder = colorKeys.length % columns;
    if (remainder !== 0) {
        const fillers = columns - remainder;
        for (let i = 0; i < fillers; i++) {
            const filler = document.createElement('div');
            filler.classList.add('color-item');
            filler.style.visibility = 'hidden';
            colorsContainer.appendChild(filler);
        }
    }
}

async function restorePreviousLightState() {
    if (!previousStateCache || !fs.existsSync(getConfigPath())) return;

    const config = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    const provider = (config.PROVIDER || 'hue').toLowerCase();
    const ids = (config.LIGHT_ID || '').split(',').map(id => id.trim()).filter(Boolean);

    if (provider === 'yeelight') {
        // Restore via controller (IPC)
        for (const id of ids) {
            const prev = previousStateCache[id];
            if (!prev) continue;
            const body = {};
            if (typeof prev.on === 'boolean') body.on = prev.on;
            if (typeof prev.bri === 'number') body.bri = prev.bri;
            if (Array.isArray(prev.xy)) body.xy = prev.xy;
            if (typeof prev.ct === 'number') { body.ct = prev.ct; body.useCt = true; }
            try {
                await ipcRenderer.invoke('controller-set-state', { id, body });
            } catch (err) {
                error(`❌ Failed to restore Yeelight ${id}: ${err.message}`);
            }
        }
    } else {
        // Hue path
        ipcRenderer.send('set-light-ids', ids);
        const hueAPI = `http://${config.BRIDGE_IP}/api/${config.API_KEY}`;
        for (const id of ids) {
            const prev = previousStateCache[id];
            if (!prev) continue;
            const body = { on: prev.on, bri: prev.bri };
            if (prev.xy) body.xy = prev.xy;
            if (typeof prev.ct === 'number') body.ct = prev.ct;

            try {
                const response = await fetch(`${hueAPI}/lights/${id}/state`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
            } catch (err) {
                error(`❌ Failed to restore light ${id} state: ${err.message}`);
            }
        }
    }

    previousStateCache = {};
}

document.getElementById('saveColors').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#colorsDisplay input');
    const newColors = {};

    inputs.forEach(input => {
        const name = input.dataset.name;
        const key = input.dataset.key;

        if (!newColors[name]) newColors[name] = {};

        if (key === 'enabled') {
            newColors[name][key] = input.checked;
            return;
        }

        if (key === 'useCt') {
            newColors[name][key] = input.checked;
            return;
        }

        switch (key) {
            case 'x':
                newColors[name].x = parseFloat(input.value) || 0.5;
                break;
            case 'y':
                newColors[name].y = parseFloat(input.value) || 0.5;
                break;
            case 'useCt':
                newColors[name].useCt = input.checked;
                break;
            default:
                if (input.value !== '') {
                    newColors[name][key] = parseInt(input.value);
                }
        }
    });

    // Sanitize all color objects
    for (const name in newColors) {
        sanitizeColorObject(newColors[name]);
    }

    const existing = fs.existsSync(getColorsPath())
        ? JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'))
        : {};

    const merged = { ...existing, ...newColors };
    fs.writeFileSync(getColorsPath(), JSON.stringify(merged, null, 4));
    info("✅ Saved and sanitized colors.json");

    // Reload Color Settings
    loadColors();
});

function loadBombSettings() {
    const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));
    const bomb = colors.bomb;
    const stages = bomb?.stages || {};
    const container = document.getElementById('bombStagesGrid');
    container.innerHTML = ''; // Clear grid

    // Initial Bomb Settings Card
    const initialWrapper = document.createElement('div');
    initialWrapper.classList.add('color-item', 'initial-bomb-card');

    const title = document.createElement('strong');
    title.textContent = '💣 Initial Bomb Settings';
    initialWrapper.appendChild(title);

    const initialLabel = document.createElement('label');
    initialLabel.textContent = 'Initial Bomb Time (s)';
    initialWrapper.appendChild(initialLabel);

    const initialInput = document.createElement('input');
    initialInput.type = 'number';
    initialInput.min = 5;
    initialInput.max = 90;
    initialInput.value = bomb?.initialTime || 40;
    initialInput.classList.add('initial-time');
    initialWrapper.appendChild(initialInput);

    const initialSpeedLabel = document.createElement('label');
    initialSpeedLabel.textContent = 'Initial Blink Speed (ms)';
    initialWrapper.appendChild(initialSpeedLabel);

    const initialSpeedInput = document.createElement('input');
    initialSpeedInput.type = 'number';
    initialSpeedInput.min = 0;
    initialSpeedInput.value = bomb?.initialBlinkSpeed ?? '';
    initialSpeedInput.classList.add('initial-speed');
    initialWrapper.appendChild(initialSpeedInput);

    container.appendChild(initialWrapper);

    // 🔁 Sort stages descending by time
    const sortedStages = Object.entries(stages)
        .sort((a, b) => Number(b[0]) - Number(a[0]));

    sortedStages.forEach(([seconds, { bri, speed }]) => {
        const card = document.createElement('div');
        card.className = 'color-item';
        card.dataset.seconds = seconds;

        const title = document.createElement('strong');
        title.textContent = `${seconds}s`;
        card.appendChild(title);

        const briLabel = document.createElement('label');
        briLabel.textContent = 'Brightness';
        card.appendChild(briLabel);

        const briInput = document.createElement('input');
        briInput.type = 'number';
        briInput.min = 1;
        briInput.max = 254;
        briInput.value = bri ?? '';
        briInput.classList.add('bri-input');
        card.appendChild(briInput);

        const speedLabel = document.createElement('label');
        speedLabel.textContent = 'Blink Speed (ms)';
        card.appendChild(speedLabel);

        const speedInput = document.createElement('input');
        speedInput.type = 'number';
        speedInput.min = 0;
        speedInput.value = speed ?? '';
        speedInput.classList.add('speed-input');
        card.appendChild(speedInput);

        container.appendChild(card);
    });

    // ➕ Add filler blocks for grid symmetry
    const stageCount = sortedStages.length;
    const columns = 4;
    const remainder = (stageCount + 1) % columns; // +1 for initial card
    if (remainder !== 0) {
        const fillers = columns - remainder;
        for (let i = 0; i < fillers; i++) {
            const filler = document.createElement('div');
            filler.classList.add('color-item');
            filler.style.visibility = 'hidden';
            container.appendChild(filler);
        }
    }
}

document.getElementById('saveBombSettings').addEventListener('click', () => {
    if (!fs.existsSync(getColorsPath())) return;

    const colors = JSON.parse(fs.readFileSync(getColorsPath(), 'utf-8'));
    if (!colors.bomb) colors.bomb = {};
    if (!colors.bomb.stages) colors.bomb.stages = {};

    const cards = document.querySelectorAll('#bombStagesGrid .color-item');
    const newStages = {};

    cards.forEach(card => {
        const seconds = card.dataset.seconds;
        if (!seconds) return;

        const bri = parseInt(card.querySelector('.bri-input').value);
        const speed = parseInt(card.querySelector('.speed-input').value);

        newStages[seconds] = {
            bri: isNaN(bri) ? undefined : bri,
            speed: isNaN(speed) ? undefined : speed
        };
    });

    // ⏱️ Save initial bomb time
    const initialInput = document.querySelector('.initial-time');
    const initialSpeedInput = document.querySelector('.initial-speed');

    colors.bomb.initialTime = parseInt(initialInput.value) || 40;

    const blinkSpeed = parseInt(initialSpeedInput.value);
    colors.bomb.initialBlinkSpeed = isNaN(blinkSpeed) ? undefined : blinkSpeed;

    // 💾 Save new stages
    colors.bomb.stages = newStages;

    fs.writeFileSync(getColorsPath(), JSON.stringify(colors, null, 4));
    info("✅ Bomb stages and settings saved to colors.json");

    // Reload Bomb Settings
    loadBombSettings();
});

function reloadSettings() {
    const savedConfig = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));

    // Set light IDs from config
    lightIDs = savedConfig.LIGHT_ID.split(',').map(id => id.trim());
    lightIDsReady = true;
    ipcRenderer.send('set-light-ids', lightIDs);

    document.getElementById('bridgeIP').value = savedConfig.BRIDGE_IP || '';
    document.getElementById('apiKey').value = savedConfig.API_KEY || '';
    document.getElementById('serverHost').value = savedConfig.SERVER_HOST || '127.0.0.1';
    document.getElementById('serverPort').value = savedConfig.SERVER_PORT || 8080;
    document.getElementById('lightIds').value = savedConfig.LIGHT_ID || '';
    document.getElementById('showTimer').value = savedConfig.SHOW_BOMB_TIMER ? 'true' : 'false';
    document.getElementById('htmlLog').value = savedConfig.HTML_LOG ? 'true' : 'false';
    document.getElementById('liveLogNumber').value = savedConfig.LIVE_LOG_LINES || 1000;
    document.getElementById('debugMode').value = savedConfig.DEBUG_MODE ? 'true' : 'false';
    document.getElementById('provider').value = (savedConfig.PROVIDER || 'hue');
    document.getElementById('yeelightDiscovery').value = String(savedConfig.YEELIGHT_DISCOVERY === true);
    document.getElementById('yeelightDevices').value = savedConfig.YEELIGHT_DEVICES || '';

    // neu (robust):
    const rpcToggle = document.getElementById('discordRpcToggle');
    if (rpcToggle) {
        rpcToggle.value = String(savedConfig.DISCORD_RPC_ENABLED === true);
    }

    setDebugMode(savedConfig.DEBUG_MODE);
    setHtmlLogEnabled(savedConfig.HTML_LOG);
    if (savedConfig.LIVE_LOG_LINES !== undefined) {
        setMaxSessionLines(savedConfig.LIVE_LOG_LINES);
    }
    loadColors();
    loadBombSettings();
    ipcRenderer.send('set-hue-api', `http://${savedConfig.BRIDGE_IP}/api/${savedConfig.API_KEY}`);
    info("✅ Reload completed.")
}

function updateLogButtonVisibility() {
    const openLogBtn = document.getElementById('openLogBtn');
    const openDocBtn = document.getElementById('openDocBtn');

    if (!openLogBtn) return;
    if (!openDocBtn) return;

    openLogBtn.style.display = scriptIsRunning ? 'inline-block' : 'none';
    openDocBtn.style.display = scriptIsRunning ? 'inline-block' : 'none';
}

async function setupPaths() {
    const isPackaged = await ipcRenderer.invoke('get-is-packaged');
    let basePath;

    if (isPackaged) {
        basePath = await ipcRenderer.invoke('get-user-data-path');
        setBasePath(basePath);

        const defaultConfigPath = path.join(__dirname, 'config.json');
        const defaultColorsPath = path.join(__dirname, 'colors.json');

        if (!fs.existsSync(getConfigPath())) {
            const contents = fs.readFileSync(defaultConfigPath, 'utf-8');
            fs.writeFileSync(getConfigPath(), contents);
            info("✅ Copied default config.json to user path");
        }

        if (!fs.existsSync(getColorsPath())) {
            const contents = fs.readFileSync(defaultColorsPath, 'utf-8');
            fs.writeFileSync(getColorsPath(), contents);
            info("✅ Copied default colors.json to user path");
        }
    } else {
        basePath = path.resolve(__dirname); // dev mode
        setBasePath(basePath);
        debug("🛠️ Dev mode: using local files only, no copying.");
    }

    // Ensure backups directory exists
    const backupDir = getBackupPath();
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
        info("📁 Created backups directory at: " + backupDir);
    }

    debug("📁 ConfigPath: " + getConfigPath());
    debug("📁 ColorsPath: " + getColorsPath());
    debug("📁 BackupPath: " + getBackupPath());

    loadColors();
    loadBombSettings();
}

function setScriptControlsEnabled(enabled) {
    const startBtn = document.getElementById('startScript');
    const stopBtn = document.getElementById('stopScript');
    const restartBtn = document.getElementById('restartScript');

    if (startBtn) startBtn.disabled = !enabled;
    if (stopBtn) stopBtn.disabled = !enabled;
    if (restartBtn) restartBtn.disabled = !enabled;
}

function getLiveColor(name) {
    const getInput = (key) =>
        document.querySelector(`input[data-name="${name}"][data-key="${key}"]`);

    const parseFloatOrUndefined = (val) =>
        val !== '' && !isNaN(val) ? parseFloat(val) : undefined;

    const parseIntOrUndefined = (val) =>
        val !== '' && !isNaN(val) ? parseInt(val, 10) : undefined;

    const x = parseFloatOrUndefined(getInput('x')?.value);
    const y = parseFloatOrUndefined(getInput('y')?.value);
    const bri = parseIntOrUndefined(getInput('bri')?.value);
    const ct = parseIntOrUndefined(getInput('ct')?.value);
    const useCt = getInput('useCt')?.checked === true;

    const color = { bri, useCt };

    if (useCt && ct !== undefined) {
        color.ct = ct;
    } else if (!useCt && x !== undefined && y !== undefined) {
        color.x = x;
        color.y = y;
    } else {
        throw new Error(`❌ Invalid inputs for live color "${name}". Missing required fields.`);
    }

    return color;
}

function showMessageModal(message, options = {}) {
    const modal = document.getElementById('lightSelectionModal');
    if (!modal) {
        // Fallback so the app never crashes if modal markup isn't on the page
        alert(options.title ? `${options.title}\n\n${message}` : message);
        return Promise.resolve(true);
    }

    const content = modal.querySelector('.modal-content') || modal;

    // Title
    const h2 = content.querySelector('h2') || document.createElement('h2');
    if (!h2.parentNode) content.prepend(h2);
    h2.textContent = options.title || 'Info';

    // Create a dedicated message body so we don't need the checkbox list at all
    let msgBody = content.querySelector('#modalMessageBody');
    if (!msgBody) {
        msgBody = document.createElement('div');
        msgBody.id = 'modalMessageBody';
        msgBody.style.marginTop = '8px';
        content.appendChild(msgBody);
    }
    msgBody.innerHTML = ''; // reset

    // Warning box (optional)
    let warningBox = document.getElementById('modalWarning') || content.querySelector('.modal-warning');
    if (!warningBox) {
        warningBox = document.createElement('div');
        warningBox.id = 'modalWarning';
        warningBox.className = 'modal-warning';
        warningBox.style.display = 'none';
        content.insertBefore(warningBox, msgBody);
    }

    // Build content
    if (options.useWarningBox) {
        warningBox.textContent = options.hideMessage ? '' : message;
        warningBox.style.display = options.hideMessage ? 'none' : 'block';
    } else {
        const p = document.createElement('p');
        p.textContent = message;
        msgBody.appendChild(p);
        warningBox.style.display = 'none';
        warningBox.textContent = '';
    }

    // Hide selection UI while message modal is active
    const toHideSelectors = [
        '#lightCheckboxList',
        '#groupedLightsList',
        '#allLightsList',
        '.tab-btn',
        '.tab-pane'
    ];
    const hiddenEls = [];
    toHideSelectors.forEach(sel => {
        content.querySelectorAll(sel).forEach(el => {
            hiddenEls.push([el, el.style.display]); // remember previous display
            el.style.display = 'none';
        });
    });

    // Buttons
    const confirmBtn = content.querySelector('#confirmLightSelection') || document.getElementById('confirmLightSelection');
    const cancelBtn = content.querySelector('#cancelLightSelection') || document.getElementById('cancelLightSelection');

    if (confirmBtn) confirmBtn.textContent = options.confirmText || '✅ OK';
    if (cancelBtn) cancelBtn.style.display = options.showCancel === false ? 'none' : 'inline-block';

    // Show modal and wire up cleanup
    return new Promise(resolve => {
        modal.style.display = 'flex';

        const cleanup = (result) => {
            // Remove message body content
            msgBody.innerHTML = '';
            // Restore hidden elements
            hiddenEls.forEach(([el, prev]) => { el.style.display = prev; });
            // Reset warning box
            warningBox.textContent = '';
            warningBox.style.display = 'none';
            // Hide modal
            modal.style.display = 'none';
            resolve(result);
        };

        if (confirmBtn) confirmBtn.onclick = () => cleanup(true);
        if (cancelBtn) cancelBtn.onclick = () => cleanup(false);
    });
}

// Utility: fetch with timeout support
function fetchWithTimeout(url, options = {}, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(url, { ...options, signal: controller.signal })
            .then(response => {
                clearTimeout(timer);
                resolve(response);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

async function fetchGroupedLights(bridgeIP, apiKey) {
    const groupsUrl = `http://${bridgeIP}/api/${apiKey}/groups`;
    const lightsUrl = `http://${bridgeIP}/api/${apiKey}/lights`;

    const [groupsRes, lightsRes] = await Promise.all([
        fetchWithTimeout(groupsUrl, {}, 3000),
        fetchWithTimeout(lightsUrl, {}, 3000)
    ]);

    if (!groupsRes.ok || !lightsRes.ok)
        throw new Error("Failed to fetch groups or lights.");

    const groupsData = await groupsRes.json();
    const lightsData = await lightsRes.json();

    const grouped = {};

    for (const [groupId, group] of Object.entries(groupsData)) {
        if (group.type !== "Room" && group.type !== "Zone") continue;

        grouped[group.name] = group.lights.map(id => ({
            id,
            name: lightsData[id]?.name || `Light ${id}`
        }));
    }

    return grouped;
}

function populateLightsUI(grouped, all) {
    const groupedList = document.getElementById('groupedLightsList');
    const allList = document.getElementById('allLightsList');

    groupedList.innerHTML = '';
    allList.innerHTML = '';

    // To keep selections in sync between tabs
    const checkboxRegistry = {};

    // Read previously selected IDs from config.json and normalize to strings
    let previouslySelected = new Set();
    try {
        if (fs.existsSync(getConfigPath())) {
            const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
            const list = (cfg.LIGHT_ID || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(String);
            previouslySelected = new Set(list);
        }
    } catch (_) {
        // Fallback to empty set
    }

    function renderCheckbox(light) {
        const { id, name } = light;

        const label = document.createElement('label');
        label.className = 'modal-checkbox';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = id;

        // Pre-select if the id is in previouslySelected
        checkbox.checked = previouslySelected.has(String(id));

        if (!checkboxRegistry[id]) checkboxRegistry[id] = [];
        checkboxRegistry[id].push(checkbox);

        // Sync checkboxes between both tabs
        checkbox.addEventListener('change', () => {
            checkboxRegistry[id].forEach(cb => {
                if (cb !== checkbox) cb.checked = checkbox.checked;
            });
        });

        const checkmark = document.createElement('span');
        checkmark.className = 'modal-checkbox-checkmark';

        const text = document.createElement('span');
        text.textContent = `${name} [ID: ${id}]`;
        text.className = 'modal-checkbox-text';

        label.appendChild(checkbox);
        label.appendChild(checkmark);
        label.appendChild(text);

        return label;
    }

    // === Grouped Tab ===
    for (const [groupName, lights] of Object.entries(grouped)) {
        const section = document.createElement('div');
        section.className = 'room-section';

        const header = document.createElement('h3');
        header.textContent = `🏠 ${groupName}`;
        section.appendChild(header);

        lights.forEach(light => {
            section.appendChild(renderCheckbox(light));
        });

        groupedList.appendChild(section);
    }

    // === All Tab ===
    all.forEach(light => {
        allList.appendChild(renderCheckbox(light));
    });

    // Tab Switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`${btn.dataset.tab}Tab`).classList.add('active');
        });
    });
}

function resetModalHeader(title = '💡 Select Your Hue Lights') {
    const modal = document.getElementById('lightSelectionModal');
    if (!modal) return;
    const content = modal.querySelector('.modal-content') || modal;

    // Title
    let h2 = content.querySelector('h2');
    if (!h2) { h2 = document.createElement('h2'); content.prepend(h2); }
    h2.textContent = title;

    // Clear message box + warning (leftovers from showMessageModal)
    const msgBody = content.querySelector('#modalMessageBody');
    if (msgBody) msgBody.innerHTML = '';
    const warning = content.querySelector('#modalWarning');
    if (warning) { warning.textContent = ''; warning.style.display = 'none'; }

    // Make sure selection UI is visible
    content.querySelectorAll('.tab-btn, .tab-pane, #groupedLightsList, #allLightsList')
        .forEach(el => el.style.display = '');
}