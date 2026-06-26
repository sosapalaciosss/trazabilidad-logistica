/**
 * Carga datos de prueba: 3 viajes de ejemplo con su historial.
 * Se puede ejecutar varias veces sin duplicar (borra y vuelve a cargar).
 */
const { db, init, TRIP_STATES } = require('./db');

init();

const ejemplos = [
  {
    codigo: 'TRK-1001',
    cliente: 'Distribuidora El Sol',
    origen: 'San Salvador',
    destino: 'Santa Ana',
    conductor: 'Carlos Mejia',
    estado_actual: 'En ruta',
    lat: 13.8400, lng: -89.3900, // a medio camino San Salvador -> Santa Ana
    eventos: [
      { estado: 'Pendiente', nota: 'Viaje creado' },
      { estado: 'Inicio de carga', nota: 'Carga de 200 cajas' },
      { estado: 'En ruta', nota: 'Salida de bodega central' },
    ],
  },
  {
    codigo: 'TRK-1002',
    cliente: 'Ferreteria La Union',
    origen: 'La Libertad',
    destino: 'San Miguel',
    conductor: 'Ana Ramirez',
    estado_actual: 'Llegada al destino',
    lat: 13.4833, lng: -88.1833, // San Miguel (destino)
    eventos: [
      { estado: 'Pendiente', nota: 'Viaje creado' },
      { estado: 'Inicio de carga', nota: 'Materiales de construccion' },
      { estado: 'En ruta', nota: 'En carretera Panamericana' },
      { estado: 'Llegada al destino', nota: 'Entregado y firmado' },
    ],
  },
  {
    codigo: 'TRK-1003',
    cliente: 'Supermercados Vida',
    origen: 'Soyapango',
    destino: 'Sonsonate',
    conductor: 'Jose Portillo',
    estado_actual: 'Pendiente',
    lat: null, lng: null, // aun sin ubicacion (no ha salido)
    eventos: [
      { estado: 'Pendiente', nota: 'Viaje creado, esperando carga' },
    ],
  },
];

const borrarEventos = db.prepare('DELETE FROM events');
const borrarTrips = db.prepare('DELETE FROM trips');

const insertarTrip = db.prepare(`
  INSERT INTO trips (codigo, cliente, origen, destino, conductor, estado_actual, lat, lng)
  VALUES (@codigo, @cliente, @origen, @destino, @conductor, @estado_actual, @lat, @lng)
`);

const insertarEvento = db.prepare(`
  INSERT INTO events (trip_id, estado, nota) VALUES (?, ?, ?)
`);

const cargar = db.transaction(() => {
  borrarEventos.run();
  borrarTrips.run();
  for (const t of ejemplos) {
    const { lastInsertRowid } = insertarTrip.run(t);
    for (const e of t.eventos) {
      insertarEvento.run(lastInsertRowid, e.estado, e.nota);
    }
  }
});

cargar();

// Para la demo: dejamos TRK-1003 "atascado" (sin cambios desde hace 3 horas)
// para que el Panel del Dueno muestre una alerta de inmediato.
db.prepare("UPDATE trips SET actualizado_en = datetime('now', '-3 hours') WHERE codigo = 'TRK-1003'").run();

const total = db.prepare('SELECT COUNT(*) AS n FROM trips').get().n;
console.log(`Datos de prueba cargados: ${total} viajes.`);
console.log('Estados disponibles:', TRIP_STATES.join(' -> '));
