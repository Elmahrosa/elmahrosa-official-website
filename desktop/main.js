const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain, dialog, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const BRIDGE_URL = process.env.TEOS_BRIDGE_URL || 'https://agent-code-risk-mcp-production.up.railway.app';

const SERVICES = {
  bridge:     { url: BRIDGE_URL,                                                      name: 'TEOS Bridge',     desc: 'via Risk Engine (MCP)' },
  bot:        { url: 'https://teoslinker-bot-production-ca27.up.railway.app',               name: 'TEOS Bot' },
  risk:       { url: 'https://agent-code-risk-mcp-production.up.railway.app',     name: 'Risk Engine' },
  activation: { url: 'https://activation-service-production-a368.up.railway.app',      name: 'Identity',        desc: 'via Activation Service' },
  shield:     { url: 'https://teos-sentinel-shield-production-7f0d.up.railway.app',    name: 'Sentinel Shield' },
};

const POLL_INTERVAL = 30000;
const MAX_RETRY_DELAY = 120000;
const iconSize = 16;
const TEOS_DIR = path.join(os.homedir(), '.teos');
const CONFIG_PATH = path.join(TEOS_DIR, 'config.json');
const LOG_PATH = path.join(TEOS_DIR, 'desktop.log');

let mainWindow = null;
let tray = null;
let healthCache = {};
let statusInterval = null;
let trayIconGreen = null;
let trayIconRed = null;
let pollRetryDelay = 5000;
let isOnline = true;

/* ── Logger ── */

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()}: ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  try {
    if (!fs.existsSync(TEOS_DIR)) fs.mkdirSync(TEOS_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (logErr) { console.error('[teos] Logger write failed:', logErr.message); }
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

const logger = {
  info:  (msg, d) => log('info', msg, d),
  warn:  (msg, d) => log('warn', msg, d),
  error: (msg, d) => log('error', msg, d),
};

/* ── Config / Credit Control (shared with CLI) ── */

function ensureTeosDir() {
  if (!fs.existsSync(TEOS_DIR)) {
    try { fs.mkdirSync(TEOS_DIR, { recursive: true }); } catch (err) {
      logger.error('Failed to create TEOS_DIR', { path: TEOS_DIR, error: err.message });
    }
  }
}

function loadConfig() {
  ensureTeosDir();
  const defaults = {
    deviceId: crypto.randomUUID(),
    apiKey: null,
    createdAt: new Date().toISOString(),
  };
  if (!fs.existsSync(CONFIG_PATH)) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    } catch (err) {
      logger.error('Failed to write default config', { error: err.message });
    }
    return defaults;
  }
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch (err) {
    logger.warn('Corrupt config, using defaults', { error: err.message });
    return defaults;
  }
}

function saveConfig(cfg) {
  ensureTeosDir();
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (err) {
    logger.error('Failed to save config', { error: err.message });
  }
}

function getTierInfo(cfg) {
  const apiKey = cfg.apiKey || process.env.TEOS_API_KEY || null;
  if (apiKey) return { tier: 'authenticated', remaining: 999, keyPrefix: apiKey.slice(0, 12) };
  return { tier: 'no-key', remaining: 0 };
}

/* ── Tray ── */

function createTrayIcons() {
  try {
    const makeIcon = (r, g, b) => {
      const canvas = Buffer.alloc(iconSize * iconSize * 4);
      for (let y = 0; y < iconSize; y++) {
        for (let x = 0; x < iconSize; x++) {
          const idx = (y * iconSize + x) * 4;
          const cx = x - iconSize / 2, cy = y - iconSize / 2;
          const dist = Math.sqrt(cx * cx + cy * cy);
          if (dist < iconSize / 2 - 1) {
            canvas[idx] = r; canvas[idx + 1] = g; canvas[idx + 2] = b; canvas[idx + 3] = 255;
          } else {
            canvas[idx] = 0; canvas[idx + 1] = 0; canvas[idx + 2] = 0; canvas[idx + 3] = 0;
          }
        }
      }
      return nativeImage.createFromBuffer(canvas, { width: iconSize, height: iconSize });
    };
    trayIconGreen = makeIcon(0, 200, 0);
    trayIconRed = makeIcon(200, 0, 0);
  } catch (err) {
    logger.warn('Failed to create tray icons, will use defaults', { error: err.message });
  }
}

async function pollHealth() {
  try {
    return await _pollHealth();
  } catch (err) {
    logger.error('Health poll crashed', { error: err.message, stack: err.stack?.slice(0, 200) });
    return false;
  }
}

async function _pollHealth() {
  let allUp = true;

  for (const [key, svc] of Object.entries(SERVICES)) {
    try {
      const res = await fetch(`${svc.url}/health`, { signal: AbortSignal.timeout(5000) });
      const wasDown = healthCache[key] === 'DOWN';
      healthCache[key] = res.ok ? 'UP' : 'DEGRADED';
      if (!res.ok) allUp = false;
      if (wasDown && healthCache[key] === 'UP') {
        logger.info(`Service recovered`, { service: key });
      }
    } catch (err) {
      const wasUp = healthCache[key] === 'UP' || !healthCache[key];
      healthCache[key] = 'DOWN';
      allUp = false;
      if (wasUp) logger.warn(`Service unreachable`, { service: key, error: err.message });
    }
  }

  const prevOnline = isOnline;
  isOnline = allUp;
  if (prevOnline !== isOnline) {
    logger.info(`Connectivity changed`, { online: isOnline });
  }
  pollRetryDelay = allUp ? 5000 : Math.min(pollRetryDelay * 1.5, MAX_RETRY_DELAY);

  if (tray) {
    try {
      tray.setImage(allUp ? (trayIconGreen || nativeImage.createEmpty()) : (trayIconRed || nativeImage.createEmpty()));
    } catch (err) {
      logger.warn('Failed to update tray icon', { error: err.message });
    }
    updateTrayTooltip();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const cfg = loadConfig();
      mainWindow.webContents.send('teos-update', { services: { ...healthCache }, tier: getTierInfo(cfg), allUp });
    } catch (err) {
      logger.warn('Failed to push update to renderer', { error: err.message });
    }
  }

  return allUp;
}

function updateTrayTooltip() {
  try {
    const cfg = loadConfig();
    const tier = getTierInfo(cfg);
    const lines = [
      'TEOS Sentinel',
      '---',
      ...Object.entries(SERVICES).map(([key, svc]) => {
        const s = healthCache[key] || '?';
        return `${s === 'UP' ? '\u25CF' : '\u25CB'} ${svc.name}: ${s}`;
      }),
      '---',
      tier.tier === 'authenticated'
        ? `Key: ${tier.keyPrefix}... | Unlimited`
        : `No API key — Add in Settings`,
    ];
    if (tray) {
      const tooltip = lines.join('\n');
      if (typeof tray.setToolTip === 'function') tray.setToolTip(tooltip);
      else if (typeof tray.setTooltip === 'function') tray.setTooltip(tooltip);
      else tray.tooltip = tooltip;
    }
  } catch (err) {
    logger.warn('Failed to update tray tooltip', { error: err.message });
  }
}

function createTray() {
  createTrayIcons();

  try {
    tray = new Tray(trayIconGreen || nativeImage.createEmpty());
  } catch (err) {
    logger.error('Failed to create tray (non-fatal)', { error: err.message });
    return;
  }

  if (typeof tray.setToolTip === 'function') tray.setToolTip('TEOS Sentinel');
  else if (typeof tray.setTooltip === 'function') tray.setTooltip('TEOS Sentinel');
  else tray.tooltip = 'TEOS Sentinel';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    {
      label: 'Check Health Now',
      click: async () => {
        const ok = await pollHealth();
        if (!ok && Notification.isSupported()) {
          try { new Notification({ title: 'TEOS Sentinel', body: 'Some services are down' }).show(); } catch (e) { logger.warn('Notification failed', { error: e.message }); }
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

/* ── Window ── */

function findDashboardHtml() {
  const candidates = [
    path.join(__dirname, '..', 'dashboard.html'),
    path.join(PUBLIC_DIR, 'dashboard.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  if (!fs.existsSync(preloadPath)) {
    logger.error('Preload script not found', { path: preloadPath });
    dialog.showErrorBox('TEOS Sentinel — Startup Error', `Preload script not found:\n${preloadPath}`);
    return;
  }

  try {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      title: 'TEOS Sentinel',
      icon: trayIconGreen || undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
      show: false,
    });

    const htmlPath = findDashboardHtml();
    if (!fs.existsSync(htmlPath)) {
      logger.warn('Dashboard HTML not found, loading may fail', { tried: htmlPath });
    }

    mainWindow.loadFile(htmlPath);

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      logger.info('Window ready');
    });

    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      logger.error('Window failed to load', { errorCode: code, description: desc });
    });

    mainWindow.webContents.on('crashed', () => {
      logger.error('Render process crashed');
      if (Notification.isSupported()) {
        try { new Notification({ title: 'TEOS Sentinel', body: 'Dashboard crashed. Restart the app.' }).show(); } catch (e) { logger.warn('Crash notification failed', { error: e.message }); }
      }
    });

    mainWindow.webContents.on('unresponsive', () => {
      logger.warn('Render process unresponsive');
    });

    mainWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    mainWindow.on('closed', () => {
      logger.info('Window closed');
      mainWindow = null;
    });
  } catch (err) {
    logger.error('Failed to create window', { error: err.message });
    dialog.showErrorBox('TEOS Sentinel — Window Error', `Failed to create dashboard window:\n${err.message}`);
  }
}

/* ── IPC Handlers ── */

ipcMain.handle('teos:get-config', () => {
  return getTierInfo(loadConfig());
});

ipcMain.handle('teos:login', (_event, apiKey) => {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
    return { error: 'Invalid API key' };
  }
  const cfg = loadConfig();
  cfg.apiKey = apiKey.trim();
  saveConfig(cfg);
  updateTrayTooltip();
  logger.info('API key saved');
  return { ok: true };
});

ipcMain.handle('teos:logout', () => {
  const cfg = loadConfig();
  cfg.apiKey = null;
  saveConfig(cfg);
  updateTrayTooltip();
  logger.info('API key removed');
  return { ok: true };
});

ipcMain.handle('teos:fetch-health', async () => {
  const results = {};
  for (const [key, svc] of Object.entries(SERVICES)) {
    try {
      const res = await fetch(`${svc.url}/health`, { signal: AbortSignal.timeout(5000) });
      results[key] = { status: res.ok ? 'UP' : 'DEGRADED', name: svc.name };
    } catch (err) {
      results[key] = { status: 'DOWN', name: svc.name, error: err.message };
    }
  }
  return results;
});

ipcMain.handle('teos:run-scan', async (_event, code) => {
  const cfg = loadConfig();
  const apiKey = cfg.apiKey || process.env.TEOS_API_KEY || null;

  if (!apiKey) {
    return { error: 'No API key configured. Add one in Settings or set TEOS_API_KEY.' };
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-teos-api-key': apiKey, 'x-teos-device-id': cfg.deviceId },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Scan API error', { status: res.status, body: text.slice(0, 200) });
      return { error: `API ${res.status}` };
    }
    const data = await res.json();
    updateTrayTooltip();
    return data;
  } catch (err) {
    logger.error('Scan failed', { error: err.message });
    return { error: err.message };
  }
});

ipcMain.handle('teos:get-log', () => {
  try {
    if (!fs.existsSync(LOG_PATH)) return '';
    return fs.readFileSync(LOG_PATH, 'utf-8').split('\n').slice(-200).join('\n');
  } catch (err) {
    return `Error reading log: ${err.message}`;
  }
});

ipcMain.handle('teos:get-version', () => {
  try {
    const pkg = path.join(__dirname, 'package.json');
    return { version: JSON.parse(fs.readFileSync(pkg, 'utf-8')).version || '0.0.0', electron: process.versions.electron };
  } catch {
    return { version: '0.0.0', electron: process.versions.electron };
  }
});

/* ── App Lifecycle ── */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logger.info('Another instance is running, quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    logger.info('App starting', { version: app.getVersion(), electron: process.versions.electron });
    createTray();
    createWindow();
    pollHealth().then(ok => {
      if (!ok) logger.warn('Initial health check failed — some services may be unreachable');
    }).catch(err => logger.warn('Initial health poll rejected', { error: err.message }));
    statusInterval = setInterval(() => pollHealth().catch(err => logger.warn('Health poll rejected', { error: err.message })), POLL_INTERVAL);

    app.on('activate', () => {
      if (mainWindow) mainWindow.show();
      else createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    logger.info('App quitting');
    app.isQuitting = true;
    if (statusInterval) clearInterval(statusInterval);
  });

  app.on('renderer-process-gone', (_event, webContents, details) => {
    logger.error('Renderer process gone', { reason: details.reason });
  });

  app.on('child-process-gone', (_event, details) => {
    logger.error('Child process gone', { type: details.type, reason: details.reason });
  });

  powerMonitor.on('resume', () => {
    logger.info('System resumed from sleep');
    pollHealth();
  });

  powerMonitor.on('suspend', () => {
    logger.info('System going to sleep');
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack?.slice(0, 300) });
  });

  process.on('unhandledRejection', (reason) => {
    logger.warn('Unhandled rejection', { reason: String(reason).slice(0, 200) });
  });
}
