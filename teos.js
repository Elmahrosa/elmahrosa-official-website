#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { resolve, join } = require('path');
const { randomUUID } = require('crypto');
const os = require('os');

const PKG = resolve(__dirname, 'package.json');
const VERSION = existsSync(PKG) ? require(PKG).version || '0.0.0' : '0.0.0';

const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const CYN = '\x1b[36m';
const BLD = '\x1b[1m';
const RST = '\x1b[0m';

const TEOS_DIR = join(os.homedir(), '.teos');
const CONFIG_PATH = join(TEOS_DIR, 'config.json');

const IDENTITY_URL = process.env.TEOS_IDENTITY_URL || 'https://activation-service-production-a368.up.railway.app';
const BRIDGE_URL = process.env.TEOS_BRIDGE_URL || 'https://agent-code-risk-mcp-production.up.railway.app';

const SERVICES = {
  bridge:    { url: BRIDGE_URL,    name: 'TEOS Bridge' },
  identity:  { url: IDENTITY_URL,  name: 'Identity' },
  bot:       { url: 'https://teoslinker-bot-production-ca27.up.railway.app',          name: 'TEOS Bot' },
  risk:      { url: 'https://agent-code-risk-mcp-production.up.railway.app', name: 'Risk Engine' },
  shield:    { url: 'https://teos-sentinel-shield-production-7f0d.up.railway.app', name: 'Sentinel Shield' },
};

function ensureTeosDir() {
  if (!existsSync(TEOS_DIR)) mkdirSync(TEOS_DIR, { recursive: true, mode: 0o700 });
}

function loadConfig() {
  ensureTeosDir();
  const defaults = {
    deviceId: randomUUID(),
    apiKey: null,
    createdAt: new Date().toISOString(),
  };
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), { mode: 0o600 });
    return defaults;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  ensureTeosDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function checkHealth(service) {
  try {
    const res = await fetch(`${service.url}/health`, { signal: AbortSignal.timeout(5000) });
    const ok = res.ok;
    return { status: ok ? 'UP' : 'DEGRADED', code: res.status };
  } catch {
    return { status: 'DOWN', code: null };
  }
}

async function fetchWithTimeout(url, opts, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function scanViaBridge(code, apiKey, deviceId) {
  const headers = { 'Content-Type': 'application/json', 'x-teos-api-key': apiKey };
  if (deviceId) headers['x-teos-device-id'] = deviceId;

  const res = await fetchWithTimeout(`${BRIDGE_URL}/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code }),
  }, 35000);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail;
    try { detail = JSON.parse(text); } catch { detail = text.slice(0, 200); }
    const msg = detail?.error || `API error ${res.status}`;
    throw new Error(msg);
  }
  return res.json();
}

async function cmdScan(args) {
  let source = args.join(' ');
  if (!source && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    source = Buffer.concat(chunks).toString('utf-8');
  }
  if (!source) {
    console.error(`Usage: teos scan <file-path|code-snippet>`);
    console.error(`   or: cat file | teos scan`);
    process.exit(1);
  }

  let code = source;
  if (existsSync(resolve(source))) {
    code = readFileSync(resolve(source), 'utf-8');
  }

  const cfg = loadConfig();
  const apiKey = cfg.apiKey || process.env.TEOS_API_KEY || null;

  if (!apiKey) {
    console.error(`${RED}${BLD}No API key configured${RST}`);
    console.error(`  Register: ${CYN}teos login <email>${RST}`);
    console.error(`  Or set:   ${YLW}TEOS_API_KEY=<your-key> teos scan ...${RST}`);
    process.exit(1);
  }

  try {
    console.log(`${CYN} Scanning via TEOS Bridge...${RST}\n`);
    const data = await scanViaBridge(code, apiKey, cfg.deviceId);
    printScanResult(data);
    if (data._meta) {
      const m = data._meta;
      console.log(`\n${CYN}  Tier: ${m.tier} | Credits remaining: ${m.creditsRemaining}${m.dailyRemaining != null ? ` | Daily: ${m.dailyRemaining}` : ''}${RST}`);
    }
  } catch (err) {
    console.error(`${RED}Scan failed: ${err.message}${RST}`);
    if (err.message.includes('401') || err.message.includes('Invalid API key')) {
      console.error(`  ${YLW}Run ${CYN}teos logout${YLW} to reset, then register with ${CYN}teos login <email>${RST}`);
    }
    process.exit(1);
  }
}

function printScanResult(data) {
  const verdict = (data.verdict || 'ALLOW').toUpperCase();
  const score = data.score ?? 0;
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const reasons = Array.isArray(data.reasons) ? data.reasons : [];

  const icon = verdict === 'BLOCK' ? '\u{1F6D1}' : verdict === 'WARN' ? '\u26A0\uFE0F' : verdict === 'REVIEW' ? '\u{1F50D}' : '\u2705';
  const color = verdict === 'BLOCK' ? RED : verdict === 'WARN' ? YLW : verdict === 'REVIEW' ? CYN : GRN;

  console.log(`${icon}  ${color}${BLD}${verdict}${RST}  (risk: ${score}/100)`);

  if (reasons.length) {
    console.log(`\n${BLD}Reasons:${RST}`);
    reasons.forEach(r => console.log(`  \u2022 ${r}`));
  }

  if (findings.length) {
    console.log(`\n${BLD}Findings:${RST}`);
    findings.forEach(f => console.log(`  \u2022 ${f.ruleId || f.rule || '?'}: ${f.description || f.message || f}`));
  }

  if (data.metrics) {
    console.log(`\n  ${data.metrics.totalRules || '?'} rules evaluated`);
  }
}

async function cmdHealth() {
  console.log(`${BLD}TEOS Service Health${RST}\n`);

  let allUp = true;
  for (const svc of Object.values(SERVICES)) {
    const h = await checkHealth(svc);
    const icon = h.status === 'UP' ? '\u2705' : h.status === 'DEGRADED' ? '\u26A0\uFE0F' : '\u274C';
    const color = h.status === 'UP' ? GRN : h.status === 'DEGRADED' ? YLW : RED;
    console.log(`  ${icon}  ${color}${svc.name.padEnd(20)}${RST} ${h.status}${h.code ? ` (${h.code})` : ''}`);
    if (h.status !== 'UP') allUp = false;
  }

  const dot = allUp ? '\u2705' : '\u26A0\uFE0F';
  console.log(`\n${dot}  ${allUp ? `${GRN}All services healthy${RST}` : `${YLW}Some services degraded${RST}`}`);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const apiKey = cfg.apiKey || process.env.TEOS_API_KEY || null;

  console.log(`${BLD}TEOS Sovereign Security Stack${RST}`);
  console.log(`Version: ${VERSION}`);
  console.log(`Engine:  v4.0 | 111 rules | 471 tests\n`);

  if (apiKey) {
    console.log(`  ${GRN}API Key: ${apiKey.slice(0, 12)}...${RST}`);
    try {
      const res = await fetchWithTimeout(`${BRIDGE_URL}/tier`, {
        headers: { 'x-teos-api-key': apiKey },
      }, 5000);
      if (res.ok) {
        const t = await res.json();
        const limits = t.dailyLimit ? ` (${t.dailyLimit}/day)` : '';
        console.log(`  ${GRN}Tier: ${t.label || t.tier}${RST} | Credits: ${t.credits}${limits}`);
      }
    } catch {
      console.log(`  ${GRN}Authenticated${RST} (bridge unreachable)`);
    }
  } else {
    console.log(`  ${YLW}No API key configured${RST}`);
    console.log(`  ${CYN}Register:${RST} teos login <email>\n`);
  }

  console.log(`Device: ${cfg.deviceId.slice(0, 8)}...`);
  console.log(`\n${YLW}Pricing may change after beta — early founders locked in at current terms.${RST}\n`);

  await cmdHealth();
}

function cmdVersion() {
  console.log(`TEOS Sovereign Security Stack`);
  console.log(`Version: ${VERSION}`);
  console.log(`Engine:  v4.0`);
  console.log(`Rules:   103 (64 core + 29 Solana + 10 EVM)`);
  console.log(`Tests:   348`);
  console.log(`Services: Bridge, Identity, Bot, Risk Engine, Shield`);
  console.log(`Runtime: Railway (production)`);
  console.log(`\n${YLW}Pricing may change after beta — early founders locked in.${RST}`);
}

async function cmdCredits() {
  const cfg = loadConfig();
  const apiKey = cfg.apiKey || process.env.TEOS_API_KEY || null;

  if (apiKey) {
    try {
      const res = await fetchWithTimeout(`${BRIDGE_URL}/tier`, {
        headers: { 'x-teos-api-key': apiKey },
      }, 5000);
      if (res.ok) {
        const t = await res.json();
        console.log(`${GRN}Authenticated${RST}`);
        console.log(`  Tier:    ${t.label || t.tier}`);
        console.log(`  Credits: ${t.credits}`);
        if (t.dailyLimit) console.log(`  Daily:   ${t.dailyLimit}/day`);
      } else {
        console.log(`${GRN}Authenticated${RST}`);
        console.log(`  Key: ${apiKey.slice(0, 12)}...`);
      }
    } catch {
      console.log(`${GRN}Authenticated${RST}`);
      console.log(`  Key: ${apiKey.slice(0, 12)}... (bridge unreachable)`);
    }
  } else {
    console.log(`${YLW}No API key configured${RST}`);
    console.log(`  ${CYN}Register:${RST} teos login <email>`);
  }
  console.log(`\n${YLW}Pricing may change after beta — early founders locked in at current terms.${RST}`);
}

async function cmdLogin(args) {
  const input = (args[0] || '').trim();
  if (!input) {
    console.error(`${RED}Usage:${RST}`);
    console.error(`  ${CYN}teos login <email>${RST}     Register new account (free tier)`);
    console.error(`  ${CYN}teos login <api-key>${RST}   Save existing API key`);
    console.error(`  ${CYN}teos login --key <key>${RST} Save existing API key (explicit)`);
    process.exit(1);
  }

  const isEmail = input.includes('@');
  if (isEmail) {
    try {
      console.log(`${CYN} Registering with ${input}...${RST}`);
      const res = await fetch(`${IDENTITY_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Identity error (${res.status}): ${text.slice(0, 100)}`);
      }
      const data = await res.json();
      const cfg = loadConfig();
      cfg.apiKey = data.api_key;
      saveConfig(cfg);
      console.log(`${GRN}Registered! API key saved to ${CONFIG_PATH}${RST}`);
      console.log(`  ${GRN}Tier: ${data.tier} | Credits: ${data.credits_remaining}${RST}`);
      return;
    } catch (err) {
      console.error(`${RED}Registration failed: ${err.message}${RST}`);
      process.exit(1);
    }
  }

  const key = input.startsWith('teos_') || args[0] === '--key' ? (args[0] === '--key' ? (args[1] || '').trim() : input) : input;
  if (!key) {
    console.error(`${RED}Invalid API key format${RST}`);
    process.exit(1);
  }
  const cfg = loadConfig();
  cfg.apiKey = key;
  saveConfig(cfg);
  console.log(`${GRN}API key saved to ${CONFIG_PATH}${RST}`);
}

function cmdLogout() {
  const cfg = loadConfig();
  cfg.apiKey = null;
  saveConfig(cfg);
  console.log(`${YLW}API key removed.${RST}`);
  console.log(`Register a new key: ${CYN}teos login <email>${RST}`);
}

function cmdDeploy() {
  console.log(`${BLD}TEOS Deployment${RST}\n`);
  console.log(`  ${GRN}git push${RST} \u2192 GitHub Actions \u2192 Railway auto-deploy`);
  console.log(`  No manual steps required.\n`);
  console.log(`  Services auto-deploy on push to main:`);
  console.log(`    bridge/          \u2192 Bridge Gateway`);
  console.log(`    identity/        \u2192 Identity Service`);
  console.log(`    services/bot/    \u2192 TEOS Bot`);
  console.log(`    services/activation/ \u2192 Activation`);
  console.log(`    services/engine/ \u2192 Risk Engine`);
  console.log(`    services/shield/ \u2192 Sentinel Shield`);
}

function cmdCi(args) {
  const { execSync } = require('child_process');
  const shieldDir = resolve(__dirname, 'services/teos-sentinel-shield');

  if (!existsSync(shieldDir)) {
    console.error(`${RED}Shield service not cloned (services/teos-sentinel-shield missing)${RST}`);
    process.exit(1);
  }

  const script = args.includes('--secret') || args.includes('-s') ? 'scripts/secret-scan.js' : 'scripts/sentinel.js';
  const scriptPath = resolve(shieldDir, script);

  if (!existsSync(scriptPath)) {
    console.error(`${RED}Script not found: ${script}${RST}`);
    process.exit(1);
  }

  const target = args.filter(a => !a.startsWith('-')).join(' ') || '.';
  try {
    execSync(`node ${scriptPath} ${target}`, { stdio: 'inherit', cwd: shieldDir });
  } catch {
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`${BLD}teos${RST} — TEOS Sovereign Security Stack CLI\n`);
  console.log(`  ${CYN}scan${RST} <file|"code">   Scan code via TEOS Bridge`);
  console.log(`  ${CYN}health${RST}               Check all service health endpoints`);
  console.log(`  ${CYN}status${RST}               Show account + service status`);
  console.log(`  ${CYN}credits${RST}              Show credits / tier info`);
  console.log(`  ${CYN}login${RST} <email|key>    Register or save API key`);
  console.log(`  ${CYN}logout${RST}               Remove API key`);
  console.log(`  ${CYN}version${RST}              Show version info`);
  console.log(`  ${CYN}deploy${RST}               Show deployment instructions`);
  console.log(`  ${CYN}ci${RST} [--secret] <dir>   Run CI scanner\n`);
  console.log(`${BLD}Tiers:${RST}`);
  console.log(`  ${GRN}Free${RST}     5 scans/day (managed server-side)`);
  console.log(`  ${GRN}Pro${RST}      Unlimited scans`);
  console.log(`  ${GRN}Team${RST}     Team account`);
  console.log(`  ${GRN}Enterprise${RST} Custom deployment\n`);
  console.log(`Examples:`);
  console.log(`  teos login user@example.com  Register new account`);
  console.log(`  teos scan myscript.py`);
  console.log(`  cat deploy.sh | teos scan`);
  console.log(`  teos login teos_abc123...     Save existing key`);
  console.log(`  TEOS_API_KEY=teos_abc... teos scan file.py`);
  console.log(`  teos health`);
  console.log(`  teos credits`);
}

const cmd = process.argv[2] || 'help';
const rest = process.argv.slice(3);

const commands = { scan: cmdScan, health: cmdHealth, status: cmdStatus, credits: cmdCredits, login: cmdLogin, logout: cmdLogout, version: cmdVersion, deploy: cmdDeploy, ci: cmdCi, help: cmdHelp };

if (commands[cmd]) {
  commands[cmd](rest);
} else {
  console.error(`${RED}Unknown command: ${cmd}${RST}\n`);
  cmdHelp();
  process.exit(1);
}
