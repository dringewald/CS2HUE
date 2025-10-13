// Discord Rich Presence – fixed assets & fixed client ID
const { info, warn, debug, error } = require('./logger');
const RPC = require("discord-rpc");

const clientId = "1426332240278847558";
let sessionStart = null;
let starting = false;
let reconnectTimer = null;
let cooldownUntil = 0;

// helper
function clearReconnectTimer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

const FIXED_ACTIVITY = {
  details: "Playing CS2 with CS2Hue",
  state: "Lighting your plays",
  largeImageKey: "cs2",
  largeImageText: "Counter-Strike 2",
  smallImageKey: "cs2hue-icon",
  smallImageText: "CS2Hue",
  buttons: [
    { label: "About CS2Hue", url: "https://github.com/dringewald/CS2HUE/blob/main/README.md" },
    { label: "Download CS2Hue", url: "https://github.com/dringewald/cs2hue/releases" }
  ],
};

let rpc = null;
let connected = false;
let keepAliveTimer = null;
let lastActivity = null;

function clearKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function startRPC() {
  if (connected || starting) return;
  if (!clientId) {
    warn("⚠️ [Discord] - [RPC] clientId missing – Presence will not start.");
    return;
  }
  const now = Date.now();
  if (now < cooldownUntil) {
    const waitMs = Math.max(200, cooldownUntil - now);
    debug?.(`[Discord] startRPC delayed by ${waitMs}ms (cooldown)`);
    clearReconnectTimer();
    reconnectTimer = setTimeout(startRPC, waitMs);
    return;
  }

  starting = true;
  clearReconnectTimer();

  try {
    RPC.register(clientId);
    rpc = new RPC.Client({ transport: "ipc" });

    rpc.once("ready", () => {
      starting = false;
      connected = true;
      info("📞 [Discord] - [RPC] Connected to Discord");
      setActivity(FIXED_ACTIVITY);
      clearKeepAlive();
      keepAliveTimer = setInterval(() => {
        if (connected && lastActivity) { try { rpc.setActivity(lastActivity); } catch { } }
      }, 15_000);
    });

    rpc.once("disconnected", () => {
      warn("⚠️ [Discord] - [RPC] Connection disconnected.");
      connected = false;
      starting = false;
      clearKeepAlive();
      safeDestroy();
      cooldownUntil = Date.now() + 1000;
    });

    rpc.on("error", (err) => {
      error("❌ [Discord] - [RPC] Error:", err?.message || err);
    });

    await rpc.login({ clientId });
  } catch (err) {
    starting = false;
    error("❌ [Discord] - [RPC] Login failed:", err?.message || err);
    const backoff = Math.min(20000, (rpc?._retries || 0) * 1500 + 1500);
    rpc && (rpc._retries = (rpc._retries || 0) + 1);
    cooldownUntil = Date.now() + Math.max(1000, backoff);
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      if (!connected) startRPC();
    }, backoff);
  }
}

function safeDestroy() {
  try { rpc?.removeAllListeners?.(); } catch { }
  try { rpc?.clearActivity?.(); } catch { }
  try { rpc?.destroy?.(); } catch { }
  rpc = null;
}

function buildPayload(partial = {}) {
  if (!sessionStart) sessionStart = Math.floor(Date.now() / 1000);

  // Allow callers to override any text fields, and optionally reset the timer.
  const ts = partial.resetTimer ? Math.floor(Date.now() / 1000) : sessionStart;
  if (partial.resetTimer) sessionStart = ts;

  const payload = {
    details: partial.details ?? FIXED_ACTIVITY.details,
    state: partial.state ?? FIXED_ACTIVITY.state,
    startTimestamp: partial.showElapsed === false ? undefined : ts,
    largeImageKey: partial.largeImageKey ?? FIXED_ACTIVITY.largeImageKey,
    largeImageText: partial.largeImageText ?? FIXED_ACTIVITY.largeImageText,
    smallImageKey: partial.smallImageKey ?? FIXED_ACTIVITY.smallImageKey,
    smallImageText: partial.smallImageText ?? FIXED_ACTIVITY.smallImageText,
    buttons: FIXED_ACTIVITY.buttons,
    instance: false,
  };

  // Optional extra “line”: party size renders as “X of Y”
  if (Array.isArray(partial.partySize) && partial.partySize.length === 2) {
    payload.party = { size: [Number(partial.partySize[0]) || 0, Number(partial.partySize[1]) || 0], id: 'cs2hue' };
  }

  return payload;
}

function setActivity(partial = {}) {
  if (!rpc || !connected) return;
  try {
    lastActivity = buildPayload(partial);
    rpc.setActivity(lastActivity);
  } catch (e) {
    warn("⚠️ [Discord] - [RPC] setActivity failed:", e?.message || e);
  }
}

// Public helper: update lines / timer / round info on the fly
function updatePresence(partial = {}) {
  setActivity(partial);
}

function stopRPC() {
  clearKeepAlive();
  clearReconnectTimer();
  cooldownUntil = Date.now() + 800; // kleine Atempause vor neuem Login
  if (!rpc && !connected && !starting) {
    info("📞 [Discord] - [RPC] Presence terminated");
    return;
  }
  try { rpc?.clearActivity?.(); } catch { }
  try { rpc?.destroy?.(); } catch { }
  try { rpc?.removeAllListeners?.(); } catch { }
  rpc = null;
  connected = false;
  starting = false;
  lastActivity = null;
  info("📞 [Discord] - [RPC] Presence terminated");
}


function discordBump() {
  if (connected) {
    if (lastActivity) { try { rpc.setActivity(lastActivity); } catch {} }
    else { setActivity(FIXED_ACTIVITY); }
  } else {
    startRPC();
  }
}

module.exports = { startRPC, stopRPC, discordBump, updatePresence };
