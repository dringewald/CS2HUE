/**
 * HueBridgeHelper provides functionality to discover Hue Bridge IP addresses,
 * create user API keys, and retrieve light metadata from the Hue API.
 *
 * This class uses both local network discovery (SSDP via raw UDP) and Philips' cloud API
 * to find bridges, then enables user authentication and light listing.
 */
const https = require('https');
const http = require('http');
const dgram = require('dgram');
const { debug, warn, error } = require('./logger');

class HueBridgeHelper {
    /**
     * Discover the Hue Bridge IP address on the local network.
     * Attempts SSDP (UPnP) first using raw UDP, then falls back to Philips' cloud discovery.
     * @returns {Promise<string>} The discovered IP address of the Hue Bridge.
     * @throws Will reject with an error message if discovery fails or times out.
     */
    static async discoverBridgeIP() {
        // Try SSDP/UPnP discovery using raw UDP
        try {
            debug('🔍 Attempting SSDP discovery...');
            const ip = await new Promise((resolve, reject) => {
                const socket = dgram.createSocket('udp4');
                const message = Buffer.from(
                    'M-SEARCH * HTTP/1.1\r\n' +
                    'HOST: 239.255.255.250:1900\r\n' +
                    'MAN: "ssdp:discover"\r\n' +
                    'MX: 2\r\n' +
                    'ST: upnp:rootdevice\r\n' +
                    '\r\n'
                );

                let found = false;
                socket.on('message', msg => {
                    const str = msg.toString();
                    if (str.includes('IpBridge')) {
                        const match = str.match(/LOCATION: http:\/\/(.*?):80\/description\.xml/i);
                        if (match && match[1]) {
                            found = true;
                            socket.close();
                            debug(`✅ SSDP found bridge IP: ${match[1]}`);
                            resolve(match[1]);
                        }
                    }
                });

                socket.on('error', err => {
                    socket.close();
                    reject(new Error(`SSDP socket error: ${err.message}`));
                });

                socket.send(message, 0, message.length, 1900, '239.255.255.250');

                setTimeout(() => {
                    if (!found) {
                        socket.close();
                        reject(new Error('SSDP discovery timed out with no bridge found.'));
                    }
                }, 3000);
            });

            return ip;
        } catch (err) {
            warn(`⚠️ SSDP discovery failed: ${err.message}`);
        }

        // Fallback to Philips' cloud discovery
        return new Promise((resolve, reject) => {
            const req = https.get('https://discovery.meethue.com/', res => {
                let data = '';

                debug(`🌐 Cloud discovery status: ${res.statusCode}`);
                debug(`📩 Headers: ${JSON.stringify(res.headers)}`);

                res.on('data', chunk => { data += chunk; });

                res.on('end', () => {
                    debug(`📨 Cloud discovery response: ${data.slice(0, 500) || '[empty]'}`);

                    if (res.statusCode === 429) {
                        return reject(new Error("Hue discovery rate limit reached (429). Please wait 15 minutes or enter the IP manually."));
                    }

                    if (!data) {
                        return reject(new Error(`Cloud discovery returned empty response. Status: ${res.statusCode}`));
                    }

                    try {
                        const bridges = JSON.parse(data);
                        if (!Array.isArray(bridges) || bridges.length === 0) {
                            return reject(new Error("No Hue Bridge found via cloud discovery."));
                        }
                        const ip = bridges[0]?.internalipaddress;
                        if (!ip) {
                            return reject(new Error("Hue Bridge data missing IP address."));
                        }
                        debug(`✅ Cloud discovered bridge IP: ${ip}`);
                        resolve(ip);
                    } catch (err) {
                        error("❌ Failed to parse cloud discovery response:", err.message);
                        reject(new Error(`Invalid cloud discovery response: ${data.slice(0, 200)}`));
                    }
                });
            });

            req.setTimeout(3000, () => {
                req.abort();
                warn("⏳ Cloud discovery timed out.");
                reject(new Error("Cloud discovery timed out after 3 seconds."));
            });

            req.on('error', err => {
                error("❌ Cloud discovery request failed:", err.message);
                reject(new Error(`Cloud discovery failed: ${err.message}`));
            });
        });
    }

    /**
     * Create a new API user (key) on the Hue Bridge.
     * Requires the user to press the physical button on the bridge.
     *
     * @param {string} bridgeIP - The IP address of the Hue Bridge.
     * @param {string} [appName='CS2HUE#renderer'] - A name for the application key.
     * @returns {Promise<string>} The created API username (key).
     * @throws Will reject if the request fails or the response is invalid.
     */
    static async createUser(bridgeIP, appName = 'CS2HUE#renderer') {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({ devicetype: appName });

            const options = {
                hostname: bridgeIP,
                port: 80,
                path: '/api',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = http.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        const result = response[0];

                        if (result.success?.username) {
                            resolve(result.success.username);
                        } else if (result.error) {
                            reject(new Error(result.error.description));
                        } else {
                            reject(new Error("Unexpected response from Hue Bridge."));
                        }
                    } catch (err) {
                        reject(new Error("Failed to parse createUser response."));
                    }
                });
            });

            req.on('error', err => {
                reject(new Error(`createUser request failed: ${err.message}`));
            });

            req.write(postData);
            req.end();
        });
    }
    
    /**
     * Fetch the list of available lights and their names from the Hue Bridge.
     *
     * @param {string} bridgeIP - The IP address of the Hue Bridge.
     * @param {string} apiKey - The API key to authenticate with the Hue Bridge.
     * @returns {Promise<{id: string, name: string}[]>} List of light objects.
     * @throws Will reject if the bridge request fails or returns invalid data.
     */
    static async fetchLightIDsWithNames(bridgeIP, apiKey) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: bridgeIP,
                port: 80,
                path: `/api/${apiKey}/lights`,
                method: 'GET'
            };

            const req = http.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const lights = JSON.parse(data);
                        const entries = Object.entries(lights).map(([id, light]) => ({
                            id,
                            name: light.name
                        }));
                        resolve(entries);
                    } catch (err) {
                        reject(new Error("Failed to parse light list."));
                    }
                });
            });

            req.on('error', err => {
                reject(new Error(`fetchLightIDs request failed: ${err.message}`));
            });

            req.end();
        });
    }
}

module.exports = HueBridgeHelper;