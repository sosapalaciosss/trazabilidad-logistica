/**
 * Servidor principal de la Plataforma de Trazabilidad Logistica.
 * Motor: Node.js + Express. Base de datos: SQLite.
 */
const path = require('path');
const express = require('express');
const { db, init, TRIP_STATES } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Minutos sin cambiar de estado tras los cuales un viaje se marca "atascado".
const UMBRAL_ALERTA_MIN = Number(process.env.UMBRAL_ALERTA_MIN) || 60;

// Asegura que las tablas existan al arrancar.
init();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Utilidades ---

function obtenerTrip(idOcodigo) {
  return db
    .prepare('SELECT * FROM trips WHERE id = ? OR codigo = ?')
    .get(idOcodigo, idOcodigo);
}

function obtenerEventos(tripId) {
  return db
    .prepare('SELECT * FROM events WHERE trip_id = ? ORDER BY creado_en ASC, id ASC')
    .all(tripId);
}

// --- API ---

// Comprobacion de salud: confirma que el servidor responde.
app.get('/api/salud', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM trips').get().n;
  res.json({ ok: true, mensaje: 'Servidor en linea', viajes: total });
});

// Lista de estados posibles (en orden).
app.get('/api/estados', (req, res) => {
  res.json({ estados: TRIP_STATES });
});

// Todos los viajes (para el panel del dueno).
app.get('/api/viajes', (req, res) => {
  const viajes = db.prepare('SELECT * FROM trips ORDER BY actualizado_en DESC').all();
  res.json({ viajes });
});

// Panel del dueno: todos los viajes con tiempo sin cambio y alertas.
app.get('/api/panel', (req, res) => {
  const estadoFinal = TRIP_STATES[TRIP_STATES.length - 1];
  const viajes = db.prepare(`
    SELECT *,
      CAST((julianday('now') - julianday(actualizado_en)) * 1440 AS INTEGER) AS minutos_inactivo
    FROM trips
    ORDER BY actualizado_en ASC
  `).all();

  for (const v of viajes) {
    v.finalizado = v.estado_actual === estadoFinal;
    // Solo se alerta de viajes activos (no finalizados) que llevan demasiado tiempo igual.
    v.alerta = !v.finalizado && v.minutos_inactivo >= UMBRAL_ALERTA_MIN;
  }

  res.json({
    umbral_min: UMBRAL_ALERTA_MIN,
    activos: viajes.filter(v => !v.finalizado).length,
    finalizados: viajes.filter(v => v.finalizado).length,
    en_alerta: viajes.filter(v => v.alerta).length,
    viajes,
  });
});

// Un viaje con su historial (por id o por codigo de seguimiento).
app.get('/api/viajes/:idOcodigo', (req, res) => {
  const trip = obtenerTrip(req.params.idOcodigo);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
  res.json({ viaje: trip, eventos: obtenerEventos(trip.id) });
});

// Registrar un nuevo evento en un viaje (lo usa la Vista del Conductor).
// Avanza el estado del viaje y guarda el evento en el historial.
app.post('/api/viajes/:idOcodigo/eventos', (req, res) => {
  const trip = obtenerTrip(req.params.idOcodigo);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });

  const { estado, nota } = req.body || {};
  if (!estado || !TRIP_STATES.includes(estado)) {
    return res.status(400).json({ error: 'Estado invalido' });
  }

  // El estado solo puede avanzar (no retroceder ni repetirse).
  const posActual = TRIP_STATES.indexOf(trip.estado_actual);
  const posNuevo = TRIP_STATES.indexOf(estado);
  if (posNuevo <= posActual) {
    return res.status(400).json({
      error: `El viaje ya esta en "${trip.estado_actual}" o mas avanzado.`,
    });
  }

  const guardar = db.transaction(() => {
    db.prepare('INSERT INTO events (trip_id, estado, nota) VALUES (?, ?, ?)')
      .run(trip.id, estado, (nota || '').trim() || null);
    db.prepare("UPDATE trips SET estado_actual = ?, actualizado_en = datetime('now') WHERE id = ?")
      .run(estado, trip.id);
  });
  guardar();

  const actualizado = obtenerTrip(trip.id);
  res.json({ ok: true, viaje: actualizado, eventos: obtenerEventos(trip.id) });
});

// Recibir la ubicacion actual del motorista (lo envia su telefono).
app.post('/api/viajes/:idOcodigo/ubicacion', (req, res) => {
  const trip = obtenerTrip(req.params.idOcodigo);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });

  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Coordenadas invalidas' });
  }

  db.prepare("UPDATE trips SET lat = ?, lng = ?, ubicacion_en = datetime('now') WHERE id = ?")
    .run(lat, lng, trip.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  Plataforma de Trazabilidad Logistica`);
  console.log(`  Servidor en linea: http://localhost:${PORT}`);
  console.log(`  Comprobacion:      http://localhost:${PORT}/api/salud\n`);
});
