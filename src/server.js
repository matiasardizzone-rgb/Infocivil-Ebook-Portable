// server.js — punto de entrada del servicio.
//
// El flujo buscar → actuaciones → descargar reusa la MISMA sesión de
// Playwright (ver scw/sessions.js) — el SCW ata la búsqueda a una
// conversación de servidor identificada por el propio cid, así que hace
// falta llegar con las mismas cookies que la generaron, no alcanza con
// "saber el cid". La sesión expira sola a los 15 min de inactividad; nada
// de esto se guarda en disco. "Mis Expedientes" vive enteramente en el
// navegador de la persona (localStorage), no acá.
//
// Nota: no hace falta el paquete express-async-errors — Express 5 ya
// reenvía nativamente las promesas rechazadas de un handler async al
// middleware de errores (a diferencia de Express 4, donde sí hacía falta).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cerrarBrowser } from './scw/browser.js';
import { crearSesion, obtenerSesion, asociarCid, cerrarSesion, cerrarTodasLasSesiones, guardarScrape, obtenerScrape } from './scw/sessions.js';
import { buscarExpediente } from './scw/buscarExpediente.js';
import { scrapeActuaciones } from './scw/scrapeActuaciones.js';
import { descargarPdfs } from './scw/descargarActuaciones.js';
import { generarPdfUnificado } from './lib/unificador.js';
import { buildZip } from './lib/zip.js';
import { JURISDICCIONES } from './scw/jurisdicciones.js';
import { registrar, ipDe, diasDisponibles, leerDia } from './lib/auditoria.js';
import {
  hayAdmins, listarAdmins, crearAdmin, eliminarAdmin, cambiarContrasena,
  verificar, crearSesion as crearSesionAdmin, usuarioDeSesion, cerrarSesion as cerrarSesionAdmin,
  leerCookie, nombreReal,
} from './lib/admins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
// Los archivos del front no se cachean: durante el desarrollo el navegador
// se quedaba con versiones viejas del HTML/JS aun forzando la recarga, lo
// que hacía parecer que los cambios no se habían desplegado. Las descargas
// de documentos sí llevan su propio Cache-Control (ver más abajo), que es
// donde el caché realmente aporta.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store');
  },
}));

function sanitizarNombre(texto) {
  return String(texto || 'expediente').replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Helper: busca la sesión por el sessionId de la query string y devuelve un
// 410 claro si no existe/venció, en vez de un error genérico más abajo.
function requerirSesion(req, res) {
  const { sessionId } = req.query;
  if (!sessionId) {
    res.status(400).json({ ok: false, error: 'Falta sessionId — hay que buscar el expediente primero (POST /api/buscar).' });
    return null;
  }
  const s = obtenerSesion(sessionId);
  if (!s) {
    res.status(410).json({ ok: false, error: 'La sesión expiró o no existe. Volvé a buscar el expediente.' });
    return null;
  }
  return s;
}

// ─── Jurisdicciones (para poblar el <select> del front sin duplicar la lista) ───
app.get('/api/jurisdicciones', (req, res) => {
  res.json(JURISDICCIONES.map(({ value, sigla, nombre }) => ({ value, sigla, nombre })));
});

// ─── Búsqueda — abre la sesión que el resto de los pasos va a reusar ───────
app.post('/api/buscar', async (req, res) => {
  const { jurisdiccion, numero, anio } = req.body || {};
  if (!jurisdiccion || !numero || !anio) {
    return res.status(400).json({ ok: false, error: 'Faltan jurisdiccion, numero o anio.' });
  }

  const { id: sessionId, page, scwBase } = await crearSesion();
  try {
    const { cid, multiplesResultados } = await buscarExpediente(page, scwBase, { jurisdiccion, numero, anio });
    asociarCid(sessionId, cid);
    registrar({
      operacion: 'buscar',
      expediente: `${jurisdiccion} ${numero}/${anio}`,
      cid,
      ip: ipDe(req),
    });
    res.json({ ok: true, cid, sessionId, multiplesResultados });
  } catch (err) {
    await cerrarSesion(sessionId);
    registrar({
      operacion: 'buscar-fallida',
      expediente: `${jurisdiccion} ${numero}/${anio}`,
      ip: ipDe(req),
      detalle: { error: err.message },
    });
    throw err;
  }
});

// ─── Actuaciones de un expediente ya localizado ───────────────────────────
// GET /api/expediente/:cid/actuaciones?sessionId=...
//
// El scrapeo se hace UNA SOLA VEZ por sesión y expediente: repetirlo sobre
// la misma sesión devuelve resultados incompletos (comprobado: primera
// consulta 205 actuaciones, segunda sobre la misma sesión apenas 5). La
// causa es que tras recorrer las históricas la página queda en
// actuacionesHistoricas.seam, y volver a expediente.seam con un cid ya
// consumido no reconstruye el estado completo.
// Para volver a scrapear de verdad (ej. para detectar actuaciones nuevas),
// hay que abrir una sesión nueva con POST /api/buscar.
app.get('/api/expediente/:cid/actuaciones', async (req, res) => {
  const { cid } = req.params;
  const s = requerirSesion(req, res);
  if (!s) return;

  const cacheado = obtenerScrape(req.query.sessionId, cid);
  if (cacheado) {
    return res.json({ ok: true, cid, ...cacheado, desdeCache: true });
  }

  const resultado = await scrapeActuaciones(s.page, s.scwBase, cid);
  guardarScrape(req.query.sessionId, cid, resultado);
  registrar({
    operacion: 'leer-actuaciones',
    expediente: resultado.caratula ? resultado.caratula.slice(0, 80) : null,
    cid,
    ip: ipDe(req),
    detalle: { cantidad: resultado.actuaciones.length },
  });
  res.json({ ok: true, cid, ...resultado });
});

// ─── Descargas ─────────────────────────────────────────────────────────────
// GET /api/expediente/:cid/descargar/:formato?sessionId=...
// Los tres formatos (zip / unificado / unificado con índice) comparten el
// mismo scraping + descarga; lo único que cambia es qué se hace con los
// bytes al final.
app.get('/api/expediente/:cid/descargar/:formato', async (req, res) => {
  const { cid, formato } = req.params;
  const formatosValidos = new Set(['zip', 'unificado', 'unificado-indice']);
  if (!formatosValidos.has(formato)) {
    return res.status(400).json({ ok: false, error: `Formato desconocido: ${formato}` });
  }
  const s = requerirSesion(req, res);
  if (!s) return;

  // Reusar el scrapeo de esta misma sesión si ya se hizo (el flujo normal
  // del front es buscar → ver actuaciones → descargar, así que casi siempre
  // está). Volver a scrapear acá no solo duplicaba trabajo: fallaba, porque
  // la página del navegador ya había quedado en actuacionesHistoricas.seam
  // y el segundo recorrido traía apenas un puñado de actuaciones.
  let resultado = obtenerScrape(req.query.sessionId, cid);
  if (!resultado) {
    resultado = await scrapeActuaciones(s.page, s.scwBase, cid);
    guardarScrape(req.query.sessionId, cid, resultado);
  }
  const { actuaciones, paginacionIncompleta, caratula } = resultado;
  if (!actuaciones.length) {
    return res.status(404).json({ ok: false, error: 'No se encontraron actuaciones para este expediente.' });
  }

  const tituloExpediente = caratula || `Expediente ${cid}`;
  const nombreBase = sanitizarNombre(tituloExpediente).slice(0, 60);
  const conBytes = await descargarPdfs(s.page, actuaciones);
  const bajados = conBytes.filter(a => a.bytes).length;

  registrar({
    operacion: 'descargar-' + formato,
    expediente: tituloExpediente.slice(0, 80),
    cid,
    ip: ipDe(req),
    detalle: { actuaciones: conBytes.length, obtenidas: bajados, faltantes: conBytes.length - bajados },
  });

  if (formato === 'zip') {
    const entradas = conBytes
      .filter((a) => a.bytes)
      .map((a, i) => ({
        name: `${String(i + 1).padStart(3, '0')} - ${sanitizarNombre(a.tipo || a.titulo || 'documento').slice(0, 80)}.pdf`,
        data: a.bytes,
      }));
    const faltantes = conBytes.length - entradas.length;
    const zipBytes = buildZip(entradas);

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${nombreBase}.zip"`,
      'X-Documentos-Totales': String(conBytes.length),
      'X-Documentos-Faltantes': String(faltantes),
    });
    return res.send(zipBytes);
  }

  const conIndice = formato === 'unificado-indice';
  const pdfBytes = await generarPdfUnificado({
    tituloExpediente,
    actuaciones: conBytes,
    historicasFaltantes: false, // no aplica acá — siempre las visitamos
    paginacionIncompleta,
    modo: conIndice ? 'completo' : 'simple',
  });

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${nombreBase}${conIndice ? '-indice' : ''}.pdf"`,
  });
  res.send(Buffer.from(pdfBytes));
});

// ─── Documento suelto (para el lector tipo libro) ─────────────────────────
// GET /api/expediente/:cid/documento/:indice?sessionId=...
//
// Sirve el PDF de UNA actuación, para que el lector cargue de a poco en vez
// de bajar el expediente entero de entrada. El índice es la posición dentro
// de la lista devuelta por /actuaciones (1-based, igual que el campo
// 'numero' de cada actuación).
app.get('/api/expediente/:cid/documento/:indice', async (req, res) => {
  const { cid, indice } = req.params;
  const s = requerirSesion(req, res);
  if (!s) return;

  const scrape = obtenerScrape(req.query.sessionId, cid);
  if (!scrape) {
    return res.status(409).json({
      ok: false,
      error: 'Todavía no se leyeron las actuaciones de este expediente en esta sesión.',
    });
  }

  const n = Number(indice);
  const actuacion = scrape.actuaciones[n - 1];
  if (!actuacion) {
    return res.status(404).json({ ok: false, error: `No existe la actuación ${indice}.` });
  }

  const [conBytes] = await descargarPdfs(s.page, [actuacion], 1);
  if (!conBytes.bytes) {
    return res.status(502).json({
      ok: false,
      error: conBytes.error || 'No se pudo descargar el documento desde el SCW.',
    });
  }

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline',
    // El documento no cambia dentro de la vida de la sesión, así que
    // cachearlo evita volver a pedírselo al SCW si el lector retrocede.
    'Cache-Control': 'private, max-age=900',
  });
  res.send(Buffer.from(conBytes.bytes));
});

// Cerrar la sesión explícitamente (ej: la persona se va del sitio) — no es
// obligatorio llamarlo, la sesión expira sola, pero libera recursos antes.
app.delete('/api/sesion/:sessionId', async (req, res) => {
  await cerrarSesion(req.params.sessionId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
// PANEL DE AUDITORÍA
// ═══════════════════════════════════════════════════════════════════════

const COOKIE_SESION = 'infocivil_admin';

function adminActual(req) {
  return usuarioDeSesion(leerCookie(req, COOKIE_SESION) || '');
}

function requerirAdmin(req, res) {
  const usuario = adminActual(req);
  if (!usuario) {
    res.status(401).json({ ok: false, error: 'Sesión no iniciada.' });
    return null;
  }
  return usuario;
}

// Estado inicial: si no hay ningún administrador, el panel ofrece crear el
// primero. Así no hay ninguna contraseña por defecto ni escrita en el
// repositorio o en la configuración del servicio.
app.get('/api/admin/estado', (req, res) => {
  res.json({
    ok: true,
    inicializado: hayAdmins(),
    usuario: adminActual(req),
  });
});

app.post('/api/admin/inicializar', (req, res) => {
  if (hayAdmins()) {
    return res.status(409).json({ ok: false, error: 'El panel ya tiene administradores.' });
  }
  const { usuario, contrasena } = req.body || {};
  try {
    crearAdmin(usuario, contrasena, 'instalación inicial');
    registrar({ operacion: 'admin-inicializar', ip: ipDe(req), usuario });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/ingresar', (req, res) => {
  const { usuario, contrasena } = req.body || {};
  if (!verificar(usuario, contrasena)) {
    registrar({ operacion: 'admin-ingreso-fallido', ip: ipDe(req), usuario: String(usuario || '') });
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
  }
  const token = crearSesionAdmin(nombreReal(usuario) || String(usuario).trim());
  res.set('Set-Cookie', `${COOKIE_SESION}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 60 * 60}`);
  registrar({ operacion: 'admin-ingreso', ip: ipDe(req), usuario });
  res.json({ ok: true, usuario });
});

app.post('/api/admin/salir', (req, res) => {
  const token = leerCookie(req, COOKIE_SESION);
  if (token) cerrarSesionAdmin(token);
  res.set('Set-Cookie', `${COOKIE_SESION}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/auditoria', async (req, res) => {
  if (!requerirAdmin(req, res)) return;
  const dias = diasDisponibles();
  const dia = req.query.dia || dias[0];
  if (!dia) return res.json({ ok: true, dias: [], dia: null, entradas: [] });
  const entradas = await leerDia(dia, { texto: req.query.q || '', limite: 1000 });
  res.json({ ok: true, dias, dia, entradas });
});

app.get('/api/admin/admins', (req, res) => {
  if (!requerirAdmin(req, res)) return;
  res.json({ ok: true, admins: listarAdmins() });
});

app.post('/api/admin/admins', (req, res) => {
  const yo = requerirAdmin(req, res);
  if (!yo) return;
  const { usuario, contrasena } = req.body || {};
  try {
    crearAdmin(usuario, contrasena, yo);
    registrar({ operacion: 'admin-crear', ip: ipDe(req), usuario: yo, detalle: { nuevo: usuario } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/admins/:usuario', (req, res) => {
  const yo = requerirAdmin(req, res);
  if (!yo) return;
  try {
    eliminarAdmin(req.params.usuario);
    registrar({ operacion: 'admin-eliminar', ip: ipDe(req), usuario: yo, detalle: { eliminado: req.params.usuario } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/contrasena', (req, res) => {
  const yo = requerirAdmin(req, res);
  if (!yo) return;
  const { actual, nueva } = req.body || {};
  if (!verificar(yo, actual)) {
    return res.status(401).json({ ok: false, error: 'La contraseña actual no es correcta.' });
  }
  try {
    cambiarContrasena(yo, nueva);
    registrar({ operacion: 'admin-cambio-contrasena', ip: ipDe(req), usuario: yo });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── Manejo de errores ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[infocivil-ebook]', err);
  res.status(500).json({ ok: false, error: err.message || 'Error interno.' });
});

const PORT = process.env.PORT || 3300;
const server = app.listen(PORT, () => {
  console.log(`infocivil-ebook escuchando en :${PORT}`);
});

async function apagar() {
  console.log('Cerrando...');
  server.close();
  await cerrarTodasLasSesiones();
  await cerrarBrowser();
  process.exit(0);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
