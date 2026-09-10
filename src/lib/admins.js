// admins.js — administradores del panel de auditoría.
//
// Las contraseñas se guardan solo como hash scrypt con sal por usuario
// (scrypt viene en Node, no hace falta dependencia externa, y está pensado
// justamente para contraseñas: es caro de calcular a propósito).
//
// No hay contraseña inicial escrita en ningún lado: la primera vez que se
// entra al panel, si no existe ningún administrador, se pide crear el
// primero. Así no queda ninguna credencial en el repositorio ni en la
// configuración del servicio.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR_DATOS } from './auditoria.js';

const ARCHIVO = path.join(DIR_DATOS, 'admins.json');
const DURACION_SESION_MS = 8 * 60 * 60 * 1000; // 8 horas

function leerArchivo() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  } catch {
    return [];
  }
}

function escribirArchivo(lista) {
  fs.mkdirSync(DIR_DATOS, { recursive: true });
  fs.writeFileSync(ARCHIVO, JSON.stringify(lista, null, 2), 'utf8');
  // Solo el usuario del servicio puede leer el archivo de credenciales.
  try { fs.chmodSync(ARCHIVO, 0o600); } catch { /* sistemas sin chmod */ }
}

function hashear(contrasena, sal) {
  return crypto.scryptSync(contrasena, sal, 64).toString('hex');
}

// El usuario es de criterio libre: puede ser un CUIL, un nombre y apellido,
// un alias, con mayúsculas, espacios o acentos. Lo único que se exige es un
// largo razonable. La comparación al ingresar es sin distinguir mayúsculas
// (para que no falle por cómo se escribió), pero se conserva la forma
// original para mostrarla.
function validarUsuario(usuario) {
  const limpio = String(usuario || '').trim();
  if (limpio.length < 3 || limpio.length > 32) {
    throw new Error('El usuario debe tener entre 3 y 32 caracteres.');
  }
  return limpio;
}

// La exigencia va en la contraseña, que es lo que protege el acceso.
function validarContrasena(contrasena) {
  const c = String(contrasena || '');
  if (c.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
  if (!/[A-ZÁÉÍÓÚÑ]/.test(c)) throw new Error('La contraseña debe incluir al menos una mayúscula.');
  if (!/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/.test(c)) {
    throw new Error('La contraseña debe incluir al menos un carácter especial (por ejemplo: . , - _ ! @ # $ %).');
  }
  return c;
}

function normalizar(usuario) {
  return String(usuario || '').trim().toLocaleLowerCase('es');
}

export function hayAdmins() {
  return leerArchivo().length > 0;
}

export function listarAdmins() {
  return leerArchivo().map(a => ({ usuario: a.usuario, creadoEl: a.creadoEl, creadoPor: a.creadoPor || null }));
}

export function crearAdmin(usuario, contrasena, creadoPor = null) {
  const nombre = validarUsuario(usuario);
  validarContrasena(contrasena);

  const lista = leerArchivo();
  if (lista.some(a => normalizar(a.usuario) === normalizar(nombre))) {
    throw new Error('Ya existe un administrador con ese usuario.');
  }

  const sal = crypto.randomBytes(16).toString('hex');
  lista.push({
    usuario: nombre,
    sal,
    hash: hashear(contrasena, sal),
    creadoEl: new Date().toISOString(),
    creadoPor,
  });
  escribirArchivo(lista);
  return { usuario: nombre };
}

export function eliminarAdmin(usuario) {
  const lista = leerArchivo();
  if (lista.length <= 1) {
    throw new Error('No se puede eliminar el único administrador que queda.');
  }
  const nueva = lista.filter(a => normalizar(a.usuario) !== normalizar(usuario));
  if (nueva.length === lista.length) throw new Error('No existe ese administrador.');
  escribirArchivo(nueva);
}

export function cambiarContrasena(usuario, nueva) {
  validarContrasena(nueva);
  const lista = leerArchivo();
  const a = lista.find(x => normalizar(x.usuario) === normalizar(usuario));
  if (!a) throw new Error('No existe ese administrador.');
  a.sal = crypto.randomBytes(16).toString('hex');
  a.hash = hashear(nueva, a.sal);
  escribirArchivo(lista);
}

export function verificar(usuario, contrasena) {
  const a = leerArchivo().find(x => normalizar(x.usuario) === normalizar(usuario));
  if (!a) return false;
  const calculado = Buffer.from(hashear(contrasena, a.sal), 'hex');
  const guardado = Buffer.from(a.hash, 'hex');
  if (calculado.length !== guardado.length) return false;
  // Comparación en tiempo constante: evita filtrar información por el
  // tiempo que tarda en fallar.
  return crypto.timingSafeEqual(calculado, guardado);
}

/** El nombre tal como fue registrado, respetando cómo se escribió. */
export function nombreReal(usuario) {
  const a = leerArchivo().find(x => normalizar(x.usuario) === normalizar(usuario));
  return a ? a.usuario : null;
}

// ─── Sesiones ───────────────────────────────────────────────────────────
// En memoria: se pierden al reiniciar el servicio, que para un panel de
// auditoría de uso ocasional es aceptable (se vuelve a entrar) y evita
// tener que manejar un secreto de firma persistente.
const sesiones = new Map(); // token -> { usuario, vence }

export function crearSesion(usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, { usuario, vence: Date.now() + DURACION_SESION_MS });
  return token;
}

export function usuarioDeSesion(token) {
  const s = sesiones.get(token);
  if (!s) return null;
  if (s.vence < Date.now()) { sesiones.delete(token); return null; }
  return s.usuario;
}

export function cerrarSesion(token) {
  sesiones.delete(token);
}

/** Lee una cookie del pedido sin depender de un parser externo. */
export function leerCookie(req, nombre) {
  const crudo = req.headers.cookie;
  if (!crudo) return null;
  for (const parte of crudo.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}
