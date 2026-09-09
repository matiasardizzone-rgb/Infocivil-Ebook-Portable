// descargarActuaciones.js — baja el PDF de cada actuación, validando que
// la respuesta sea realmente un PDF (firma %PDF-) antes de darla por buena,
// con un reintento — mismo criterio que el fix aplicado en PJN Descargador
// tras detectar que una sesión vencida podía devolver 200 OK con una página
// HTML de error en vez del documento.
//
// El fetch corre DENTRO del contexto del navegador (page.evaluate), no desde
// Node — así comparte automáticamente las cookies/sesión de Playwright, con
// el mismo comportamiento que tendría un click real dentro de esa pestaña.

const CONCURRENCIA_DEFAULT = 3;

/**
 * @param {import('playwright').Page} page
 * @param {Array<{urlPdf: string}>} actuaciones
 * @param {number} concurrencia
 * @returns {Promise<Array<object>>} las mismas actuaciones + { bytes, error }
 */
export async function descargarPdfs(page, actuaciones, concurrencia = CONCURRENCIA_DEFAULT) {
  const urls = actuaciones.map((a) => a.urlPdf);

  const resultados = await page.evaluate(
    async ({ urls, concurrencia }) => {
      function esPdfValido(b64) {
        try {
          const bin = atob(b64.slice(0, 8));
          return bin.startsWith('%PDF-');
        } catch {
          return false;
        }
      }

      async function descargarUno(url) {
        for (let intento = 0; intento < 2; intento++) {
          try {
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            const b64 = btoa(binary);
            if (esPdfValido(b64)) return { ok: true, b64 };
          } catch (e) {
            if (intento === 1) return { ok: false, error: e.message };
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        return { ok: false, error: 'La respuesta no es un PDF válido (posible sesión vencida).' };
      }

      const out = new Array(urls.length);
      let siguiente = 0;
      async function worker() {
        while (siguiente < urls.length) {
          const i = siguiente++;
          out[i] = await descargarUno(urls[i]);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrencia, urls.length) }, worker));
      return out;
    },
    { urls, concurrencia }
  );

  return actuaciones.map((a, i) => {
    const r = resultados[i];
    if (r.ok) {
      return { ...a, bytes: new Uint8Array(Buffer.from(r.b64, 'base64')), error: null };
    }
    return { ...a, bytes: null, error: r.error };
  });
}
