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

  await page.locator('select[name="formPublica:camaraNumAni"]').selectOption(valorJurisdiccion);
  await page.locator('input[name="formPublica:numero"]').fill(String(numero));
  await page.locator('input[name="formPublica:anio"]').fill(String(anio));

  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator('input[name="formPublica:buscarPorNumeroButton"]').click(),
  ]);

  // Caso 1: navegó directo al expediente.
  const cidEnUrl = page.url().match(/cid=(\d+)/);
  if (cidEnUrl) {
    return { cid: cidEnUrl[1] };
  }

  // Caso 2: página intermedia de resultados — tomamos el primer link a un
  // expediente.
  const links = page.locator('a[href*="expediente.seam?cid="], a[href*="cid="]');
  const totalLinks = await links.count();
  if (totalLinks === 0) {
    // TODO: una vez visto el mensaje real de "no encontrado" en el sitio,
    // detectarlo acá específicamente para devolver un error más claro que
    // este genérico.
    throw new Error('No se encontró el expediente (o cambió el formato de la página de resultados — revisar selectores).');
  }
  const href = await links.first().getAttribute('href');
  const cidMatch = (href || '').match(/cid=(\d+)/);
  if (!cidMatch) {
    throw new Error('Se encontraron resultados pero no se pudo extraer el cid del expediente.');
  }
  return { cid: cidMatch[1], multiplesResultados: totalLinks > 1 };
}
