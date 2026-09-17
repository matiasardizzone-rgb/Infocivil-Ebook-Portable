// src/local/paths.js
const fs = require('fs');
const path = require('path');

/**
 * Resuelve la raíz de la instalación portable.
 * - Si corre empaquetado (pkg/nexe): process.pkg existe → usamos el directorio del .exe.
 * - Si corre con `node server.js`: usamos cwd (desde donde se invocó).
 * Esto garantiza que data/, expedientes/, logs/ queden SIEMPRE al lado del ejecutable,
 * sin importar desde dónde se lo corra.
 */
function resolveAppRoot() {
  if (process.pkg && process.execPath) {
    return path.dirname(process.execPath);
  }
  // Fallback: subimos desde __dirname hasta encontrar package.json o llegar a la raíz
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const APP_ROOT = resolveAppRoot();

const PATHS = {
  root: APP_ROOT,
  data: path.join(APP_ROOT, 'data'),
  expedientes: path.join(APP_ROOT, 'expedientes'),
  logs: path.join(APP_ROOT, 'logs'),
  config: path.join(APP_ROOT, 'config.local.json'),
  version: path.join(APP_ROOT, 'version.json'),
  public: path.join(APP_ROOT, 'src', 'public'),
};

// Crear carpetas si no existen (idempotente)
function ensureDirs() {
  for (const key of ['data', 'expedientes', 'logs']) {
    const p = PATHS[key];
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

module.exports = { PATHS, ensureDirs, resolveAppRoot };