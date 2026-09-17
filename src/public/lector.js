/* src/public/lector.js — Versión robusta con fallback al SCW */
(() => {
  const params = new URLSearchParams(location.search);
  const cid = params.get('cid');
  const nroActuacion = params.get('n');

  if (!cid || !nroActuacion) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#c53030"><h2>Faltan datos</h2><p>Se requiere cid y número de actuación.</p><a href="/">Volver</a></div>';
    return;
  }

  // Configuración de PDF.js
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
  }

  async function cargarLector() {
    const contenedor = document.getElementById('visor-pdf') || document.body;
    contenedor.innerHTML = '<div style="padding:40px;text-align:center;color:#4a5568">Cargando documento...</div>';

    try {
      // Intentamos obtener el PDF desde nuestro caché local
      const res = await fetch(`/api/expediente/${cid}/documento/${nroActuacion}`);
      
      if (!res.ok) {
        // Si no está en caché (404), mostramos un mensaje amigable con el enlace al SCW
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Documento no disponible en caché local');
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      contenedor.innerHTML = `
        <div style="height:100vh;display:flex;flex-direction:column;background:#2d3748;">
          <div style="background:#1a202c;color:#fff;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;font-size:1rem;">Actuación N° ${nroActuacion}</h3>
            <div>
              <a href="/leer.html?cid=${cid}" style="color:#cbd5e0;text-decoration:none;margin-right:16px;font-size:0.9rem;">← Volver al índice</a>
              <a href="/api/expediente/${cid}/documento/${nroActuacion}" download style="background:#2b6cb0;color:#fff;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:0.9rem;">⬇ Descargar</a>
            </div>
          </div>
          <iframe src="${url}" style="flex:1;width:100%;border:none;background:#fff;"></iframe>
        </div>
      `;
    } catch (err) {
      // FALLBACK: Si falla, buscamos la urlPublica para ofrecerla
      let urlPublica = '#';
      try {
        const actRes = await fetch(`/api/expediente/${cid}/actuaciones`);
        const actData = await actRes.json();
        const actuacion = actData.actuaciones?.find(a => a.numero == nroActuacion);
        if (actuacion && actuacion.urlPublica) {
          urlPublica = actuacion.urlPublica;
        }
      } catch (e) { /* ignorar */ }

      contenedor.innerHTML = `
        <div style="padding:60px;text-align:center;max-width:600px;margin:0 auto;">
          <h2 style="color:#c53030;">⚠️ Documento no disponible en caché</h2>
          <p style="color:#4a5568;margin:20px 0;">
            Este documento aún no se ha descargado en el modo portable. 
            Para verlo, podés acceder directamente al sitio del SCW o volver al índice para preparar la descarga completa.
          </p>
          <div style="display:flex;gap:12px;justify-content:center;margin-top:24px;">
            <a href="${urlPublica}" target="_blank" class="btn btn-secondary" style="padding:12px 24px;background:#edf2f7;color:#2d3748;text-decoration:none;border-radius:6px;font-weight:600;">
              🔗 Abrir en el SCW (Original)
            </a>
            <a href="/leer.html?cid=${cid}" class="btn btn-primary" style="padding:12px 24px;background:#2b6cb0;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">
              📚 Volver al índice del expediente
            </a>
          </div>
        </div>
      `;
    }
  }

  cargarLector();
})();