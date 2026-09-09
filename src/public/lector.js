/* lector.js — lectura del expediente como libro.
 *
 * Modelo de "hojas": el expediente se recorre como una secuencia plana de
 * páginas físicas. Cada actuación aporta tantas hojas como páginas tenga su
 * PDF, así que pasar de hoja puede quedarse dentro de la misma actuación o
 * saltar a la siguiente — igual que en el expediente de papel.
 *
 * Carga progresiva: los PDFs se piden de a uno al servidor
 * (/api/expediente/:cid/documento/:n) y se cachean en memoria. La cantidad
 * de páginas de cada actuación recién se conoce al abrirla, así que el
 * índice de hojas se va construyendo a medida que se avanza, en vez de
 * bajar los 200+ documentos al abrir el lector.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const cid = params.get('cid');
  const sessionId = params.get('sessionId');
  const jurisdiccion = params.get('jurisdiccion') || '';
  const numero = params.get('numero') || '';
  const anio = params.get('anio') || '';

  if (!cid || !sessionId) { location.href = '/'; return; }

  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

  const COLORES = ['#d64545', '#e08c2e', '#2f9e5f', '#3878c4', '#9b5bb5'];
  const CLAVE_MARCAS = `infocivil.marcas.${jurisdiccion}|${numero}|${anio}`;

  let actuaciones = [];
  let caratula = '';
  // Cache de documentos abiertos: numero de actuación -> { doc, paginas }
  const cache = new Map();
  // Secuencia de hojas conocidas: { actuacion, paginaEnDoc }
  let hojas = [];
  // Hasta qué actuación ya expandimos hojas
  let expandidoHasta = 0;
  let indiceHoja = 0;
  let dosPaginas = window.innerWidth >= 1100;
  let animando = false;

  // ─── Marcas (banderitas + notas), guardadas por navegador ──────────
  function leerMarcas() {
    try { return JSON.parse(localStorage.getItem(CLAVE_MARCAS) || '{}'); }
    catch { return {}; }
  }
  function escribirMarcas(m) {
    localStorage.setItem(CLAVE_MARCAS, JSON.stringify(m));
  }
  let marcas = leerMarcas();

  // ─── Carga de datos ────────────────────────────────────────────────
  async function iniciar() {
    try {
      const r = await fetch(`/api/expediente/${encodeURIComponent(cid)}/actuaciones?sessionId=${encodeURIComponent(sessionId)}`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'No se pudieron leer las actuaciones.');

      actuaciones = d.actuaciones;
      caratula = d.caratula || `Expediente ${cid}`;

      $('lectorExp').textContent = `${jurisdiccion} ${numero}/${anio}`;
      $('lectorCaratula').textContent = caratula;
      $('volverExpediente').href = '/expediente.html?' + new URLSearchParams({ cid, sessionId, jurisdiccion, numero, anio });

      pintarIndice();
      pintarBanderitas();
      await expandirHasta(1);
      await irAHoja(0, false);

      $('cargandoLector').hidden = true;
      $('libro').hidden = false;
    } catch (e) {
      $('cargandoLector').textContent = e.message;
    }
  }

  // ─── Documentos ────────────────────────────────────────────────────
  async function abrirDocumento(nroActuacion) {
    if (cache.has(nroActuacion)) return cache.get(nroActuacion);
    const url = `/api/expediente/${encodeURIComponent(cid)}/documento/${nroActuacion}?sessionId=${encodeURIComponent(sessionId)}`;
    const doc = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
    const entrada = { doc, paginas: doc.numPages };
    cache.set(nroActuacion, entrada);
    return entrada;
  }

  // Agrega a la secuencia de hojas todas las páginas de las actuaciones
  // hasta `nro` inclusive. Si un documento falla, la actuación aporta una
  // hoja igual (que se muestra como no disponible) para no romper la
  // navegación ni desalinear el índice.
  async function expandirHasta(nro) {
    while (expandidoHasta < nro && expandidoHasta < actuaciones.length) {
      const siguiente = expandidoHasta + 1;
      let paginas = 1, fallo = null;
      try {
        const e = await abrirDocumento(siguiente);
        paginas = e.paginas;
      } catch (err) {
        fallo = err.message || 'No se pudo abrir el documento.';
      }
      for (let p = 1; p <= paginas; p++) {
        hojas.push({ actuacion: siguiente, paginaEnDoc: p, fallo });
      }
      expandidoHasta = siguiente;
    }
  }

  async function renderizarEn(canvas, hoja) {
    const ctx = canvas.getContext('2d');
    if (!hoja) {
      canvas.width = 0; canvas.height = 0;
      return;
    }
    if (hoja.fallo) {
      canvas.width = 420; canvas.height = 560;
      ctx.fillStyle = '#fdfcf8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#b3261e'; ctx.font = 'bold 15px Segoe UI, sans-serif';
      ctx.fillText('Documento no disponible', 30, 60);
      ctx.fillStyle = '#6b6252'; ctx.font = '12px Segoe UI, sans-serif';
      ctx.fillText(hoja.fallo.slice(0, 46), 30, 86);
      return;
    }
    const { doc } = await abrirDocumento(hoja.actuacion);
    const pagina = await doc.getPage(hoja.paginaEnDoc);
    const alto = Math.max(320, $('escenario').clientHeight - 130);
    const base = pagina.getViewport({ scale: 1 });
    const escala = alto / base.height;
    const vp = pagina.getViewport({ scale: escala });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await pagina.render({ canvasContext: ctx, viewport: vp }).promise;
  }

  function textoActuacion(nro) {
    const a = actuaciones[nro - 1];
    if (!a) return { titulo: '', fecha: '', url: '' };
    const titulo = [a.tipo, a.descripcion].filter(Boolean).join(' — ');
    return { titulo, fecha: a.fecha || '', url: a.urlPublica || '' };
  }

  function pintarEncabezadoYPie(hoja, elEnc, elPie) {
    if (!hoja) { elEnc.innerHTML = ''; elPie.innerHTML = ''; return; }
    const t = textoActuacion(hoja.actuacion);
    const totalDeEsta = hojas.filter(h => h.actuacion === hoja.actuacion).length;
    elEnc.innerHTML = `<strong>Act. ${hoja.actuacion} · ${escapar(t.titulo).slice(0, 90)}</strong>
      ${escapar(t.fecha)}${totalDeEsta > 1 ? ` · pág. ${hoja.paginaEnDoc} de ${totalDeEsta}` : ''}`;
    elPie.innerHTML = t.url ? `<a href="${escapar(t.url)}" target="_blank" rel="noopener">${escapar(t.url)}</a>` : '';
  }

  function escapar(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ─── Render del spread actual ──────────────────────────────────────
  async function pintarHojas() {
    const libro = $('libro');
    libro.classList.toggle('una-pagina', !dosPaginas);

    if (dosPaginas) {
      const izq = hojas[indiceHoja];
      const der = hojas[indiceHoja + 1];
      pintarEncabezadoYPie(izq, $('encIzq'), $('pieIzq'));
      pintarEncabezadoYPie(der, $('encDer'), $('pieDer'));
      await renderizarEn($('canvasIzq'), izq);
      await renderizarEn($('canvasDer'), der);
    } else {
      const unica = hojas[indiceHoja];
      pintarEncabezadoYPie(unica, $('encDer'), $('pieDer'));
      await renderizarEn($('canvasDer'), unica);
    }

    actualizarPosicion();
    actualizarBotonBanderita();
    marcarIndiceActual();
  }

  function actuacionActual() {
    const h = hojas[indiceHoja];
    return h ? h.actuacion : 1;
  }

  function actualizarPosicion() {
    const total = actuaciones.length;
    const act = actuacionActual();
    $('lectorPosicion').textContent = `Actuación ${act} de ${total}`;
    const paso = dosPaginas ? 2 : 1;
    $('controlesInfo').textContent = `Hoja ${indiceHoja + 1}${paso === 2 && hojas[indiceHoja + 1] ? '–' + (indiceHoja + 2) : ''}`;
    $('btnAnterior').disabled = indiceHoja <= 0;
    $('btnSiguiente').disabled = (indiceHoja + paso) >= hojas.length && expandidoHasta >= actuaciones.length;
  }

  // ─── Navegación ────────────────────────────────────────────────────
  async function irAHoja(nuevo, conAnimacion) {
    if (animando) return;
    nuevo = Math.max(0, nuevo);

    // Si nos acercamos al final de lo expandido, expandir más actuaciones.
    if (nuevo + 4 >= hojas.length && expandidoHasta < actuaciones.length) {
      await expandirHasta(Math.min(expandidoHasta + 3, actuaciones.length));
    }
    if (nuevo >= hojas.length) return;

    if (!conAnimacion) {
      indiceHoja = nuevo;
      await pintarHojas();
      return;
    }

    animando = true;
    const volteo = $('hojaVolteo');
    // La hoja que gira muestra el contenido que se está dejando atrás.
    const hojaQueSale = hojas[dosPaginas ? indiceHoja + 1 : indiceHoja];
    await renderizarEn($('canvasVolteo'), hojaQueSale);

    volteo.classList.add('activa');
    volteo.style.transition = 'none';
    volteo.style.transform = 'rotateY(0deg)';
    void volteo.offsetWidth;
    volteo.style.transition = 'transform .55s ease-in-out';
    volteo.style.transform = 'rotateY(-172deg)';

    await new Promise(r => setTimeout(r, 560));
    indiceHoja = nuevo;
    await pintarHojas();
    volteo.classList.remove('activa');
    volteo.style.transition = 'none';
    volteo.style.transform = 'rotateY(0deg)';
    animando = false;
  }

  async function siguiente() { await irAHoja(indiceHoja + (dosPaginas ? 2 : 1), true); }
  async function anterior() { await irAHoja(indiceHoja - (dosPaginas ? 2 : 1), false); }

  async function irAActuacion(nro) {
    await expandirHasta(nro);
    const idx = hojas.findIndex(h => h.actuacion === nro);
    if (idx >= 0) await irAHoja(idx, false);
  }

  // ─── Índice ────────────────────────────────────────────────────────
  function pintarIndice(filtro) {
    const cont = $('listaIndice');
    cont.innerHTML = '';
    const texto = (filtro || '').toLowerCase();

    actuaciones.forEach((a, i) => {
      const nro = i + 1;
      const titulo = [a.tipo, a.descripcion].filter(Boolean).join(' — ');
      if (texto && !(titulo + ' ' + (a.fecha || '')).toLowerCase().includes(texto)) return;

      const marca = marcas[nro];
      const b = document.createElement('button');
      b.className = 'indice-item';
      b.dataset.nro = String(nro);
      b.innerHTML = `
        <span class="indice-num">${marca ? `<span class="indice-punto" style="background:${escapar(marca.color)}"></span>` : ''}${String(nro).padStart(3, '0')}</span>
        <span class="indice-tipo">${escapar(a.tipo || 'Actuación')}</span>
        <span class="indice-desc">${escapar(a.descripcion || '')}</span>
        <span class="indice-fecha">${escapar(a.fecha || '')}</span>`;
      b.addEventListener('click', () => irAActuacion(nro));
      cont.appendChild(b);
    });
  }

  function marcarIndiceActual() {
    const act = actuacionActual();
    document.querySelectorAll('.indice-item').forEach(el => {
      el.classList.toggle('indice-item--actual', Number(el.dataset.nro) === act);
    });
    const actual = document.querySelector('.indice-item--actual');
    if (actual) actual.scrollIntoView({ block: 'nearest' });
  }

  // ─── Banderitas ────────────────────────────────────────────────────
  // Sobresalen del borde derecho, como los stickers del expediente de papel:
  // se ven desde cualquier parte del expediente, no solo en su actuación.
  function pintarBanderitas() {
    const riel = $('rielBanderitas');
    riel.innerHTML = '';
    const total = Math.max(1, actuaciones.length - 1);

    Object.entries(marcas).forEach(([nroStr, m]) => {
      const nro = Number(nroStr);
      const pos = ((nro - 1) / total) * 92 + 2;
      const el = document.createElement('div');
      el.className = 'banderita';
      el.style.top = pos + '%';
      el.style.background = m.color;
      el.title = `Act. ${nro}${m.nota ? ' — ' + m.nota : ''}`;
      el.innerHTML = `<span class="banderita-texto">${escapar(m.nota || 'Act. ' + nro)}</span>`;
      el.addEventListener('click', () => irAActuacion(nro));
      riel.appendChild(el);
    });
  }

  function actualizarBotonBanderita() {
    const m = marcas[actuacionActual()];
    const btn = $('btnBanderita');
    btn.classList.toggle('marcada', !!m);
    btn.style.background = m ? m.color : '';
    btn.style.borderColor = m ? m.color : '';
  }

  // ─── Popover de anotación ──────────────────────────────────────────
  let colorElegido = COLORES[0];

  function pintarColores() {
    const cont = $('colores');
    cont.innerHTML = '';
    COLORES.forEach(c => {
      const d = document.createElement('div');
      d.className = 'color-opcion' + (c === colorElegido ? ' elegido' : '');
      d.style.background = c;
      d.addEventListener('click', () => { colorElegido = c; pintarColores(); });
      cont.appendChild(d);
    });
  }

  function abrirPopover() {
    const nro = actuacionActual();
    const m = marcas[nro];
    const t = textoActuacion(nro);
    $('notaTitulo').textContent = `Act. ${nro} — ${t.titulo}`.slice(0, 110);
    $('notaTexto').value = m ? (m.nota || '') : '';
    colorElegido = m ? m.color : COLORES[0];
    pintarColores();

    const r = $('btnBanderita').getBoundingClientRect();
    const pop = $('notaPopover');
    pop.hidden = false;
    pop.style.top = Math.min(r.bottom + 8, window.innerHeight - 280) + 'px';
    pop.style.left = Math.max(12, r.right - 270) + 'px';
    $('notaTexto').focus();
  }
  function cerrarPopover() { $('notaPopover').hidden = true; }

  $('btnBanderita').addEventListener('click', () => {
    if ($('notaPopover').hidden) abrirPopover(); else cerrarPopover();
  });
  $('notaCancelar').addEventListener('click', cerrarPopover);
  $('notaGuardar').addEventListener('click', () => {
    marcas[actuacionActual()] = { color: colorElegido, nota: $('notaTexto').value.trim() };
    escribirMarcas(marcas);
    cerrarPopover();
    pintarBanderitas();
    actualizarBotonBanderita();
    pintarIndice($('filtroIndice').value);
    marcarIndiceActual();
  });
  $('notaQuitar').addEventListener('click', () => {
    delete marcas[actuacionActual()];
    escribirMarcas(marcas);
    cerrarPopover();
    pintarBanderitas();
    actualizarBotonBanderita();
    pintarIndice($('filtroIndice').value);
    marcarIndiceActual();
  });

  // ─── Controles ─────────────────────────────────────────────────────
  $('btnSiguiente').addEventListener('click', siguiente);
  $('btnAnterior').addEventListener('click', anterior);
  $('btnIndice').addEventListener('click', () => $('panelIndice').classList.toggle('oculto'));
  $('filtroIndice').addEventListener('input', (e) => { pintarIndice(e.target.value); marcarIndiceActual(); });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); siguiente(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); anterior(); }
    else if (e.key === 'Escape') cerrarPopover();
  });

  // Cambio de ancho: pasar de spread a una página y viceversa.
  let temporizadorResize;
  window.addEventListener('resize', () => {
    clearTimeout(temporizadorResize);
    temporizadorResize = setTimeout(async () => {
      const antes = dosPaginas;
      dosPaginas = window.innerWidth >= 1100;
      if (antes !== dosPaginas) {
        // Al cambiar de modo, alinear a par para que el spread no quede
        // desfasado respecto de la hoja que se estaba leyendo.
        if (dosPaginas && indiceHoja % 2 !== 0) indiceHoja--;
        await pintarHojas();
      } else {
        await pintarHojas();
      }
    }, 220);
  });

  iniciar();
})();
