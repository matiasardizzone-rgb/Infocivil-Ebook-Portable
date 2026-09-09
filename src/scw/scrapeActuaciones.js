// scrapeActuaciones.js — recorre las actuaciones de un expediente (actuales
// e históricas) y devuelve la lista completa, con fecha/tipo/descripción
// separados y limpios de etiquetas de accesibilidad.
//
// Esto es un puerto de la lógica ya probada en la extensión PJN Descargador
// (content.js: recorrerTodasLasPaginas, scrapearPaginaActual, scrapearFilas,
// scrapeHistoricasDOMDirecto) — mismos selectores, mismo criterio de
// paginación y de reintento ante timeouts. La diferencia de fondo con la
// extensión: acá SIEMPRE visitamos actuacionesHistoricas.seam nosotros
// mismos (no depende de que la persona la haya visitado antes a mano), así
// que el aviso de "históricas faltantes" que tuvo que tener la extensión no
// aplica acá — en cambio si el timeout de paginación se corta antes de
// tiempo, sí devolvemos ese diagnóstico (paginacionIncompleta).

const SELECTOR_TABLA_ACTUALES = '#expediente\\:action-table tbody';

function limpiarEtiquetaAccesibilidad(texto) {
  return (texto || '')
    .replace(/^\s*(tipo\s+actuaci[oó]n|detalle|fecha)\s*:?\s*/i, '')
    .trim();
}

// ─── Actuaciones actuales ─────────────────────────────────────────────────

async function scrapearFilasActuales(page) {
  return page.evaluate(() => {
    const limpiar = (t) =>
      (t || '').replace(/^\s*(tipo\s+actuaci[oó]n|detalle|fecha)\s*:?\s*/i, '').trim();
    const extraer = (fila, sel) => {
      const el = fila.querySelector(sel);
      return el ? el.innerText.trim() : '';
    };
    const filas = Array.from(document.querySelectorAll('#expediente\\:action-table tbody tr'));
    const out = [];
    for (const fila of filas) {
      const link = fila.querySelector("a[href*='viewer']");
      if (!link) continue;
      let url = link.getAttribute('href');
      if (!url) continue;
      if (url.includes('/scw/viewer') && !url.includes('download=true')) {
        url += (url.includes('?') ? '&' : '?') + 'download=true';
      }
      // nth-child es 1-based: 3=fecha, 4=tipo, 5=descripcion, 6=fojas
      out.push({
        url,
        fecha: limpiar(extraer(fila, 'td:nth-child(3)')),
        tipo: limpiar(extraer(fila, 'td:nth-child(4)')),
        descripcion: limpiar(extraer(fila, 'td:nth-child(5)')),
        foja: extraer(fila, 'td:nth-child(6)'),
        esHistorica: false,
      });
    }
    return out;
  });
}

async function hayPaginaSiguienteActuales(page) {
  return page.evaluate(() => {
    const li = document.querySelector('li.active');
    if (!li) return false;
    const sib = li.nextElementSibling;
    const a = sib && sib.querySelector('a');
    const oc = (a && a.getAttribute('onclick')) || '';
    return oc.includes('RichFaces');
  });
}

async function clickSiguienteActuales(page) {
  await page.evaluate(() => {
    const li = document.querySelector('li.active');
    const a = li && li.nextElementSibling && li.nextElementSibling.querySelector('a');
    if (a) a.click();
  });
}

async function recorrerActuales(page) {
  const vistos = new Set();
  const out = [];
  let incompleta = false;
  let pagina = 1;

  while (true) {
    const filas = await scrapearFilasActuales(page);
    for (const f of filas) {
      if (!vistos.has(f.url)) {
        vistos.add(f.url);
        out.push(f);
      }
    }
    if (!(await hayPaginaSiguienteActuales(page))) break;

    const htmlAntes = await page.locator(SELECTOR_TABLA_ACTUALES).innerHTML().catch(() => '');
    await clickSiguienteActuales(page);
    let cambio = await esperarCambioHtml(page, SELECTOR_TABLA_ACTUALES, htmlAntes, 8000);
    if (!cambio) {
      // Igual que en la extensión: puede ser una respuesta lenta puntual,
      // reintentamos una vez con más margen antes de cortar.
      await clickSiguienteActuales(page);
      cambio = await esperarCambioHtml(page, SELECTOR_TABLA_ACTUALES, htmlAntes, 15000);
      if (!cambio) {
        incompleta = true;
        break;
      }
    }
    pagina++;
    if (pagina > 500) { incompleta = true; break; } // resguardo duro
  }
  return { filas: out, incompleta };
}

// ─── Actuaciones históricas ─────────────────────────────────────────────────

async function scrapearFilasHistoricas(page) {
  return page.evaluate(() => {
    const limpiar = (t) =>
      (t || '').replace(/^\s*(tipo\s+actuaci[oó]n|detalle|fecha)\s*:?\s*/i, '').trim();
    const filas = Array.from(document.querySelectorAll('tbody tr'));
    const out = [];
    for (const fila of filas) {
      const link = fila.querySelector("a[href*='viewer']");
      if (!link) continue;
      let url = link.getAttribute('href');
      if (!url) continue;
      if (url.includes('/scw/viewer') && !url.includes('download=true')) {
        url += (url.includes('?') ? '&' : '?') + 'download=true';
      }
      // Columnas: 0=botones, 1=oficina, 2=fecha, 3=tipo, 4=descripcion, 5=fojas
      const c = fila.querySelectorAll('td');
      out.push({
        url,
        fecha: limpiar((c[2] || {}).textContent || ''),
        tipo: limpiar((c[3] || {}).textContent || ''),
        descripcion: limpiar((c[4] || {}).textContent || ''),
        foja: (c[5] || {}).textContent || '',
        esHistorica: true,
      });
    }
    return out;
  });
}

async function esperarTablaHistoricasLista(page, timeoutMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const estado = await page.evaluate(() => {
      const sinHistoricas = Array.from(document.querySelectorAll('*')).some(
        (el) =>
          el.children.length === 0 &&
          (el.textContent || '').toLowerCase().includes('no posee actuaciones hist')
      );
      if (sinHistoricas) return 'vacio';
      const filas = document.querySelectorAll('tbody tr');
      const listo = Array.from(filas).some((f) => f.querySelector("a[href*='viewer']"));
      return listo ? 'listo' : 'esperando';
    });
    if (estado !== 'esperando') return estado;
    await page.waitForTimeout(500);
  }
  // Diagnóstico: si nunca se resolvió, devolvemos un fragmento del texto
  // real de la página para poder ver qué mensaje muestra el SCW en este
  // caso — nuestra detección de "sin históricas" puede estar buscando un
  // texto que no coincide exactamente con el real.
  const debug = await page.evaluate(() => (document.body.innerText || '').slice(0, 500));
  return { estado: 'timeout', debug, url: page.url() };
}

async function clickSiguienteHistoricas(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('a,button')).find(
      (el) =>
        el.textContent.trim().toLowerCase() === 'siguiente' &&
        !el.disabled &&
        !el.classList.contains('disabled') &&
        !el.classList.contains('ui-state-disabled')
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
}

async function recorrerHistoricas(page) {
  const vistos = new Set();
  const out = [];
  let incompleta = false;
  let pagina = 1;

  while (true) {
    const filas = await scrapearFilasHistoricas(page);
    for (const f of filas) {
      if (!vistos.has(f.url)) {
        vistos.add(f.url);
        out.push(f);
      }
    }
    const htmlAntes = await page.locator('tbody').first().innerHTML().catch(() => '');
    const clickeo = await clickSiguienteHistoricas(page);
    if (!clickeo) break;

    let cambio = await esperarCambioHtml(page, 'tbody', htmlAntes, 8000);
    if (!cambio) {
      await clickSiguienteHistoricas(page);
      cambio = await esperarCambioHtml(page, 'tbody', htmlAntes, 15000);
      if (!cambio) {
        incompleta = true;
        break;
      }
    }
    pagina++;
    if (pagina > 500) { incompleta = true; break; }
  }
  return { filas: out, incompleta };
}

// ─── Utilidad común ─────────────────────────────────────────────────────

async function esperarCambioHtml(page, selector, htmlAntes, timeoutMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const actual = await page.locator(selector).first().innerHTML().catch(() => htmlAntes);
    if (actual !== htmlAntes) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

function normalizarUrl(item, scwBase) {
  let url = item.url;
  if (url && url.indexOf('http') !== 0) url = scwBase + url;
  const urlPublica = url.replace(/[&?]download=true/g, '');
  return { ...item, urlPdf: url, urlPublica };
}

// ─── Orquestación ─────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page
 * @param {string} scwBase
 * @param {string} cid
 * @returns {Promise<{actuaciones: object[], paginacionIncompleta: boolean, historicasEstado: string}>}
 */
export async function scrapeActuaciones(page, scwBase, cid) {
  await page.goto(`${scwBase}/scw/expediente.seam?cid=${cid}`, { waitUntil: 'networkidle' });

  // Best-effort: el SCW no siempre expone la carátula con un selector fijo,
  // así que buscamos el patrón de texto típico "Carátula: ..." en la página
  // — mismo criterio que ya usa la extensión (content.js: obtenerCaratula).
  const caratula = await page.evaluate(() => {
    const texto = document.body.innerText || '';
    const m = texto.match(/Car[aá]tula\s*:?\s*(.+)/i);
    return m && m[1] ? m[1].split('\n')[0].trim().slice(0, 160) : '';
  });

  const { filas: actuales, incompleta: incompletaActuales } = await recorrerActuales(page);

  // Siempre visitamos históricas nosotros mismos — ver nota al inicio del
  // archivo sobre por qué esto no necesita el aviso que sí necesitó la
  // extensión.
  await page.goto(`${scwBase}/scw/actuacionesHistoricas.seam?cid=${cid}`, { waitUntil: 'networkidle' });
  const resultadoHistoricas = await esperarTablaHistoricasLista(page, 40000);
  const historicasEstado = typeof resultadoHistoricas === 'string' ? resultadoHistoricas : resultadoHistoricas.estado;
  const historicasDebug = typeof resultadoHistoricas === 'string' ? null : { texto: resultadoHistoricas.debug, url: resultadoHistoricas.url };

  let historicas = [];
  let incompletaHistoricas = false;
  if (historicasEstado === 'listo') {
    const r = await recorrerHistoricas(page);
    historicas = r.filas;
    incompletaHistoricas = r.incompleta;
  }
  // 'vacio' → el expediente genuinamente no tiene históricas.
  // 'timeout' → no se pudo determinar; historicasDebug trae un fragmento
  // del texto real de la página para diagnosticar por qué.

  const combinadas = [...historicas, ...actuales].map((item, i) => ({
    numero: i + 1,
    ...normalizarUrl(item, scwBase),
  }));

  return {
    actuaciones: combinadas,
    paginacionIncompleta: incompletaActuales || incompletaHistoricas,
    historicasEstado, // 'listo' | 'vacio' | 'timeout'
    historicasDebug, // solo si historicasEstado === 'timeout'
    caratula,
  };
}
