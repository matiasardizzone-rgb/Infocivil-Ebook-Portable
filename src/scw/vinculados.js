// vinculados.js — incidentes y demás expedientes vinculados.
//
// Los incidentes se numeran <número>/<año>/<n> (ej. CIV 013719/2023/1) y NO
// se pueden buscar directo: el formulario de la Consulta Pública solo acepta
// número y año. Se llega a ellos desde la solapa "Vinculados" del principal.
//
// Estructura real del SCW (verificada sobre el HTML de la solapa abierta):
//   - Solapa: <td id="expediente:j_idt348:header:inactive"> con
//     <span class="rf-tab-lbl">Vinculados</span>. El id es autogenerado y
//     cambia entre versiones, por eso se busca por el texto visible.
//   - Contenido: <div id="expediente:vinculadosTab">, que llega por AJAX
//     recién al abrir la solapa.
//   - Tabla: <table id="expediente:connectedTable"> con columnas fijas:
//     0 expediente · 1 dependencia · 2 situación · 3 carátula · 4 últ. act.
//     · 5 botón "ojo".
//   - El "ojo" es <a class="btn btn-default"> cuyo onclick hace un submit de
//     formulario JSF (mojarra.jsfcljs) y termina en `return false`. Por eso
//     necesita un clic REAL del navegador: disparar .click() desde
//     JavaScript no reproduce ese camino de forma confiable — era la causa
//     de que la apertura desde la lista no funcionara.

const SELECTOR_TABLA = '#expediente\\:connectedTable';
const SELECTOR_CONTENIDO = '#expediente\\:vinculadosTab';

/** Normaliza "CIV 013719/2023/1" y "CIV 13719/2023/1" a la misma clave. */
export function claveExpediente(texto) {
  const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}|${Number(m[2])}|${m[3]}|${Number(m[4])}`;
}

function contieneClave(texto, clave) {
  const re = /([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/gi;
  let m;
  while ((m = re.exec(texto || '')) !== null) {
    if (`${m[1].toUpperCase()}|${Number(m[2])}|${m[3]}|${Number(m[4])}` === clave) return true;
  }
  return false;
}

async function abrirSolapa(page) {
  // Clic real sobre la etiqueta visible: RichFaces engancha el manejador por
  // JavaScript, no con un atributo onclick.
  const etiquetas = page.locator('.rf-tab-lbl', { hasText: /^Vinculados$/ });
  const cantidad = await etiquetas.count().catch(() => 0);
  for (let i = 0; i < cantidad; i++) {
    const el = etiquetas.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function leerFilas(page) {
  return page.evaluate(() => {
    const tabla = document.querySelector('#expediente\\:connectedTable');
    const filas = tabla
      ? Array.from(tabla.querySelectorAll('tbody tr'))
      : Array.from(document.querySelectorAll('tr'));

    const salida = [];
    for (const fila of filas) {
      const celdas = Array.from(fila.querySelectorAll('td')).map(c => (c.innerText || '').trim());
      if (!celdas.length) continue;
      const expediente = (celdas[0] || '').replace(/\s+/g, ' ').trim();
      if (!/\d+\/\d{4}\/\d+/.test(expediente)) continue;

      salida.push({
        expediente,
        dependencia: celdas[1] || '',
        situacion: celdas[2] || '',
        caratula: celdas[3] || '',
        ultimaActuacion: celdas[4] || '',
      });
    }
    return salida;
  });
}

/**
 * Devuelve los expedientes vinculados del expediente abierto.
 * La página debe estar en expediente.seam del principal.
 *
 * @returns {Promise<{vinculados: object[], estado: 'ok'|'sin-vinculados'|'no-disponible'}>}
 */
export async function leerVinculados(page) {
  if (!(await abrirSolapa(page))) return { vinculados: [], estado: 'no-disponible' };

  // El contenido llega por AJAX: se espera la tabla, o a que el propio sitio
  // informe que no hay vinculados.
  await page.waitForSelector(SELECTOR_CONTENIDO, { timeout: 12000 }).catch(() => {});

  const inicio = Date.now();
  while (Date.now() - inicio < 12000) {
    const filas = await leerFilas(page).catch(() => []);
    if (filas.length) return { vinculados: filas, estado: 'ok' };

    const sinVinculados = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      return /total de 0 vinculado/i.test(t) || /no se (han )?encontr/i.test(t);
    }).catch(() => false);
    if (sinVinculados) return { vinculados: [], estado: 'sin-vinculados' };

    await page.waitForTimeout(400);
  }
  return { vinculados: [], estado: 'sin-vinculados' };
}

/**
 * Abre un vinculado y devuelve su cid.
 * @param {string} expediente  ej. 'CIV 013719/2023/1' (los ceros no importan)
 */
export async function abrirVinculado(page, expediente) {
  const clave = claveExpediente(expediente);
  if (!clave) throw new Error(`No se entiende el expediente "${expediente}".`);

  // Ubicar la fila comparando por número: los ceros a la izquierda que
  // muestra el SCW no coinciden con lo que escribe la gente.
  const filas = page.locator(`${SELECTOR_TABLA} tbody tr`);
  const cantidad = await filas.count().catch(() => 0);
  let objetivo = null;
  for (let i = 0; i < cantidad; i++) {
    const texto = await filas.nth(i).innerText().catch(() => '');
    if (claveExpediente(texto) === clave) { objetivo = filas.nth(i); break; }
  }
  if (!objetivo) throw new Error(`No se encontró el vinculado ${expediente} en la lista.`);

  const boton = objetivo.locator('a.btn, a[onclick]').first();
  const urlAntes = page.url();

  // Clic real: el onclick hace un submit de formulario JSF, que con un
  // click sintético no siempre se dispara.
  await boton.click({ timeout: 8000 });

  // Esperar a estar en el incidente: URL con cid y contenido donde figure
  // ESE número (no el del principal).
  const inicio = Date.now();
  while (Date.now() - inicio < 25000) {
    const m = page.url().match(/cid=(\d+)/);
    const texto = await page.evaluate(
      () => (document.body && document.body.innerText) || ''
    ).catch(() => '');

    if (m && texto.length > 200 && contieneClave(texto, clave)) return { cid: m[1] };
    await page.waitForTimeout(400);
  }

  throw new Error(
    `No se pudo abrir ${expediente}: el sitio no terminó de cargarlo` +
    (page.url() === urlAntes ? ' (la página no cambió).' : '.')
  );
}
