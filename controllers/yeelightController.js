// controllers/yeelightController.js
// Yeelight LAN control over TCP (port 55443).
// This controller mirrors the HueController API: listLights, getState, setState.
// It also provides an optional static discover() method to find bulbs on the LAN.

const net = require('net');

class YeelightController {
    /**
     * @param {{devices: {host: string, port: number, name?: string, id?: string, model?: string}[]}} opts
     */
    constructor({ devices = [] } = {}) {
        this.devices = devices;
    }

    /**
     * Return a simple list of lights.
     * IDs are 1-based string indices to align with your existing LIGHT_ID handling.
     */
    async listLights() {
        return this.devices.map((d, i) => ({
            id: String(i + 1),
            name: d.name || `${d.host}:${d.port}`
        }));
    }

    /**
     * Read current state via Yeelight "get_prop".
     * We normalize results to your app's state shape:
     *  - on: boolean
     *  - bri: 1..254 (Hue scale)
     *  - ct: Mirek (optional, if Kelvin is available)
     *  - (xy optional; we can compute from rgb if needed)
     */
    async getState(id) {
        const dev = this.#getDevice(id);
        // Request a compact set of props we can map reliably
        const props = await this.#rpc(dev, "get_prop", [
            "power",        // "on"/"off"
            "bright",       // 1..100
            "ct",           // Kelvin (1700..6500) for CT mode
            "rgb",          // 0xRRGGBB (decimal)
            "color_mode"    // 1=RGB, 2=CT, 3=HSV (not strictly needed, but informative)
        ]);

        const power = String(props[0] ?? "").toLowerCase();
        const bright = Number(props[1] ?? 100);
        const ctKelvin = Number(props[2] ?? 0);
        const rgbInt = Number(props[3] ?? 0);

        const state = {
            on: power === "on",
            bri: this.#clamp(Math.round((isFinite(bright) ? bright : 100) * 254 / 100), 1, 254)
        };

        if (isFinite(ctKelvin) && ctKelvin > 0) {
            // Hue ct is Mirek: 1e6 / Kelvin
            state.ct = Math.round(1000000 / ctKelvin);
        } else if (isFinite(rgbInt) && rgbInt > 0) {
            // Optional: derive xy from rgb (not required for restore in your flows,
            // bri+ct or rgb is usually enough). Uncomment if you want xy filled.
            // const r = (rgbInt >> 16) & 0xff;
            // const g = (rgbInt >> 8) & 0xff;
            // const b = rgbInt & 0xff;
            // state.xy = rgbToXy(r, g, b);
        }

        return state;
    }

    /**
     * Apply state changes.
     * Accepted body keys (same as your Hue path):
     *  - on: boolean
     *  - bri: 1..254
     *  - xy: [x, y]  (preferred for color)
     *  - ct: Mirek + set body.useCt = true to explicitly request CT mode
     * Optional: body.transition (ms), defaults to 300ms smooth
     */
    async setState(id, body) {
        const dev = this.#getDevice(id);
        const cmds = [];

        // smooth transition (ms)
        const transition = Number(body.transition ?? 300);
        const effect = "smooth";
        const duration = this.#clamp(isFinite(transition) ? transition : 300, 30, 5000);

        // 1) power first (keine Farbe, wenn Lampe aus)
        if (typeof body.on === 'boolean') {
            cmds.push(["set_power", body.on ? "on" : "off", effect, duration]);
        }

        // 2) COLOR FIRST: xy -> RGB, sonst CT (nur wenn explizit angefordert via useCt)
        if (Array.isArray(body.xy) && body.xy.length === 2) {
            const [x, y] = body.xy.map(Number);
            const bri = typeof body.bri === 'number' ? body.bri : 254;
            const [r, g, b] = xyToRgb(x, y, bri);
            const rgb = (r << 16) + (g << 8) + b;
            cmds.push(["set_rgb", rgb, effect, duration]);
        } else if (typeof body.ct === 'number' && body.useCt) {
            const kelvin = Math.round(1000000 / body.ct);      // Mirek -> Kelvin
            const k = this.#clamp(kelvin, 1700, 6500);
            cmds.push(["set_ct_abx", k, effect, duration]);
        }

        // 3) BRIGHTNESS LAST: Hue 1..254 -> Yeelight 1..100
        if (typeof body.bri === 'number' && isFinite(body.bri)) {
            const bri = this.#clamp(Math.round(body.bri * 100 / 254), 1, 100);
            cmds.push(["set_bright", bri, effect, duration]);
        }

        if (cmds.length === 0) return true;
        return this.#send(dev, cmds);
    }


    // ---------- Low-level helpers ----------

    #getDevice(id) {
        const idx = Number(id) - 1;
        const dev = this.devices[idx];
        if (!dev) throw new Error(`Unknown Yeelight device id: ${id}`);
        return dev;
    }

    #clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    /**
     * Send one or more commands over a single TCP connection.
     * Fire-and-forget: we don't require responses to succeed.
     */
    #send(dev, cmds) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: dev.host, port: dev.port }, () => {
                for (let i = 0; i < cmds.length; i++) {
                    const id = i + 1;
                    const req = JSON.stringify({ id, method: cmds[i][0], params: cmds[i].slice(1) }) + "\r\n";
                    socket.write(req);
                }
                // Close after we flushed all commands (fire-and-forget)
                socket.end();
            });

            socket.setTimeout(2500);
            socket.on('timeout', () => { socket.destroy(); resolve(true); });
            socket.on('error', (e) => { socket.destroy(); reject(e); });
            socket.on('data', () => { }); // ignore acks
            socket.on('end', () => resolve(true));
            socket.on('close', () => resolve(true));
        });
    }

    /**
     * RPC helper to send a single method and parse its JSON response's "result".
     */
    #rpc(dev, method, params = []) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: dev.host, port: dev.port }, () => {
                const req = JSON.stringify({ id: 1, method, params }) + "\r\n";
                socket.write(req);
            });

            let buf = "";
            socket.setTimeout(2500);
            socket.on('data', chunk => { buf += chunk.toString(); });
            socket.on('timeout', () => { socket.destroy(); reject(new Error("Yeelight RPC timeout")); });
            socket.on('error', e => { socket.destroy(); reject(e); });
            socket.on('end', () => {
                try {
                    const line = buf.trim().split(/\r?\n/).pop() || "{}";
                    const json = JSON.parse(line);
                    resolve(json.result || []);
                } catch (e) {
                    reject(new Error("Invalid Yeelight response"));
                }
            });
        });
    }

    // ---------- Optional: SSDP-like discovery ----------

    /**
     * Discover Yeelight bulbs on the LAN via multicast M-SEARCH.
     * Returns an array of { host, port, name?, id?, model? }.
     *
     * Usage:
     *   const devices = await YeelightController.discover(1500);
     *   const ctrl = new YeelightController({ devices });
     */
    static discover(timeoutMs = 2500) {
        const dgram = require('dgram');
        const socket = dgram.createSocket('udp4');

        const MSEARCH =
            'M-SEARCH * HTTP/1.1\r\n' +
            'HOST: 239.255.255.250:1982\r\n' +
            'MAN: "ssdp:discover"\r\n' +
            'ST: wifi_bulb\r\n\r\n';

        return new Promise((resolve) => {
            const found = new Map();

            socket.on('message', msg => {
                try {
                    const text = msg.toString();
                    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                    const headers = {};
                    for (const line of lines) {
                        const idx = line.indexOf(':');
                        if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
                    }

                    const loc = headers['location'] || headers['Location'];
                    const m = /\byeelight:\/\/([\d.]+):(\d+)\b/i.exec(loc || '');
                    if (!m) return;

                    const host = m[1];
                    const port = Number(m[2] || 55443);
                    const id = headers['id'] || undefined;
                    const model = headers['model'] || undefined;
                    const name = headers['name'] || undefined;

                    const key = `${host}:${port}`;
                    if (!found.has(key)) found.set(key, { host, port, id, model, name });
                } catch {
                    // ignore malformed packets
                }
            });

            socket.on('error', () => {
                try { socket.close(); } catch { }
                resolve([...found.values()]);
            });

            try {
                socket.send(MSEARCH, 1982, '239.255.255.250');
            } catch {
                // still resolve whatever we collected
            }

            setTimeout(() => {
                try { socket.close(); } catch { }
                resolve([...found.values()]);
            }, timeoutMs);
        });
    }
}

// ---- Color conversion helpers ----
// Simple xy->RGB (sRGB, D65), scaled by Hue bri (1..254) to luminance-ish Y
function xyToRgb(x, y, bri = 254) {
    // Avoid division by zero
    const Y = (typeof bri === 'number' && bri > 0 ? bri : 254) / 254;
    const X = (y > 0 ? (Y / y) * x : 0);
    const Z = (y > 0 ? (Y / y) * (1 - x - y) : 0);

    // XYZ -> linear RGB (sRGB, D65)
    let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    let b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;

    // Linear -> gamma corrected
    const gamma = v => {
        v = Math.max(0, Math.min(1, v));
        return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    };

    return [Math.round(gamma(r) * 255), Math.round(gamma(g) * 255), Math.round(gamma(b) * 255)];
}

// Optional helper if you ever want rgb -> xy.
// function rgbToXy(r, g, b) {
//   // Normalize
//   let R = r / 255, G = g / 255, B = b / 255;
//   // Gamma remove
//   const inv = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
//   R = inv(R); G = inv(G); B = inv(B);
//   // sRGB->XYZ
//   const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
//   const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
//   const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
//   const sum = X + Y + Z || 1;
//   return [X / sum, Y / sum];
// }

module.exports = YeelightController;