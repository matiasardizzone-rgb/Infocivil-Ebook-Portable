// src/local/storage.js
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');

const FILE = path.join(PATHS.data, 'mis-expedientes.json');
let queue = Promise.resolve(); // serializa escrituras

function read() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[storage] lectura corrupta, reiniciando:', e.message);
    return [];
  }
}

function write(list) {
  queue = queue.then(() =>
    fs.promises.writeFile(FILE, JSON.stringify(list, null, 2), 'utf8')
  );
  return queue;
}

async function add(entry) {
  const list = read();
  list.unshift({ ...entry, addedAt: new Date().toISOString() });
  // Tope razonable para no inflar el JSON
  if (list.length > 500) list.length = 500;
  await write(list);
  return entry;
}

async function remove(id) {
  const list = read().filter(e => e.id !== id);
  await write(list);
}

async function list() {
  return read();
}

module.exports = { add, remove, list };