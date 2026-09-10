// buscarExpediente.js — completa el formulario real de "Consulta pública ›
// Por expediente" en home.seam y devuelve el cid del expediente encontrado.
//
// Selectores confirmados contra el HTML real de scw.pjn.gov.ar/scw/home.seam
// (no son un supuesto, se extrajeron del archivo que subió el usuario):
//   - form: #formPublica
//   - jurisdicción: select[name="formPublica:camaraNumAni"] — el value es un
//     CÓDIGO NUMÉRICO (0=CSJ, 1=CIV, ...), no la sigla. Ver jurisdicciones.js.
//   - número: input[name="formPublica:numero"] (maxlength 9)
//   - año: input[name="formPublica:anio"] (maxlength 4)
//   - botón: input[name="formPublica:buscarPorNumeroButton"]
//
// El botón dispara jsf.util.chain(...): primero PF('dialog').show() (un
// spinner "Consulta en proceso", puramente visual) y después
// mojarra.jsfcljs(...), que hace un submit real del formulario — no es un
// fetch/XHR puro, así que esperamos una navegación real de página.
//
// ⚠️ Lo que SIGUE sin confirmar contra el sitio real (esto es la única parte
// tejida a partir de la captura de pantalla, no del HTML de resultados —
// nadie nos pasó el HTML de la página que aparece DESPUÉS de buscar):
//   - Si hay un único resultado, ¿navega derecho a expediente.seam?cid=X, o
//     siempre pasa por una página intermedia de resultados (aunque haya uno
//     solo)?
//   - El mensaje exacto cuando no se encuentra el expediente (para
//     distinguirlo de un timeout real en vez de asumir).
// El código de abajo contempla varios casos posibles, pero hay que
// verificarlo la primera vez que esto corra contra el sitio real.

import { valorPorSigla } from './jurisdicciones.js';

export async function buscarExpediente(page, scwBase, { jurisdiccion, numero, anio }) {
  const valorJurisdiccion = valorPorSigla(jurisdiccion);
  if (!valorJurisdiccion) {
    throw new Error(`Jurisdicción desconocida: "${jurisdiccion}". Revisar contra jurisdicciones.js.`);
  }

  await page.goto(`${scwBase}/scw/home.seam`, { waitUntil: 'networkidle' });

  // Toda la interacción con el formulario en un solo bloque reintentable:
  // no sabemos con certeza en qué paso exacto puede pisarnos una carrera de
  // Playwright con algún JS del propio formulario (el <select> de
  // jurisdicción bien podría disparar un postback parcial de JSF al
  // cambiar) — más robusto reintentar la secuencia completa una vez que
  // tratar de blindar línea por línea a ciegas.
  async function completarFormulario() {
    const htmlAntes = await page.evaluate(() => document.body ? document.body.innerHTML.length : 0).catch(() => 0);
    await page.locator('select[name="formPublica:camaraNumAni"]').selectOption(valorJurisdiccion);
    await page.waitForTimeout(150);
    await page.locator('input[name="formPublica:numero"]').fill(String(numero));
    await page.locator('input[name="formPublica:anio"]').fill(String(anio));
    await page.locator('input[name="formPublica:buscarPorNumeroButton"]').click();
    // No confiamos en 'networkidle' acá: el submit real (después del
    // spinner "Consulta en proceso") puede arrancar recién un instante
    // después del click, y networkidle puede resolver de entrada porque
    // en ese primer instante todavía no hay nada en vuelo. En cambio,
    // esperamos activamente a que la página haya cambiado de verdad
    // respecto de cómo estaba antes de tocar "Consultar" (comparar contra
    // un umbral fijo de texto no alcanza: home.seam ya tiene de por sí
    // bastante texto de header/menú/footer).
    await esperarPaginaCambiada(htmlAntes);
  }

  async function esperarPaginaCambiada(htmlAntes, timeoutMs = 20000) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      const largoActual = await page.evaluate(() => document.body ? document.body.innerHTML.length : 0).catch(() => 0);
      // Umbral de diferencia (no solo "distinto") para no reaccionar a
      // cambios triviales de una animación o el propio spinner apareciendo.
      if (Math.abs(largoActual - htmlAntes) > 200) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  try {
    await completarFormulario();
  } catch (err) {
    console.warn('[buscarExpediente] Carrera al completar el formulario, reintentando una vez:', err.message);
    await page.waitForTimeout(600);
    try {
      await completarFormulario();
    } catch (err2) {
      // Ni con el reintento — seguimos igual: lo que importa es el estado
      // final de la página, que se verifica más abajo (pareceExpedienteReal
      // / cid en la URL / búsqueda de links). Si de verdad no funcionó, esas
      // verificaciones lo van a reflejar con un error más útil que este.
      console.warn('[buscarExpediente] Segunda carrera, se continúa igual y se verifica el estado de la página:', err2.message);
    }
  }

  // Ya sabemos que la URL cambió (esperarPaginaCambiada) — pero eso puede
  // ser solo el cascarón inicial de la página nueva; el contenido real
  // (carátula, tabla de actuaciones) puede llenarse con un paso extra de
  // JS/AJAX después de la navegación. Ahora que estamos confirmados fuera
  // de home.seam, medir por longitud de texto sí es una señal confiable
  // (a diferencia de antes, cuando podíamos seguir en home.seam con todo
  // su texto de header/menú/footer).
  await esperarContenidoReal();
  async function esperarContenidoReal(timeoutMs = 15000) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      const largo = await page.evaluate(() => (document.body && document.body.innerText || '').trim().length).catch(() => 0);
      if (largo > 100) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  // Verificación de contenido real: un cid= en la URL no alcanza como señal
  // de éxito — páginas de error/redirect genéricas del SCW también pueden
  // traer un cid= en la URL (el de su propia conversación de servidor, no
  // el de un expediente). Confirmamos que la página tenga la pinta real de
  // un expediente: la palabra "Carátula" en algún lado, o la tabla de
  // actuaciones presente.
  async function pareceExpedienteReal() {
    const texto = await page.evaluate(() => (document.body && document.body.innerText) || '');
    if (/car[aá]tula/i.test(texto)) return true;
    if (await page.locator('#expediente\\:action-table').count()) return true;
    return false;
  }

  // Caso 1: navegó directo al expediente.
  const cidEnUrl = page.url().match(/cid=(\d+)/);
  if (cidEnUrl && (await pareceExpedienteReal())) {
    return { cid: cidEnUrl[1] };
  }

  // Caso 2: página intermedia de resultados — tomamos el primer link a un
  // expediente.
  const links = page.locator('a[href*="expediente.seam?cid="], a[href*="cid="]');
  const totalLinks = await links.count();
  if (totalLinks === 0) {
    throw new Error(
      `No se encontró el expediente ${numero}/${anio} en ${jurisdiccion} (o cambió el formato de la página de resultados — revisar selectores). URL final: ${page.url()} — Texto de la página: "${(await page.evaluate(() => (document.body && document.body.innerText) || '')).slice(0, 300).replace(/\s+/g, ' ')}"`
    );
  }
  const href = await links.first().getAttribute('href');
  const cidMatch = (href || '').match(/cid=(\d+)/);
  if (!cidMatch) {
    throw new Error('Se encontraron resultados pero no se pudo extraer el cid del expediente.');
  }
  return { cid: cidMatch[1], multiplesResultados: totalLinks > 1 };
}
