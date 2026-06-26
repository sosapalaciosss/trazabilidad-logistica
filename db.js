/**
 * Conexion y esquema de la base de datos (SQLite).
 * La base de datos es un unico archivo: datos.db
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'datos.db');
const db = new Database(DB_PATH);

// Mejora la fiabilidad de la escritura en disco.
db.pragma('journal_mode = WAL');

/**
 * Estados posibles de un viaje, en orden secuencial.
 * Toda la app (conductor, cliente, dueno) usa esta misma lista.
 */
const TRIP_STATES = [
  'Pendiente',
  'Inicio de carga',
  'En ruta',
  'Llegada al destino',
];

/** Crea las tablas si no existen. */
function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo        TEXT NOT NULL UNIQUE,
      cliente       TEXT NOT NULL,
      origen        TEXT NOT NULL,
      destino       TEXT NOT NULL,
      conductor     TEXT NOT NULL,
      estado_actual TEXT NOT NULL DEFAULT 'Pendiente',
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id   INTEGER NOT NULL,
      estado    TEXT NOT NULL,
      nota      TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
    );
  `);

  // Migracion: columnas de ubicacion (se agregan solo si faltan).
  const columnas = db.prepare("PRAGMA table_info(trips)").all().map(c => c.name);
  if (!columnas.includes('lat')) db.exec('ALTER TABLE trips ADD COLUMN lat REAL');
  if (!columnas.includes('lng')) db.exec('ALTER TABLE trips ADD COLUMN lng REAL');
  if (!columnas.includes('ubicacion_en')) db.exec('ALTER TABLE trips ADD COLUMN ubicacion_en TEXT');
}

module.exports = { db, init, TRIP_STATES, DB_PATH };
