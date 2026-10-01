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

    -- Solicitudes de cotizacion que llegan desde la landing page.
    CREATE TABLE IF NOT EXISTS leads (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre    TEXT NOT NULL,
      telefono  TEXT NOT NULL,
      origen    TEXT,
      destino   TEXT,
      carga     TEXT,
      mensaje   TEXT,
      atendido  INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Capa de CONTENIDO (SEO / IA / marketing), editable y siempre fresca.
    -- Datos del negocio en un solo lugar (telefono, whatsapp, dominio...).
    CREATE TABLE IF NOT EXISTS config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
    -- Zonas de cobertura: cada una genera su propia pagina optimizada.
    CREATE TABLE IF NOT EXISTS zonas (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      slug           TEXT NOT NULL UNIQUE,
      nombre         TEXT NOT NULL,
      descripcion    TEXT,
      activo         INTEGER NOT NULL DEFAULT 1,
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Preguntas frecuentes: alimentan la pagina y a los motores de IA.
    CREATE TABLE IF NOT EXISTS faqs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pregunta  TEXT NOT NULL,
      respuesta TEXT NOT NULL,
      orden     INTEGER NOT NULL DEFAULT 0,
      activo    INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Migracion: columnas de ubicacion (se agregan solo si faltan).
  const columnas = db.prepare("PRAGMA table_info(trips)").all().map(c => c.name);
  if (!columnas.includes('lat')) db.exec('ALTER TABLE trips ADD COLUMN lat REAL');
  if (!columnas.includes('lng')) db.exec('ALTER TABLE trips ADD COLUMN lng REAL');
  if (!columnas.includes('ubicacion_en')) db.exec('ALTER TABLE trips ADD COLUMN ubicacion_en TEXT');

  sembrarContenido();
}

/**
 * Carga el contenido inicial (config, zonas, FAQs) solo si aun no existe.
 * Se puede editar despues desde la base de datos sin tocar el codigo.
 */
function sembrarContenido() {
  const fijarConfig = db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)');
  const config = {
    nombre: 'Transporte D Todo',
    telefono: '+503 7593-7814',
    whatsapp: '50375937814',
    dominio: 'https://transportedtodo.com',
    eslogan: 'El transporte que tu empresa necesita, la tranquilidad que tu mereces.',
  };
  for (const [k, v] of Object.entries(config)) fijarConfig.run(k, v);

  const totalZonas = db.prepare('SELECT COUNT(*) AS n FROM zonas').get().n;
  if (totalZonas === 0) {
    const deptos = [
      'Ahuachapan', 'Santa Ana', 'Sonsonate', 'La Libertad', 'San Salvador',
      'Chalatenango', 'Cuscatlan', 'La Paz', 'Cabanas', 'San Vicente',
      'Usulutan', 'San Miguel', 'Morazan', 'La Union',
    ];
    const slugify = (s) => s.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const insZona = db.prepare('INSERT INTO zonas (slug, nombre, descripcion) VALUES (?, ?, ?)');
    const cargar = db.transaction(() => {
      for (const d of deptos) {
        insZona.run(
          slugify(d), d,
          `Transporte de carga, fletes empresariales y distribucion de mercancia en ${d}, El Salvador. ` +
          `Recogemos y entregamos en ${d} con seguimiento de tu pedido en tiempo real.`,
        );
      }
    });
    cargar();
  }

  const totalFaqs = db.prepare('SELECT COUNT(*) AS n FROM faqs').get().n;
  if (totalFaqs === 0) {
    const faqs = [
      ['Cuanto cuesta un flete en El Salvador?',
       'El costo depende del origen, el destino, el tipo y el volumen de la carga. Envianos los datos por el formulario o por WhatsApp y te damos una cotizacion sin compromiso.'],
      ['A que zonas llegan?',
       'Damos cobertura en los 14 departamentos de El Salvador, de norte a sur y de oriente a occidente.'],
      ['Como rastreo mi pedido?',
       'Con el codigo de seguimiento que te compartimos, en la seccion "Rastrear pedido" de nuestra pagina ves el estado y la ubicacion del camion en tiempo real.'],
      ['Que tipo de carga transportan?',
       'Transportamos carga empresarial y distribucion de mercancia. Cuentanos que necesitas mover y te confirmamos la unidad adecuada.'],
      ['Como solicito una cotizacion?',
       'Llena el formulario "Solicita tu cotizacion" en la pagina o escribenos por WhatsApp al +503 7593-7814.'],
    ];
    const insFaq = db.prepare('INSERT INTO faqs (pregunta, respuesta, orden) VALUES (?, ?, ?)');
    const cargar = db.transaction(() => { faqs.forEach((f, i) => insFaq.run(f[0], f[1], i)); });
    cargar();
  }
}

/** Lee toda la config como un objeto { clave: valor }. */
function obtenerConfig() {
  const filas = db.prepare('SELECT clave, valor FROM config').all();
  return Object.fromEntries(filas.map(f => [f.clave, f.valor]));
}

module.exports = { db, init, TRIP_STATES, DB_PATH, obtenerConfig };
