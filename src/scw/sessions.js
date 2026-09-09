// sessions.js — sesiones de navegador que sobreviven entre requests HTTP,
// para el flujo buscar → ver actuaciones → descargar dentro de la misma
// visita de una persona.
//
// Por qué hace falta esto: el SCW (JSF/Seam) ata la búsqueda a una
// conversación de servidor identificada por el propio `cid` — no alcanza
// con "saber el cid", hay que llegar a él con las mismas cookies de la
// sesión que lo generó. Si cada request abre un contexto de Playwright
// nuevo (sin esas cookies), el SCW no reconoce la conversación.
//
// Nada de esto persiste en disco ni sobrevive un reinicio del proceso — es
// un Map en memoria con expiración por inactividad. Coherente con que el
// servicio no guarda expedientes de nadie.

import { abrirSesion } from './browser.js';

const TTL_MS = 15 * 60 * 1000; // 15 minutos de inactividad
const LIMPIEZA_INTERVALO_MS = 60 * 1000;

const sesiones = new Map(); // sessionId -> { page, scwBase, cid, cerrar, vencePero }

function generarId() {
  return crypto.randomUUID();
}

export async function crearSesion() {
  const { page, scwBase, cerrar } = await abrirSesion();
  const id = generarId();
  sesiones.set(id, { page, scwBase, cid: null, cerrar, vencePero: Date.now() + TTL_MS });
  return { id, page, scwBase };
}

export function obtenerSesion(id) {
  const s = sesiones.get(id);
  if (!s) return null;
  s.vencePero = Date.now() + TTL_MS; // tocar la sesión renueva el TTL
  return s;
}

export function asociarCid(id, cid) {
  const s = sesiones.get(id);
  if (s) s.cid = cid;
}

// Guarda el resultado del scrapeo en la sesión para no repetirlo.
//
// Además de evitar trabajo duplicado (recorrer 200+ actuaciones de nuevo),
// esto corrige un bug real: el segundo scrapeo se hacía sobre la misma
// página del navegador, que para entonces ya había quedado en
// actuacionesHistoricas.seam, y volver a expediente.seam con el mismo cid
// no siempre reconstruye el estado correcto — devolvía apenas un puñado de
// actuaciones en vez de todas.
export function guardarScrape(id, cid, resultado) {
  const s = sesiones.get(id);
  if (s) s.scrape = { cid, resultado };
}

export function obtenerScrape(id, cid) {
  const s = sesiones.get(id);
  if (s && s.scrape && s.scrape.cid === cid) return s.scrape.resultado;
  return null;
}

export async function cerrarSesion(id) {
  const s = sesiones.get(id);
  if (!s) return;
  sesiones.delete(id);
  await s.cerrar().catch(() => {});
}

async function limpiarVencidas() {
  const ahora = Date.now();
  for (const [id, s] of sesiones) {
    if (s.vencePero < ahora) {
      sesiones.delete(id);
      await s.cerrar().catch(() => {});
    }
  }
}

setInterval(limpiarVencidas, LIMPIEZA_INTERVALO_MS).unref();

export async function cerrarTodasLasSesiones() {
  const ids = [...sesiones.keys()];
  await Promise.all(ids.map((id) => cerrarSesion(id)));
}
