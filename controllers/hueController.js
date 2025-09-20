// controllers/hueController.js
// Hue Bridge controller with normalized state shape and robust fetch handling.

const ensureFetch = () => {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch.bind(globalThis);
    }
    // Fallback for older Node/Electron: dynamically import node-fetch
    return (...args) => import('node-fetch').then(({ default: f }) => f(...args));
};
const fetch = ensureFetch();

class HueController {
    constructor({ bridgeIP, apiKey }) {
        this.apiBase = `http://${bridgeIP}/api/${apiKey}`;
    }

    // Returns raw Hue /lights JSON (object keyed by light id). Keep as-is for compatibility.
    async listLights() {
        const res = await fetch(`${this.apiBase}/lights`);
        if (!res.ok) throw new Error(`Hue API listLights failed: ${res.status}`);
        return res.json();
    }

    // Normalize to the shape your logic/healthcheck expects: { on, bri, xy, ct }
    async getState(id) {
        const res = await fetch(`${this.apiBase}/lights/${id}`);
        if (!res.ok) throw new Error(`Hue API getState failed: ${res.status}`);
        const json = await res.json();
        const s = json?.state || {};
        return {
            on: !!s.on,
            bri: typeof s.bri === 'number' ? s.bri : undefined,
            xy: Array.isArray(s.xy) ? s.xy : undefined,
            ct: typeof s.ct === 'number' ? s.ct : undefined,
        };
    }

    // Pass through whatever body you build (on/bri/xy/ct/etc.)
    async setState(id, body) {
        const res = await fetch(`${this.apiBase}/lights/${id}/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Hue API setState failed: ${res.status}`);
        return res.json();
    }
}

module.exports = HueController;  