// server.js — punto de entrada del servicio.
//
// Sin estado: cada request abre su propia sesión de Playwright (ver
// scw/browser.js), scrapea lo que necesita, arma la respuesta y no guarda
// nada. "Mis Expedientes" vive enteramente en el navegador de la persona
// (localStorage/IndexedDB), no acá.
//
// Nota: no hace falta el paquete express-async-errors — Express 5 ya
// reenvía nativamente las promesas rechazadas de un handler async al
// middleware de errores (a diferencia de Express 4, donde sí hacía falta).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { conPagina, cerrarBrowser } from './scw/browser.js';
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

// ─── Jurisdicciones (para poblar el <select> del front sin duplicar la lista) ───
app.get('/api/jurisdicciones', (req, res) => {
  res.json(JURISDICCIONES.map(({ value, sigla, nombre }) => ({ value, sigla, nombre })));
});

// ─── Búsqueda ────────────────────────────────────────────────────────────
app.post('/api/buscar', async (req, res) => {
  const { jurisdiccion, numero, anio } = req.body || {};
  if (!jurisdiccion || !numero || !anio) {
    return res.status(400).json({ ok: false, error: 'Faltan jurisdiccion, numero o anio.' });
  }

  const resultado = await conPagina(async (page, scwBase) => {
    const { cid, multiplesResultados } = await buscarExpediente(page, scwBase, {
      jurisdiccion,
      numero,
      anio,
    });
    return { cid, multiplesResultados };
  });

  res.json({ ok: true, ...resultado });
});

// ─── Actuaciones de un expediente ya localizado ───────────────────────────
app.get('/api/expediente/:cid/actuaciones', async (req, res) => {
  const { cid } = req.params;

  const resultado = await conPagina(async (page, scwBase) => {
    return scrapeActuaciones(page, scwBase, cid);
  });

  res.json({ ok: true, cid, ...resultado });
});

// ─── Descargas ─────────────────────────────────────────────────────────────
// Los tres formatos (zip / unificado / unificado con índice) comparten el
// mismo scraping + descarga; lo único que cambia es qué se hace con los
// bytes al final. Por eso una sola sesión de Playwright cubre todo el
// pedido, en vez de reabrir una por cada cosa.

function sanitizarNombre(texto) {
  return String(texto || 'expediente').replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

app.get('/api/expediente/:cid/descargar/:formato', async (req, res) => {
  const { cid, formato } = req.params;
  const formatosValidos = new Set(['zip', 'unificado', 'unificado-indice']);
  if (!formatosValidos.has(formato)) {
    return res.status(400).json({ ok: false, error: `Formato desconocido: ${formato}` });
  }

  await conPagina(async (page, scwBase) => {
    const { actuaciones, paginacionIncompleta, caratula } = await scrapeActuaciones(page, scwBase, cid);
    if (!actuaciones.length) {
      res.status(404).json({ ok: false, error: 'No se encontraron actuaciones para este expediente.' });
      return;
    }

    const tituloExpediente = caratula || `Expediente ${cid}`;
    const nombreBase = sanitizarNombre(tituloExpediente).slice(0, 60);
    const conBytes = await descargarPdfs(page, actuaciones);

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
      res.send(zipBytes);
      return;
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
  await cerrarBrowser();
  process.exit(0);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
