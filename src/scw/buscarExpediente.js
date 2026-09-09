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
    await page.locator('select[name="formPublica:camaraNumAni"]').selectOption(valorJurisdiccion);
    await page.waitForTimeout(150);
    await page.locator('input[name="formPublica:numero"]').fill(String(numero));
    await page.locator('input[name="formPublica:anio"]').fill(String(anio));
    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.locator('input[name="formPublica:buscarPorNumeroButton"]').click(),
    ]);
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
  // Margen extra: el submit de JSF es una navegación de página completa (no
  // un fetch/XHR puro) — 'networkidle' puede resolver en el instante justo
  // en que el documento viejo ya se descartó pero el nuevo todavía no
  // terminó de armar el DOM, dejando document.body momentáneamente null.
  await page.waitForTimeout(400);

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
      `No se encontró el expediente ${numero}/${anio} en ${jurisdiccion} (o cambió el formato de la página de resultados — revisar selectores). Texto de la página: "${(await page.evaluate(() => (document.body && document.body.innerText) || '')).slice(0, 300).replace(/\s+/g, ' ')}"`
    );
  }
  const href = await links.first().getAttribute('href');
  const cidMatch = (href || '').match(/cid=(\d+)/);
  if (!cidMatch) {
    throw new Error('Se encontraron resultados pero no se pudo extraer el cid del expediente.');
  }
  return { cid: cidMatch[1], multiplesResultados: totalLinks > 1 };
}
