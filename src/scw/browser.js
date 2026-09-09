// browser.js — capa de acceso al SCW vía Playwright.
//
// Cada consulta (búsqueda o scraping de actuaciones) abre su propio
// BrowserContext aislado — no comparte cookies/sesión entre personas
// distintas, y se descarta apenas termina (el servicio no guarda estado).
//
// Concurrencia: el SCW no debería resentirse por esto (cada sesión headless
// es funcionalmente un usuario navegando a mano), pero limitamos igual la
// cantidad de sesiones simultáneas como resguardo — no porque lo necesitemos
// hoy, sino para no depender de que el uso real siempre sea bajo.

import { chromium } from 'playwright';

const SCW_BASE = 'https://scw.pjn.gov.ar';
const MAX_CONCURRENTES = 4;

let browserPromise = null;
let enCurso = 0;
const cola = [];

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

// Espera un lugar libre en la cola de concurrencia.
function pedirTurno() {
  if (enCurso < MAX_CONCURRENTES) {
    enCurso++;
    return Promise.resolve();
  }
  return new Promise((resolve) => cola.push(resolve));
}

function liberarTurno() {
  enCurso--;
  const siguiente = cola.shift();
  if (siguiente) {
    enCurso++;
    siguiente();
  }
}

// Ejecuta `fn(page)` dentro de un contexto de navegador propio, aislado,
// y lo cierra pase lo que pase. Este es el único punto de entrada al SCW
// que debería usar el resto del código.
export async function conPagina(fn) {
  await pedirTurno();
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'es-AR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 InfocivilEbook/1.0',
  });
  try {
    const page = await context.newPage();
    return await fn(page, SCW_BASE);
  } finally {
    await context.close().catch(() => {});
    liberarTurno();
  }
}

export async function cerrarBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

export { SCW_BASE };
