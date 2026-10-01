/**
 * Servidor principal de la Plataforma de Trazabilidad Logistica.
 * Motor: Node.js + Express. Base de datos: SQLite.
 */
const path = require('path');
const express = require('express');
const { db, init, TRIP_STATES, obtenerConfig } = require('./db');

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

// --- Cotizaciones / prospectos (Fase 1: captar clientes) ---

// Recibir una solicitud de cotizacion desde la landing page.
app.post('/api/cotizaciones', (req, res) => {
  const { nombre, telefono, origen, destino, carga, mensaje } = req.body || {};
  if (!nombre || !String(nombre).trim() || !telefono || !String(telefono).trim()) {
    return res.status(400).json({ error: 'El nombre y el telefono son obligatorios.' });
  }
  const limpiar = (v) => (v == null ? null : String(v).trim() || null);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO leads (nombre, telefono, origen, destino, carga, mensaje)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(nombre).trim(), String(telefono).trim(),
    limpiar(origen), limpiar(destino), limpiar(carga), limpiar(mensaje),
  );
  res.json({ ok: true, id: lastInsertRowid });
});

// Listar las cotizaciones (lo usa el Panel del Dueno).
app.get('/api/cotizaciones', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY creado_en DESC, id DESC').all();
  res.json({ leads, pendientes: leads.filter(l => !l.atendido).length });
});

// Marcar una cotizacion como atendida / no atendida.
app.patch('/api/cotizaciones/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Cotizacion no encontrada' });
  const atendido = req.body && req.body.atendido ? 1 : 0;
  db.prepare('UPDATE leads SET atendido = ? WHERE id = ?').run(atendido, lead.id);
  res.json({ ok: true });
});

// --- Contenido / SEO / IA (capa generada desde la base de datos) ---

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Lista de zonas de cobertura (para la landing y el panel).
app.get('/api/zonas', (req, res) => {
  const zonas = db.prepare('SELECT slug, nombre, descripcion FROM zonas WHERE activo = 1 ORDER BY nombre').all();
  res.json({ zonas });
});

// Preguntas frecuentes (alimentan la landing y a los motores de IA).
app.get('/api/faqs', (req, res) => {
  const faqs = db.prepare('SELECT pregunta, respuesta FROM faqs WHERE activo = 1 ORDER BY orden, id').all();
  res.json({ faqs });
});

// Sitemap generado desde la base de datos: siempre refleja el contenido actual.
app.get('/sitemap.xml', (req, res) => {
  const cfg = obtenerConfig();
  const base = (cfg.dominio || '').replace(/\/+$/, '');
  const zonas = db.prepare('SELECT slug, actualizado_en FROM zonas WHERE activo = 1').all();
  const hoy = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: base + '/', freq: 'weekly', pri: '1.0', mod: hoy },
    { loc: base + '/cliente.html', freq: 'monthly', pri: '0.6', mod: hoy },
    ...zonas.map(z => ({
      loc: base + '/zona/' + z.slug, freq: 'monthly', pri: '0.8',
      mod: (z.actualizado_en || hoy).slice(0, 10),
    })),
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u =>
      `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.mod}</lastmod>` +
      `<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`
    ).join('\n') + '\n</urlset>\n';
  res.type('application/xml').send(xml);
});

// Pagina optimizada por zona de cobertura (SEO local + IA), generada desde datos.
app.get('/zona/:slug', (req, res) => {
  const zona = db.prepare('SELECT * FROM zonas WHERE slug = ? AND activo = 1').get(req.params.slug);
  if (!zona) return res.status(404).redirect('/');
  const cfg = obtenerConfig();
  const faqs = db.prepare('SELECT pregunta, respuesta FROM faqs WHERE activo = 1 ORDER BY orden, id').all();
  res.type('html').send(paginaZona(zona, cfg, faqs));
});

function paginaZona(zona, cfg, faqs) {
  const base = (cfg.dominio || '').replace(/\/+$/, '');
  const url = base + '/zona/' + zona.slug;
  const titulo = `Transporte de carga y fletes en ${zona.nombre} | ${cfg.nombre}`;
  const desc = `Fletes empresariales y distribucion de mercancia en ${zona.nombre}, El Salvador. ` +
    `Cotiza en linea y rastrea tu pedido en tiempo real. Tel: ${cfg.telefono}.`;
  const wa = 'https://wa.me/' + cfg.whatsapp + '?text=' +
    encodeURIComponent(`Hola, quiero cotizar un envio en ${zona.nombre} con ${cfg.nombre}.`);

  const ldLocal = {
    '@context': 'https://schema.org', '@type': 'MovingCompany',
    name: `${cfg.nombre} — ${zona.nombre}`, description: desc,
    telephone: cfg.telefono, url,
    areaServed: { '@type': 'AdministrativeArea', name: `${zona.nombre}, El Salvador` },
    address: { '@type': 'PostalAddress', addressRegion: zona.nombre, addressCountry: 'SV' },
  };
  const ldFaq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question', name: f.pregunta,
      acceptedAnswer: { '@type': 'Answer', text: f.respuesta },
    })),
  };
  const faqHtml = faqs.map(f =>
    `<details style="background:#fff;border:1px solid #eaf0f8;border-radius:14px;padding:16px 20px;margin-bottom:10px;">
       <summary style="font-weight:700;color:#0f2a47;cursor:pointer;">${esc(f.pregunta)}</summary>
       <p style="margin:10px 0 0;color:#51637a;line-height:1.6;">${esc(f.respuesta)}</p>
     </details>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(titulo)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:title" content="${esc(titulo)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${esc(url)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script type="application/ld+json">${JSON.stringify(ldLocal)}</script>
  <script type="application/ld+json">${JSON.stringify(ldFaq)}</script>
  <style>
    *{box-sizing:border-box;} body{margin:0;font-family:'Poppins',system-ui,sans-serif;color:#16263a;background:#fff;}
    a{color:inherit;} .wrap{max-width:900px;margin:0 auto;padding:0 24px;}
    header{position:sticky;top:0;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-bottom:1px solid #e9eff7;}
    .bar{display:flex;align-items:center;justify-content:space-between;height:70px;max-width:900px;margin:0 auto;padding:0 24px;}
    .logo .m1{font-size:10px;letter-spacing:5px;font-weight:600;color:#1877d6;display:block;}
    .logo .m2{font-size:22px;font-weight:800;color:#004d99;}
    .btn{display:inline-block;text-decoration:none;background:#1877d6;color:#fff;font-weight:600;padding:12px 22px;border-radius:11px;}
    .hero{background:linear-gradient(180deg,#fff,#f4f9ff);padding:56px 0;}
    h1{font-size:clamp(28px,4.4vw,46px);font-weight:800;color:#0f2a47;letter-spacing:-.02em;margin:0 0 16px;line-height:1.1;}
    .lead{font-size:18px;color:#51637a;line-height:1.65;margin:0 0 26px;max-width:640px;}
    .acciones{display:flex;gap:12px;flex-wrap:wrap;}
    .wa{background:#25D366;}
    section{padding:44px 0;}
    h2{font-size:26px;font-weight:800;color:#0f2a47;margin:0 0 18px;}
    .servs{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;}
    .card{border:1px solid #eaf0f8;border-radius:16px;padding:22px;box-shadow:0 18px 40px -30px rgba(20,50,90,.3);}
    .card h3{margin:0 0 8px;color:#0f2a47;} .card p{margin:0;color:#51637a;line-height:1.55;font-size:14.5px;}
    footer{background:#004d99;color:#cfe0f3;padding:34px 0;margin-top:30px;}
    footer a{color:#fff;font-weight:600;text-decoration:none;}
  </style>
</head>
<body>
  <header><div class="bar">
    <a class="logo" href="/" style="text-decoration:none;"><span class="m1">TRANSPORTE</span><span class="m2">D Todo</span></a>
    <a class="btn" href="/#cotiza">Cotiza Hoy</a>
  </div></header>

  <div class="hero"><div class="wrap">
    <h1>Transporte de carga y fletes en ${esc(zona.nombre)}</h1>
    <p class="lead">${esc(zona.descripcion)}</p>
    <div class="acciones">
      <a class="btn" href="/#cotiza">Solicitar cotizacion</a>
      <a class="btn wa" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp ${esc(cfg.telefono)}</a>
    </div>
  </div></div>

  <section><div class="wrap">
    <h2>Nuestros servicios en ${esc(zona.nombre)}</h2>
    <div class="servs">
      <div class="card"><h3>Fletes empresariales</h3><p>Transporte dedicado para tu empresa en ${esc(zona.nombre)}, con flota propia y rutas programadas.</p></div>
      <div class="card"><h3>Distribucion de mercancia</h3><p>Entregas puntuales hacia tus clientes y puntos de venta en ${esc(zona.nombre)} y todo el pais.</p></div>
      <div class="card"><h3>Seguimiento en vivo</h3><p>Rastrea tu pedido con tu codigo y mira la ubicacion del camion en tiempo real.</p></div>
    </div>
  </div></section>

  <section><div class="wrap">
    <h2>Preguntas frecuentes</h2>
    ${faqHtml}
  </div></section>

  <footer><div class="wrap">
    ${esc(cfg.nombre)} — ${esc(cfg.eslogan)}<br>
    Tel: <a href="tel:${esc(cfg.telefono)}">${esc(cfg.telefono)}</a> ·
    <a href="/">Ir al inicio</a> · <a href="/#rastrear">Rastrear pedido</a>
  </div></footer>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`\n  Plataforma de Trazabilidad Logistica`);
  console.log(`  Servidor en linea: http://localhost:${PORT}`);
  console.log(`  Comprobacion:      http://localhost:${PORT}/api/salud\n`);
});
