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
import { crearSesion, obtenerSesion, asociarCid, cerrarSesion, cerrarTodasLasSesiones } from './scw/sessions.js';
import { buscarExpediente } from './scw/buscarExpediente.js';
import { scrapeActuaciones } from './scw/scrapeActuaciones.js';
import { descargarPdfs } from './scw/descargarActuaciones.js';
import { generarPdfUnificado } from './lib/unificador.js';
import { buildZip } from './lib/zip.js';
import { JURISDICCIONES } from './scw/jurisdicciones.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    res.json({ ok: true, cid, sessionId, multiplesResultados });
  } catch (err) {
    await cerrarSesion(sessionId);
    throw err;
  }
});

// ─── Actuaciones de un expediente ya localizado ───────────────────────────
// GET /api/expediente/:cid/actuaciones?sessionId=...
app.get('/api/expediente/:cid/actuaciones', async (req, res) => {
  const { cid } = req.params;
  const s = requerirSesion(req, res);
  if (!s) return;

  const resultado = await scrapeActuaciones(s.page, s.scwBase, cid);
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

  const { actuaciones, paginacionIncompleta, caratula } = await scrapeActuaciones(s.page, s.scwBase, cid);
  if (!actuaciones.length) {
    return res.status(404).json({ ok: false, error: 'No se encontraron actuaciones para este expediente.' });
  }

  const tituloExpediente = caratula || `Expediente ${cid}`;
  const nombreBase = sanitizarNombre(tituloExpediente).slice(0, 60);
  const conBytes = await descargarPdfs(s.page, actuaciones);

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

// Cerrar la sesión explícitamente (ej: la persona se va del sitio) — no es
// obligatorio llamarlo, la sesión expira sola, pero libera recursos antes.
app.delete('/api/sesion/:sessionId', async (req, res) => {
  await cerrarSesion(req.params.sessionId);
  res.json({ ok: true });
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
