function applyTheme(isLight) {
    const checkbox = document.getElementById("themeToggleCheckbox");
    const label = document.querySelector(".theme-toggle-container .toggle-text");

    if (isLight) {
        document.documentElement.style.setProperty('--bg-color', '#ffffff');
        document.documentElement.style.setProperty('--text-color', '#000000');
        document.documentElement.style.setProperty('--section-bg', '#f5f5f5');
        document.documentElement.style.setProperty('--toc-bg', '#f5f5f5');
        document.documentElement.style.setProperty('--code-bg', '#e0e0e0');
        document.documentElement.style.setProperty('--table-header-bg', '#e5e5e5');
        document.documentElement.style.setProperty('--border-color', '#ccc');
        document.documentElement.style.setProperty('--shadow-color', 'rgba(0, 0, 0, 0.1)');
        document.documentElement.style.setProperty('--scroll-btn-bg', '#ffcc00');
        document.documentElement.style.setProperty('--scroll-icon-color', '#000000');
        label.textContent = '☀️ Light Mode';
        checkbox.checked = true;
    } else {
        document.documentElement.style.setProperty('--bg-color', '#121212');
        document.documentElement.style.setProperty('--text-color', '#eeeeee');
        document.documentElement.style.setProperty('--section-bg', '#1e1e1e');
        document.documentElement.style.setProperty('--toc-bg', '#1e1e1e');
        document.documentElement.style.setProperty('--code-bg', '#0d0d0d');
        document.documentElement.style.setProperty('--table-header-bg', '#2a2a2a');
        document.documentElement.style.setProperty('--border-color', '#333');
        document.documentElement.style.setProperty('--shadow-color', 'rgba(0, 0, 0, 0.5)');
        document.documentElement.style.setProperty('--scroll-btn-bg', '#2a2a2a');
        document.documentElement.style.setProperty('--scroll-icon-color', '#ffffff');
        label.textContent = '🌙 Dark Mode';
        checkbox.checked = false;
    }
}

function toggleTheme() {
    const isLight = document.getElementById("themeToggleCheckbox").checked;
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    applyTheme(isLight);
}

// Apply theme on initial page load
window.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    const isLight = savedTheme === 'light';
    applyTheme(isLight);
});