// src/scw/browserManager.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

let browser = null;
let busy = false;

const CANDIDATES = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function launch() {
  if (browser) return browser;
  const execPath = findBrowser();
  if (!execPath) {
    throw new Error('No se encontró Chrome ni Edge. Instalá alguno de los dos para usar Infocivil.');
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--disable-extensions'],
  });
  browser.on('disconnected', () => { browser = null; });
  console.log('[browser] usando:', execPath);
  return browser;
}

async function withBrowser(fn) {
  if (busy) {
    throw new Error('Ya hay una operación en curso. Esperá a que termine.');
  }
  busy = true;
  const br = await launch();
  const context = await br.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-AR',
  });
  try {
    const page = await context.newPage();
    // Pasamos page y scwBase para que coincida con la firma de las funciones de scraping
    return await fn(page, 'https://scw.pjn.gov.ar');
  } finally {
    await context.close().catch(() => {});
    busy = false;
  }
}

async function close() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

module.exports = { withBrowser, close, findBrowser };