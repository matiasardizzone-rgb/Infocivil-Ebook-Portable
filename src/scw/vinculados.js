// vinculados.js — incidentes y demás expedientes vinculados.
//
// Los incidentes se numeran como <número>/<año>/<n> (ej. CIV 013719/2023/1)
// y NO se pueden buscar directo: el formulario de la Consulta Pública solo
// acepta número y año. Se llega a ellos desde la solapa "Vinculados" del
// expediente principal.
//
// Esa solapa carga su contenido por AJAX recién al hacer clic (verificado
// sobre el HTML real: el número del incidente no aparece en la página hasta
// que se abre la solapa), así que hay que simular ese clic y esperar.
//
// Los ids de RichFaces son autogenerados (j_idt348 y similares) y cambian
// entre versiones del sitio, por eso la solapa se busca por su texto
// visible, que es estable.

const TEXTO_SOLAPA = 'Vinculados';

async function clickSolapa(page) {
  return page.evaluate((texto) => {
    const etiquetas = Array.from(document.querySelectorAll('.rf-tab-lbl, td, span, a'));
    const objetivo = etiquetas.find(
      (el) => el.textContent.trim() === texto && el.offsetParent !== null
    );
    if (!objetivo) return false;
    // El manejador puede estar en la celda contenedora, no en el span del
    // texto: se dispara el clic hacia arriba hasta encontrar quien lo tome.
    let nodo = objetivo;
    for (let i = 0; i < 3 && nodo; i++) {
      nodo.click();
      nodo = nodo.parentElement;
    }
    return true;
  }, TEXTO_SOLAPA);
}

// Lee la tabla de vinculados. Se identifica por contenido (filas cuyo texto
// tenga el patrón de un expediente con barra) en vez de por un id fijo,
// porque los ids son autogenerados.
async function leerTabla(page) {
  return page.evaluate(() => {
    const filas = Array.from(document.querySelectorAll('tr'));
    const salida = [];

    for (const fila of filas) {
      const celdas = Array.from(fila.querySelectorAll('td'));
      if (celdas.length < 4) continue;

      const textos = celdas.map((c) => (c.innerText || '').trim());
      // Un vinculado se reconoce porque alguna celda tiene la forma
      // "CIV 013719/2023/1" — número/año/incidente.
      const idx = textos.findIndex((t) => /\b[A-Z]{2,4}\s*\d{1,9}\/\d{4}\/\d+\b/.test(t));
      if (idx === -1) continue;

      const expediente = (textos[idx].match(/\b[A-Z]{2,4}\s*\d{1,9}\/\d{4}\/\d+\b/) || [])[0] || textos[idx];
      const restantes = textos.filter((t, i) => i !== idx && t);

      // La carátula es la celda más larga de las restantes: es el campo con
      // más texto por lejos (incluye actor, demandado y objeto).
      let caratula = '';
      for (const t of restantes) if (t.length > caratula.length) caratula = t;

      salida.push({
        expediente: expediente.replace(/\s+/g, ' ').trim(),
        caratula,
        // Se guardan todas las celdas por si hace falta algo más adelante,
        // sin depender de un orden de columnas que podría cambiar.
        celdas: textos,
      });
    }
    return salida;
  });
}

/**
 * Devuelve los expedientes vinculados (incidentes) del expediente abierto.
 * La página debe estar ya en expediente.seam del principal.
 *
 * @returns {Promise<{vinculados: object[], estado: string}>}
 *   estado: 'ok' | 'sin-vinculados' | 'no-disponible'
 */
export async function leerVinculados(page) {
  const abierta = await clickSolapa(page);
  if (!abierta) return { vinculados: [], estado: 'no-disponible' };

  // El contenido llega por AJAX: se espera a que aparezcan filas con forma
  // de vinculado, o a que quede claro que no hay ninguno.
  const inicio = Date.now();
  while (Date.now() - inicio < 12000) {
    const filas = await leerTabla(page);
    if (filas.length) return { vinculados: filas, estado: 'ok' };

    const sinVinculados = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      return /no se (han )?encontr/i.test(t) || /total de 0 vinculado/i.test(t);
    });
    if (sinVinculados) return { vinculados: [], estado: 'sin-vinculados' };

    await page.waitForTimeout(400);
  }
  return { vinculados: [], estado: 'sin-vinculados' };
}

/**
 * Abre un vinculado y devuelve su cid. Se hace clic en el botón de la fila
 * correspondiente (el "ojo"), que es el que navega al expediente.
 *
 * @param {string} expediente  ej. 'CIV 013719/2023/1'
 */
export async function abrirVinculado(page, expediente) {
  const clave = claveExpediente(expediente);
  if (!clave) throw new Error(`No se entiende el expediente "${expediente}".`);

  const clickeado = await page.evaluate(({ clave }) => {
    // El SCW muestra los números con ceros a la izquierda ("CIV
    // 013719/2023/1") pero la gente los escribe sin ellos ("13719"). Se
    // comparan como números, no como texto, para que coincidan igual.
    function claveDe(texto) {
      const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
      if (!m) return null;
      return `${m[1].toUpperCase()}|${Number(m[2])}|${m[3]}|${Number(m[4])}`;
    }

    for (const fila of Array.from(document.querySelectorAll('tr'))) {
      const texto = fila.innerText || '';
      if (claveDe(texto) !== clave) continue;
      const control = fila.querySelector('a[onclick], button, input[type="submit"], input[type="image"], a');
      if (control) { control.click(); return true; }
    }
    return false;
  }, { clave });

  if (!clickeado) throw new Error(`No se encontró el vinculado ${expediente} en la lista.`);

  // Esperar la navegación al expediente del incidente.
  const inicio = Date.now();
  while (Date.now() - inicio < 20000) {
    const m = page.url().match(/cid=(\d+)/);
    const texto = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    if (m && /car[aá]tula/i.test(texto) && texto.length > 200) {
      // Confirmar que estamos en el incidente y no seguimos en el
      // principal: comparando por número, no por texto literal.
      if (claveExpediente(texto) === clave || textoContieneClave(texto, clave)) {
        return { cid: m[1] };
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`No se pudo abrir el vinculado ${expediente} (el sitio no respondió a tiempo).`);
}

/** Normaliza "CIV 013719/2023/1" y "CIV 13719/2023/1" a la misma clave. */
function claveExpediente(texto) {
  const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}|${Number(m[2])}|${m[3]}|${Number(m[4])}`;
}

/** Busca la clave en cualquier parte de un texto largo (toda la página). */
function textoContieneClave(texto, clave) {
  const re = /([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    if (`${m[1].toUpperCase()}|${Number(m[2])}|${m[3]}|${Number(m[4])}` === clave) return true;
  }
  return false;
}
