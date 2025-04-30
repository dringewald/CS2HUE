const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

let HTML_LOG_ENABLED = true;
let DEBUG_ENABLED = false;
let renderLogFunction = null;
let sessionLogLines = [];
let MAX_SESSION_LINES = 1000;
let logBasePath = null;
const pendingLogs = [];

async function initializeLogger() {
    try {
        logBasePath = await ipcRenderer.invoke('get-log-path');
        debug("📁 Using logBasePath: " + logBasePath);
    } catch (err) {
        console.warn('⚠️ Failed to get log path from main process:', err.message);
        logBasePath = path.join(__dirname, 'logs');
    }
}

const logCss = fs.readFileSync(path.join(__dirname, 'css', 'log-style.css'), 'utf-8');

function getFormattedTimestamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} - ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function setHtmlLogEnabled(value) {
    if (!logBasePath) return;

    const enabled = Boolean(value);
    HTML_LOG_ENABLED = enabled;

    if (enabled) {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filenameDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const dirPath = logBasePath;
        const filePath = path.join(dirPath, `${filenameDate}-log.html`);

        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        const body = sessionLogLines.join('\n');
        const fullHtml = renderHtmlPage(filenameDate, body, false, true, true);

        fs.writeFileSync(filePath, fullHtml);
        info('📝 HTML logging enabled — flushed existing logs to file.');
    }
}

function setDebugMode(value) {
    DEBUG_ENABLED = Boolean(value);
}

function setRendererLogFunction(fn) {
    renderLogFunction = fn;
    pendingLogs.forEach(msg => renderLogFunction(msg));
    pendingLogs.length = 0;
}

function createLog(level, ...args) {
    const timestamp = getFormattedTimestamp();
    const message = `[${level}] ${timestamp} | ${args.join(' ')}`;
    console.log(message);

    if (renderLogFunction) {
        renderLogFunction(message);
    } else {
        pendingLogs.push(message);
    }    

    appendToHtmlLog(message);
}

function info(...args) {
    createLog('INFO', ...args);
}

function warn(...args) {
    createLog('WARN', ...args);
}

function error(...args) {
    createLog('ERROR', ...args);
}

function debug(...args) {
    if (!DEBUG_ENABLED) return;
    createLog('DEBUG', ...args);
}

function appendToHtmlLog(rawMessage) {
    if (!logBasePath) return;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filenameDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const dirPath = logBasePath;
    const filePath = path.join(dirPath, `${filenameDate}-log.html`);

    const match = rawMessage.match(/^\[(\w+)] (\d{2}\.\d{2}\.\d{4} - \d{2}:\d{2}:\d{2}) \| (.+)$/);
    const level = match?.[1] ?? 'INFO';
    const timestamp = match?.[2] ?? now.toLocaleString();
    const content = match?.[3] ?? rawMessage;

    const styles = {
        INFO: 'background: #e6f7ff; color: #004085;',
        DEBUG: 'background: #2d2d2d; color: #aaaaaa;',
        ERROR: 'background: #f8d7da; color: #721c24;',
        WARN: 'background: #fff3cd; color: #856404;',
    };

    const style = styles[level] || styles.INFO;

    const logLine = `<div class="log-line ${level.toLowerCase()}" style="${style}">
        <span class="level">[${level}]</span>
        <span class="time">${timestamp}</span>
        <span class="msg">${content}</span>
    </div>`;

    sessionLogLines.push(logLine);
    if (sessionLogLines.length > MAX_SESSION_LINES) {
        sessionLogLines.shift(); // remove the oldest line
    }

    if (!HTML_LOG_ENABLED) return;

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    const body = sessionLogLines.join('\n');
    const fullHtml = renderHtmlPage(filenameDate, body, false, true, true);

    fs.writeFileSync(filePath, fullHtml);
}

function getFullSessionHtml() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filenameDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const body = sessionLogLines.join('\n');

    return renderHtmlPage(filenameDate, body, true);
}

function renderHtmlPage(filenameDate, bodyContent, includeDownloadButton = false, showAutoReload = false, inlineCss = false) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Log File - ${filenameDate}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    ${inlineCss
            ? `<style>\n${logCss}\n</style>`
            : `
<link rel="stylesheet" type="text/css" href="/css/log-style.css">
<link rel="icon" type="image/png" href="/img/favicon/favicon-96x96.png" sizes="96x96">
<link rel="icon" type="image/svg+xml" href="/img/favicon/favicon.svg">
<link rel="shortcut icon" href="/img/favicon/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/img/favicon/apple-touch-icon.png">
<link rel="manifest" href="/img/favicon/site.webmanifest">
<script id="inlineLogCss" type="text/plain">\n${logCss}\n</script>`
        }
</head>
<body>
    <div class="page-wrapper">
        <div class="log-header">
            <h2>📘 ${includeDownloadButton ? 'Live Session Log' : 'Application Log - ' + filenameDate}</h2>
            <div class="toggle-section">
                <div class="theme-toggle-container">
                    <span class="toggle-text">🌙 Dark Mode</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="themeToggleCheckbox" onchange="toggleTheme()" />
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                ${showAutoReload ? `
                <div class="theme-toggle-container">
                    <span class="toggle-text">🔁 Auto Reload</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="reloadToggleCheckbox" onchange="toggleReload()" />
                        <span class="toggle-slider"></span>
                    </label>
                </div>` : ''}
            </div>
        </div>
        <div id="logFilter">
            <label><input type="checkbox" class="log-filter" value="info" checked /> INFO</label>
            <label><input type="checkbox" class="log-filter" value="warn" checked /> WARN</label>
            <label><input type="checkbox" class="log-filter" value="error" checked /> ERROR</label>
            <label><input type="checkbox" class="log-filter" value="debug" /> DEBUG</label>
        </div>
        <div id="log-container">
${bodyContent}
        </div>

        ${includeDownloadButton ? `<button class="save-log-btn" onclick="downloadLog()">💾 Save Log</button>` : ''}
    </div>
    <script>
        const container = document.getElementById("log-container");
        if (container) container.scrollTop = container.scrollHeight;

        window.addEventListener('DOMContentLoaded', () => {
            const savedTheme = localStorage.getItem('theme');
            const themeCheckbox = document.getElementById("themeToggleCheckbox");
            const savedFilters = localStorage.getItem('logFilterLevels');

            if (savedTheme) {
                themeCheckbox.checked = savedTheme === 'light';
                toggleTheme();
            } else {
                const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
                themeCheckbox.checked = prefersLight;
                toggleTheme();
            }

            if (savedFilters) {
                try {
                    const parsed = JSON.parse(savedFilters);
                    document.querySelectorAll('.log-filter').forEach(cb => {
                        if (parsed.hasOwnProperty(cb.value)) {
                            cb.checked = parsed[cb.value];
                        }
                    });
                } catch (e) {
                    console.warn('⚠️ Failed to parse saved log filters');
                }
            }
            
            ${showAutoReload ? `
            const savedReload = localStorage.getItem('autoReload');
            const reloadCheckbox = document.getElementById("reloadToggleCheckbox");
            if (savedReload === 'true') {
                reloadCheckbox.checked = true;
                toggleReload();
            }` : ''}

            applyLogFilter();
        });

        function applyTheme(isLight) {
            const checkbox = document.getElementById("themeToggleCheckbox");
            const label = document.querySelector(".theme-toggle-container .toggle-text");

            if (isLight) {
                document.documentElement.style.setProperty('--bg-color', '#ffffff');
                document.documentElement.style.setProperty('--text-color', '#000000');
                label.textContent = '☀️ Light Mode';
                checkbox.checked = true;
            } else {
                document.documentElement.style.setProperty('--bg-color', '#121212');
                document.documentElement.style.setProperty('--text-color', '#eeeeee');
                label.textContent = '🌙 Dark Mode';
                checkbox.checked = false;
            }
        }

        function toggleTheme() {
            const isLight = document.getElementById("themeToggleCheckbox").checked;
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
            applyTheme(isLight);
        }

        function applyLogFilter() {
            const activeLevels = Array.from(document.querySelectorAll('.log-filter:checked'))
                .map(cb => cb.value.toLowerCase());

            document.querySelectorAll('.log-line').forEach(line => {
                const matches = activeLevels.some(level => line.classList.contains(level));
                line.style.display = matches ? 'flex' : 'none';
            });

            // Save to localStorage
            const allLevels = Array.from(document.querySelectorAll('.log-filter'))
                .reduce((acc, cb) => ({ ...acc, [cb.value]: cb.checked }), {});
            localStorage.setItem('logFilterLevels', JSON.stringify(allLevels));
        }

        ${showAutoReload ? `
        let reloadInterval = null;
        function toggleReload() {
            const checkbox = document.getElementById("reloadToggleCheckbox");
            if (checkbox.checked) {
                reloadInterval = setInterval(() => {
                    window.location.reload();
                }, 10000);
                localStorage.setItem('autoReload', 'true');
            } else {
                clearInterval(reloadInterval);
                localStorage.setItem('autoReload', 'false');
            }
        }` : ''}

        ${includeDownloadButton ? `
        function downloadLog(filename = 'session-log.html') {
            const doc = document.documentElement.cloneNode(true); // Clone live page safely

            // Remove external CSS link(s)
            doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                const href = link.getAttribute('href') || '';
                if (href.includes('/css/log-style.css') || href.includes('fonts.googleapis.com')) {
                    link.remove();
                }
            });

            // Remove extension-injected tags like <w12345...>
            doc.querySelectorAll('body > *').forEach(el => {
                if (/^[WT]\w{8,}/.test(el.tagName)) {
                    el.remove();
                }
            });

            // Remove <script id="inlineLogCss">
            const inlineCssScript = doc.querySelector('script#inlineLogCss');
            if (inlineCssScript) inlineCssScript.remove();

            // 🆕 Remove Save Log button
            doc.querySelectorAll('button.save-log-btn').forEach(btn => btn.remove());

            // 🆕 Remove any button still calling downloadLog
            doc.querySelectorAll('button[onclick*="downloadLog"]').forEach(btn => btn.remove());

            // 🆕 Remove the Auto Reload toggle button
            doc.querySelectorAll('.theme-toggle-container').forEach(container => {
                const text = container.querySelector('.toggle-text')?.textContent || '';
                if (text.includes('Auto Reload')) {
                    container.remove();
                }
            });

            // 🆕 Clean up all <script> tags (Currently buggy)
            //doc.querySelectorAll('script').forEach(script => {
                //let content = script.textContent || '';

                //content = content.replace(/setInterval\\([^]*?5000\\);\\s*/g, ''); // Remove polling
                //content = content.replace(/function toggleReload\\([^]*?\\}\\s*\\}/g, ''); // Remove toggleReload function
                //content = content.replace(/const savedReload[^]*?toggleReload\\(\\);\\s*\\}/g, ''); // Remove reload checkbox init
                //content = content.replace(/const reloadCheckbox[^]*?;\\s*/g, ''); // Remove reloadCheckbox var

                //script.textContent = content;
            //});

            // Re-inject CSS properly (inline <style> if needed)
            const rawCss = document.getElementById('inlineLogCss')?.textContent || '';
            if (rawCss) {
                const styleTag = document.createElement('style');
                styleTag.textContent = rawCss;
                doc.querySelector('head').appendChild(styleTag);
            }

            // Make sure all log lines are visible (no filters hidden)
            doc.querySelectorAll('.log-line').forEach(el => {
                el.style.display = 'flex';
            });

            // Serialize final HTML
            const finalHtml = '<!DOCTYPE html>\\n' + doc.outerHTML;

            // Trigger download
            const blob = new Blob([finalHtml], { type: 'text/html' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
        }

        // Live update polling + re-filtering
        setInterval(() => {
            fetch(window.location.href)
                .then(res => res.text())
                .then(html => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    const newContent = doc.getElementById('log-container').innerHTML;
                    document.getElementById('log-container').innerHTML = newContent;
                    container.scrollTop = container.scrollHeight;
                    applyLogFilter();
                });
        }, 5000);
        ` : ''}

        // Log level filtering
        document.querySelectorAll('.log-filter').forEach(cb => {
            cb.addEventListener('change', applyLogFilter);
        });
    </script>
</body>
</html>`;
}

function clearSessionLog() {
    sessionLogLines = [];
}

function setMaxSessionLines(value) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0) {
        MAX_SESSION_LINES = parsed;
        debug(`⚙️ Max session log lines set to ${MAX_SESSION_LINES}`);
    } else {
        warn(`⚠️ Invalid MAX_SESSION_LINES value: ${value}`);
    }
}

module.exports = {
    info,
    warn,
    error,
    debug,
    setDebugMode,
    setRendererLogFunction,
    getFullSessionHtml,
    setHtmlLogEnabled,
    clearSessionLog,
    setMaxSessionLines,
    initializeLogger
};