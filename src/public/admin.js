/* admin.js — panel de auditoría. */

(() => {
  const $ = (id) => document.getElementById(id);

  async function pedir(url, opciones) {
    const r = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opciones,
    });
    const d = await r.json().catch(() => ({ ok: false, error: 'Respuesta inesperada del servidor.' }));
    if (!d.ok) throw new Error(d.error || 'Error');
    return d;
  }

  function mostrarEstado(id, texto, tipo) {
    const el = $(id);
    el.textContent = texto || '';
    el.className = 'estado' + (tipo ? ' estado--' + tipo : '');
  }

  function mostrarVista(cual) {
    ['vistaInicial', 'vistaLogin', 'vistaPanel'].forEach(v => { $(v).hidden = v !== cual; });
  }

  // ─── Arranque ────────────────────────────────────────────────────────
  let usuarioActual = null;

  async function arrancar() {
    const d = await pedir('/api/admin/estado');
    usuarioActual = d.usuario;
    if (!d.inicializado) return mostrarVista('vistaInicial');
    if (!d.usuario) return mostrarVista('vistaLogin');
    entrarAlPanel();
  }

  function entrarAlPanel() {
    mostrarVista('vistaPanel');
    $('barraAcciones').innerHTML =
      `<span class="barra-link">${usuarioActual}</span>
       <a class="barra-link" href="/">Ir al sitio</a>
       <button class="barra-link" id="btnSalir" style="background:none;border:none;cursor:pointer;font-family:inherit">Salir</button>`;
    $('btnSalir').addEventListener('click', async () => {
      await pedir('/api/admin/salir', { method: 'POST' });
      location.reload();
    });
    cargarRegistro();
  }

  // ─── Alta inicial ────────────────────────────────────────────────────
  $('btnInicializar').addEventListener('click', async () => {
    const usuario = $('iniUsuario').value.trim();
    const c1 = $('iniClave').value, c2 = $('iniClave2').value;
    if (c1 !== c2) return mostrarEstado('estadoInicial', 'Las contraseñas no coinciden.', 'error');
    try {
      await pedir('/api/admin/inicializar', {
        method: 'POST', body: JSON.stringify({ usuario, contrasena: c1 }),
      });
      mostrarEstado('estadoInicial', 'Administrador creado. Ya podés ingresar.', 'ok');
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      mostrarEstado('estadoInicial', e.message, 'error');
    }
  });

  // ─── Ingreso ─────────────────────────────────────────────────────────
  async function ingresar() {
    try {
      const d = await pedir('/api/admin/ingresar', {
        method: 'POST',
        body: JSON.stringify({ usuario: $('logUsuario').value.trim(), contrasena: $('logClave').value }),
      });
      usuarioActual = d.usuario;
      entrarAlPanel();
    } catch (e) {
      mostrarEstado('estadoLogin', e.message, 'error');
    }
  }
  $('btnIngresar').addEventListener('click', ingresar);
  $('logClave').addEventListener('keydown', e => { if (e.key === 'Enter') ingresar(); });

  // ─── Pestañas ────────────────────────────────────────────────────────
  document.querySelectorAll('.pestania').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.pestania').forEach(x => x.classList.remove('pestania--activa'));
      b.classList.add('pestania--activa');
      $('tabRegistro').hidden = b.dataset.tab !== 'registro';
      $('tabAdmins').hidden = b.dataset.tab !== 'admins';
      $('tabCuenta').hidden = b.dataset.tab !== 'cuenta';
      if (b.dataset.tab === 'admins') cargarAdmins();
    });
  });

  // ─── Registro de operaciones ─────────────────────────────────────────
  let entradasActuales = [];

  function claseOperacion(op) {
    if (op.includes('fallid') || op.includes('fallo')) return 'op op--falla';
    if (op.startsWith('admin-')) return 'op op--admin';
    return 'op';
  }

  function formatoFecha(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('es-AR') + ' ' + d.toLocaleTimeString('es-AR');
    } catch { return iso; }
  }

  function resumenDetalle(e) {
    if (!e.detalle) return e.usuario ? `usuario: ${e.usuario}` : '';
    const partes = Object.entries(e.detalle).map(([k, v]) => `${k}: ${v}`);
    if (e.usuario) partes.unshift(`usuario: ${e.usuario}`);
    return partes.join(' · ');
  }

  function escapar(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function cargarRegistro() {
    const dia = $('selDia').value || '';
    const q = $('txtFiltro').value || '';
    try {
      const d = await pedir(`/api/admin/auditoria?dia=${encodeURIComponent(dia)}&q=${encodeURIComponent(q)}`);

      if ($('selDia').options.length !== d.dias.length) {
        $('selDia').innerHTML = d.dias.map(x => `<option value="${x}">${x}</option>`).join('');
        if (d.dia) $('selDia').value = d.dia;
      }

      entradasActuales = d.entradas;
      $('cuerpoTabla').innerHTML = d.entradas.map(e => `
        <tr>
          <td class="mono">${escapar(formatoFecha(e.fecha))}</td>
          <td class="${claseOperacion(e.operacion)}">${escapar(e.operacion)}</td>
          <td>${escapar(e.expediente || '')}</td>
          <td class="mono">${escapar(e.ip)}</td>
          <td class="detalle">${escapar(resumenDetalle(e))}</td>
        </tr>`).join('');

      $('resumenTabla').textContent = d.entradas.length
        ? `${d.entradas.length} operaciones${d.dia ? ' el ' + d.dia : ''}.`
        : 'Sin operaciones registradas para este día.';
    } catch (e) {
      if (e.message.includes('Sesión')) return location.reload();
      $('resumenTabla').textContent = e.message;
    }
  }

  $('btnRecargar').addEventListener('click', cargarRegistro);
  $('selDia').addEventListener('change', cargarRegistro);
  let temporizador;
  $('txtFiltro').addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(cargarRegistro, 300);
  });

  $('btnExportar').addEventListener('click', () => {
    const filas = [['fecha', 'operacion', 'expediente', 'cid', 'ip', 'usuario', 'detalle']];
    entradasActuales.forEach(e => {
      filas.push([
        e.fecha, e.operacion, e.expediente || '', e.cid || '', e.ip, e.usuario || '',
        e.detalle ? JSON.stringify(e.detalle) : '',
      ]);
    });
    const csv = filas.map(f => f.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria-${$('selDia').value || 'export'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // ─── Administradores ─────────────────────────────────────────────────
  async function cargarAdmins() {
    try {
      const d = await pedir('/api/admin/admins');
      $('listaAdmins').innerHTML = d.admins.map(a => `
        <div class="admin-fila">
          <div class="admin-datos">
            <div class="admin-usuario">${escapar(a.usuario)}${a.usuario === usuarioActual ? ' <span class="admin-meta">(vos)</span>' : ''}</div>
            <div class="admin-meta">Creado ${escapar(new Date(a.creadoEl).toLocaleDateString('es-AR'))}${a.creadoPor ? ' por ' + escapar(a.creadoPor) : ''}</div>
          </div>
          ${a.usuario === usuarioActual ? '' : `<button class="boton-texto" data-eliminar="${escapar(a.usuario)}">Eliminar</button>`}
        </div>`).join('');

      $('listaAdmins').querySelectorAll('[data-eliminar]').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm(`¿Eliminar al administrador "${b.dataset.eliminar}"?`)) return;
          try {
            await pedir('/api/admin/admins/' + encodeURIComponent(b.dataset.eliminar), { method: 'DELETE' });
            cargarAdmins();
          } catch (e) { mostrarEstado('estadoAdmins', e.message, 'error'); }
        });
      });
    } catch (e) {
      mostrarEstado('estadoAdmins', e.message, 'error');
    }
  }

  $('btnCrearAdmin').addEventListener('click', async () => {
    try {
      await pedir('/api/admin/admins', {
        method: 'POST',
        body: JSON.stringify({ usuario: $('nuevoUsuario').value.trim(), contrasena: $('nuevaClave').value }),
      });
      $('nuevoUsuario').value = ''; $('nuevaClave').value = '';
      mostrarEstado('estadoAdmins', 'Administrador creado.', 'ok');
      cargarAdmins();
    } catch (e) {
      mostrarEstado('estadoAdmins', e.message, 'error');
    }
  });

  // ─── Mi cuenta ───────────────────────────────────────────────────────
  $('btnCambiarClave').addEventListener('click', async () => {
    try {
      await pedir('/api/admin/contrasena', {
        method: 'POST',
        body: JSON.stringify({ actual: $('claveActual').value, nueva: $('claveNueva').value }),
      });
      $('claveActual').value = ''; $('claveNueva').value = '';
      mostrarEstado('estadoCuenta', 'Contraseña actualizada.', 'ok');
    } catch (e) {
      mostrarEstado('estadoCuenta', e.message, 'error');
    }
  });

  arrancar().catch(e => {
    document.body.innerHTML = `<main class="ancho"><div class="tarjeta">No se pudo cargar el panel: ${escapar(e.message)}</div></main>`;
  });
})();
