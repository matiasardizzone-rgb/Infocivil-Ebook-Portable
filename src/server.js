// src/server.js — Infocivil Ebook Portable (Versión Lector Institucional)
const express = require('express');
const fs = require('fs');
const path = require('path');
const { PATHS, ensureDirs } = require('./local/paths');
const storage = require('./local/storage');
const { withBrowser } = require('./scw/browserManager');
const { buscarExpediente } = require('./scw/buscarExpediente');
const { scrapeActuaciones } = require('./scw/scrapeActuaciones');
const { descargarPdfs } = require('./scw/descargarActuaciones');
const { prepararLectura, slugDe } = require('./scw/prepararLectura');
const { buildZip } = require('./lib/zip');
const { generarPdfUnificado } = require('./lib/unificador');

ensureDirs();

const app = express();
app.use(express.json());
app.use(express.static(PATHS.public));
app.use('/expedientes', express.static(PATHS.expedientes));

function sanitizar(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9,_ .()-]+/g, '').replace(/\s+/g, ' ').trim();
}

async function paramsDesdeStorage(cid) {
  const lista = await storage.list();
  const e = lista.find(x => x.id === cid);
  return (e && e.jurisdiccion && e.numero && e.anio)
    ? { jurisdiccion: e.jurisdiccion, numero: e.numero, anio: e.anio }
    : null;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: 3301, version: require(PATHS.version).version });
});

app.get('/api/jurisdicciones', (_req, res) => {
  try {
    const jur = require('./scw/jurisdicciones.js');
    const JURISDICCIONES = jur.JURISDICCIONES || jur.default || jur;
    let lista = (Array.isArray(JURISDICCIONES) ? JURISDICCIONES : []).map(j => ({
      value: j.value, sigla: j.sigla, nombre: j.nombre, codigo: j.sigla || j.value,
    }));
    const civIdx = lista.findIndex(j => j.sigla === 'CIV');
    if (civIdx > 0) { const [civ] = lista.splice(civIdx, 1); lista.unshift(civ); }
    res.json(lista);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/mis-expedientes', async (_req, res) => {
  res.json({ ok: true, data: await storage.list() });
});

app.delete('/api/mis-expedientes/:id', async (req, res) => {
  await storage.remove(req.params.id);
  res.json({ ok: true });
});

app.post('/api/buscar', async (req, res) => {
  console.log('[/api/buscar] Request:', JSON.stringify(req.body));
  try {
    const { jurisdiccion, numero, anio, incidente } = req.body;
    const result = await withBrowser(async (page, scwBase) => {
      const { cid } = await buscarExpediente(page, scwBase, { jurisdiccion, numero, anio, incidente });
      const data = await scrapeActuaciones(page, scwBase, cid);
      return { cid, ...data };
    });
    
    console.log('[/api/buscar] OK cid:', result.cid, '| actuaciones:', result.actuaciones?.length || 0);
    await storage.add({ id: result.cid, jurisdiccion, numero, anio, caratula: result.caratula || null });
    
    res.json({
      ok: true,
      sessionId: 'local',
      jurisdiccion,
      numero,
      anio,
      ...result,
    });
  } catch (e) {
    console.error('[/api/buscar] Error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// MEJORADO: Recuperación automática si el cid expiró
app.get('/api/expediente/:cid/actuaciones', async (req, res) => {
  try {
    console.log('[/api/actuaciones] cid:', req.params.cid);
    let data = await withBrowser((page, scwBase) => scrapeActuaciones(page, scwBase, req.params.cid));

    if (!data.actuaciones || data.actuaciones.length === 0) {
      console.log('[/api/actuaciones] 0 actuaciones, re-buscando con parámetros guardados...');
      const params = await paramsDesdeStorage(req.params.cid);
      if (params) {
        data = await withBrowser(async (page, scwBase) => {
          const result = await buscarExpediente(page, scwBase, params);
          console.log('[/api/actuaciones] Nuevo cid:', result.cid);
          // Actualizamos storage con el nuevo cid válido
          await storage.add({ id: result.cid, ...params, caratula: result.caratula || null });
          // OJO: aquí devolvemos las actuaciones del NUEVO cid
          return await scrapeActuaciones(page, scwBase, result.cid);
        });
      }
    }

    console.log('[/api/actuaciones] Actuaciones finales:', data.actuaciones?.length || 0);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error('[/api/actuaciones] Error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// MEJORADO: Descarga bajo demanda (On-Demand) para el lector
app.get('/api/expediente/:cid/documento/:n', async (req, res) => {
  try {
    const nro = Number(req.params.n);
    const params = await paramsDesdeStorage(req.params.cid);
    if (!params) return res.status(404).json({ ok: false, error: 'Expediente no encontrado' });
    
    const slug = slugDe(params);
    const ruta = path.join(PATHS.expedientes, slug, `act-${String(nro).padStart(3, '0')}.pdf`);

    // 1. Si está en caché: servir instantáneo
    if (fs.existsSync(ruta)) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.sendFile(ruta);
    }

    // 2. Si NO está: bajar del SCW ahora mismo, guardar y servir
    console.log(`[/api/documento] Act ${nro} no está en caché. Bajando del SCW...`);
    
    const bytes = await withBrowser(async (page, scwBase) => {
      // Necesitamos la lista de actuaciones para tener la URL del PDF específico
      // Usamos el cid actual (que podría ser viejo, pero intentamos)
      let data = await scrapeActuaciones(page, scwBase, req.params.cid);
      
      // Si falló por cid viejo, re-buscamos (lógica simplificada para on-demand)
      if (!data.actuaciones || !data.actuaciones.length) {
         const resBusq = await buscarExpediente(page, scwBase, params);
         data = await scrapeActuaciones(page, scwBase, resBusq.cid);
      }

      const act = (data.actuaciones || []).find(a => a.numero === nro);
      if (!act) return null;

      const [conBytes] = await descargarPdfs(page, [act]);
      return (conBytes && conBytes.bytes) ? Buffer.from(conBytes.bytes) : null;
    });

    if (!bytes) return res.status(404).json({ ok: false, error: 'No se pudo descargar el documento del SCW' });

    // Guardar en caché para la próxima vez
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, bytes);
    
    console.log(`[/api/documento] Act ${nro} descargada y cacheada.`);
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(ruta);

  } catch (e) {
    console.error('[/api/documento] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/expediente/:cid/leer', async (req, res) => {
  try {
    const params = await paramsDesdeStorage(req.params.cid);
    if (!params) return res.status(404).json({ ok: false, error: 'El expediente no está en Mis Expedientes' });
    const manifest = await prepararLectura(params, { forzar: req.query.refrescar === '1' });
    res.json({ ok: true, ...manifest });
  } catch (e) {
    console.error('[/api/leer] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/expediente/:cid/descargar/zip', async (req, res) => {
  console.log('[/api/zip] inicio cid:', req.params.cid);
  try {
    const zipBuf = await withBrowser(async (page, scwBase) => {
      const data = await scrapeActuaciones(page, scwBase, req.params.cid);
      const conBytes = await descargarPdfs(page, data.actuaciones);
      const ok = conBytes.filter(a => a && a.bytes);
      const files = ok.map(a => ({ name: `${String(a.numero).padStart(4, '0')}.pdf`, data: a.bytes }));
      files.unshift({ name: '0000 - caratula.txt', data: Buffer.from(`Expediente: ${data.caratula || ''}\n`) });
      return { buf: buildZip(files), nombre: `expediente-${req.params.cid}` };
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizar(zipBuf.nombre)}.zip"`);
    res.end(zipBuf.buf);
  } catch (e) {
    console.error('[/api/zip] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/expediente/:cid/descargar/:formato', async (req, res) => {
  try {
    const formato = req.params.formato;
    if (formato !== 'unificado' && formato !== 'unificado-indice') {
      return res.status(400).json({ ok: false, error: `Formato desconocido: ${formato}` });
    }
    const modo = formato === 'unificado-indice' ? 'completo' : 'simple';
    const resultado = await withBrowser(async (page, scwBase) => {
      const data = await scrapeActuaciones(page, scwBase, req.params.cid);
      const conBytes = await descargarPdfs(page, data.actuaciones);
      const buf = await generarPdfUnificado({
        tituloExpediente: data.caratula, actuaciones: conBytes, modo,
      });
      return { buf, nombre: `expediente-${req.params.cid}` };
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizar(resultado.nombre)}.pdf"`);
    res.end(Buffer.from(resultado.buf));
  } catch (e) {
    console.error('[/api/pdf] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = 3301;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[infocivil] escuchando en http://127.0.0.1:${PORT}`);
  console.log(`[infocivil] raíz portable: ${PATHS.root}`);
});

process.on('SIGINT', async () => {
  const { close } = require('./scw/browserManager');
  await close();
  process.exit(0);
});