// src/scw/prepararLectura.js
// Prepara un expediente para el lector: en UNA sesión de Playwright busca,
// scrapea y descarga los PDFs, y los deja cacheados en expedientes/<slug>/
// junto con un manifest.json. El lector después trabaja 100% offline.
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { PATHS } = require('../local/paths');
const { withBrowser } = require('./browserManager');
const { buscarExpediente } = require('./buscarExpediente');
const { scrapeActuaciones } = require('./scrapeActuaciones');
const { descargarActuaciones } = require('./descargarActuaciones');

function slugDe(params) {
  return `${params.jurisdiccion}-${params.numero}-${params.anio}`.replace(/[^\w-]+/g, '_');
}
function dirDe(slug) { return path.join(PATHS.expedientes, slug); }
function manifestPath(slug) { return path.join(dirDe(slug), 'manifest.json'); }

// Un manifest solo es usable si están TODOS los PDFs que referencia en disco
function manifestValido(m) {
  if (!m || !Array.isArray(m.actuaciones) || !m.id) return false;
  const dir = dirDe(m.id);
  for (const a of m.actuaciones) {
    if (a.archivo && !fs.existsSync(path.join(dir, a.archivo))) return false;
  }
  return true;
}

function leerManifest(slug) {
  try {
    const p = manifestPath(slug);
    if (fs.existsSync(p)) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (manifestValido(m)) return m;
      console.warn('[prepararLectura] manifest incompleto (faltan PDFs en disco): re-preparo');
    }
  } catch (e) {
    console.error('[prepararLectura] manifest corrupto:', e.message);
  }
  return null;
}

async function prepararLectura(params, { forzar = false } = {}) {
  const slug = slugDe(params);
  console.log('[prepararLectura] pedido:', slug, forzar ? '(forzado)' : '');
  if (!forzar) {
    const m = leerManifest(slug);
    if (m) {
      console.log('[prepararLectura] desde caché:', slug, '| actuaciones:', m.actuaciones.length);
      return m;
    }
  }
  fs.mkdirSync(dirDe(slug), { recursive: true });

  return withBrowser(async ctx => {
    console.log('[prepararLectura] buscando en SCW…');
    const { cid } = await buscarExpediente(ctx, params);
    console.log('[prepararLectura] cid:', cid, '| scrapeando actuaciones…');
    const data = await scrapeActuaciones(ctx, cid);
    console.log('[prepararLectura] actuaciones:', data.actuaciones.length, '| descargando PDFs…');
    const conBytes = await descargarActuaciones(ctx, data, cid);

    const acts = [];
    for (const a of conBytes) {
      const nombre = `act-${String(a.numero).padStart(3, '0')}.pdf`;
      let paginas = 0;
      if (a.bytes) {
        fs.writeFileSync(path.join(dirDe(slug), nombre), a.bytes);
        try {
          const doc = await PDFDocument.load(a.bytes, { ignoreEncryption: true });
          paginas = doc.getPageCount();
        } catch { paginas = 0; }
      }
      acts.push({
        numero: a.numero, fecha: a.fecha, tipo: a.tipo, descripcion: a.descripcion,
        foja: a.foja, paginas, archivo: a.bytes ? nombre : null,
        urlPublica: a.urlPublica, error: a.bytes ? null : (a.error || 'no disponible'),
      });
    }

    const manifest = {
      id: slug, cid,
      jurisdiccion: params.jurisdiccion, numero: params.numero, anio: params.anio,
      caratula: data.caratula,
      generado: new Date().toISOString(),
      historicasEstado: data.historicasEstado,
      paginacionIncompleta: data.paginacionIncompleta,
      actuaciones: acts,
    };
    fs.writeFileSync(manifestPath(slug), JSON.stringify(manifest, null, 2));
    console.log('[prepararLectura] listo:', slug, '| actuaciones:', acts.length,
      '| páginas totales:', acts.reduce((s, a) => s + a.paginas, 0));
    return manifest;
  });
}

module.exports = { prepararLectura, leerManifest, slugDe };