// browser.js — capa de acceso al SCW vía Playwright.
//
// Dos formas de usar el navegador:
//   - conPagina(fn): sesión efímera, para operaciones de un solo paso que
//     no necesitan sobrevivir entre requests HTTP.
//   - abrirSesion(): sesión que el que llama debe cerrar explícitamente,
//     para flujos de varios pasos (buscar → actuaciones → descargar) que
//     necesitan preservar las MISMAS cookies del SCW durante todo el
//     recorrido — ver sessions.js.
//
// En los dos casos, cada sesión es un BrowserContext propio y aislado — no
// comparte cookies entre personas distintas, y no se guarda nada del lado
// del servidor más allá de lo que dure la sesión.
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
// y lo cierra pase lo que pase. Este es el punto de entrada para trabajo
// que no necesita sobrevivir entre requests (ej: solo consultar
// jurisdicciones, o cualquier operación de un solo paso).
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

// Abre un contexto de navegador que NO se cierra solo — para flujos que
// abarcan varios requests HTTP (buscar → ver actuaciones → descargar) y
// necesitan preservar la MISMA sesión/cookies del SCW durante todo el
// recorrido. Ver sessions.js para el manejo del ciclo de vida completo.
// El que llama a esto es responsable de cerrar el contexto cuando termine
// (o dejar que sessions.js lo expire).
export async function abrirSesion() {
  await pedirTurno();
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'es-AR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 InfocivilEbook/1.0',
  });
  const page = await context.newPage();
  let liberado = false;
  const cerrar = async () => {
    if (liberado) return;
    liberado = true;
    await context.close().catch(() => {});
    liberarTurno();
  };
  return { page, scwBase: SCW_BASE, cerrar };
}

export async function cerrarBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

export { SCW_BASE };
