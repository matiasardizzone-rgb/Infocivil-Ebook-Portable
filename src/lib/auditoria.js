// auditoria.js — registro de operaciones para auditoría.
//
// Formato JSONL (un objeto JSON por línea): es append-only, no se corrompe
// si el proceso muere a mitad de una escritura, se puede leer con
// herramientas de línea de comandos, y no necesita una base de datos.
//
// Se registra QUÉ se hizo, SOBRE QUÉ expediente y DESDE QUÉ IP. No se
// guardan los documentos ni su contenido: el servicio sigue sin almacenar
// expedientes.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DIR_DATOS = process.env.INFOCIVIL_DATOS || path.join(process.cwd(), 'datos');
const DIR_LOGS = path.join(DIR_DATOS, 'auditoria');

function asegurarDirectorio() {
  fs.mkdirSync(DIR_LOGS, { recursive: true });
}

// Un archivo por día: mantiene los archivos manejables y hace trivial
// borrar o archivar períodos viejos según la política de retención que se
// defina.
function archivoDelDia(fecha = new Date()) {
  const d = fecha.toISOString().slice(0, 10);
  return path.join(DIR_LOGS, `${d}.jsonl`);
}

/**
 * La IP real del cliente. Si el servicio queda detrás de un proxy inverso
 * (Apache/nginx, como el resto de las apps del fuero), la IP de la conexión
 * es la del proxy: en ese caso vale la primera de X-Forwarded-For.
 */
export function ipDe(req) {
  const reenviada = req.headers['x-forwarded-for'];
  if (reenviada) return String(reenviada).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'desconocida';
}

/**
 * @param {object} datos
 * @param {string} datos.operacion  ej. 'buscar', 'descargar-zip', 'leer'
 * @param {string} [datos.expediente] ej. 'CIV 86101/2021'
 * @param {string} [datos.cid]
 * @param {string} datos.ip
 * @param {object} [datos.detalle]  cualquier dato extra propio de la operación
 */
export function registrar(datos) {
  try {
    asegurarDirectorio();
    const linea = JSON.stringify({
      fecha: new Date().toISOString(),
      operacion: datos.operacion,
      expediente: datos.expediente || null,
      cid: datos.cid || null,
      ip: datos.ip,
      usuario: datos.usuario || null,
      detalle: datos.detalle || null,
    }) + '\n';
    fs.appendFileSync(archivoDelDia(), linea, 'utf8');
  } catch (err) {
    // La auditoría nunca debe tumbar el servicio: si falla el registro se
    // deja constancia en el log del proceso y se sigue.
    console.error('[auditoria] No se pudo registrar:', err.message);
  }
}

/** Días con registro, del más reciente al más viejo. */
export function diasDisponibles() {
  try {
    asegurarDirectorio();
    return fs.readdirSync(DIR_LOGS)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Lee las entradas de un día, de la más reciente a la más vieja.
 * Se lee línea por línea para no cargar en memoria un archivo grande.
 */
export async function leerDia(dia, { texto = '', limite = 500 } = {}) {
  const archivo = path.join(DIR_LOGS, `${dia}.jsonl`);
  if (!fs.existsSync(archivo)) return [];

  const filtro = texto.trim().toLowerCase();
  const entradas = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(archivo, 'utf8'),
    crlfDelay: Infinity,
  });

  for await (const linea of rl) {
    if (!linea.trim()) continue;
    try {
      const e = JSON.parse(linea);
      if (filtro) {
        const busca = `${e.operacion} ${e.expediente || ''} ${e.ip} ${e.usuario || ''}`.toLowerCase();
        if (!busca.includes(filtro)) continue;
      }
      entradas.push(e);
    } catch { /* línea corrupta: se ignora, el resto del archivo sigue sirviendo */ }
  }

  return entradas.reverse().slice(0, limite);
}

export { DIR_DATOS };
