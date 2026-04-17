'use strict';
const express = require('express');
const { Pool } = require('pg');
const app  = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: '50kb' }));

// Allow all origins (website, app, admin)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// DB connection
const db = new Pool({
  host:     process.env.PGHOST     || '10.0.1.3',
  port:     parseInt(process.env.PGPORT) || 5432,
  user:     process.env.PGUSER     || 'valcrown_user',
  password: process.env.PGPASSWORD || 'DGM63tr9b@#@',
  database: process.env.PGDATABASE || 'valcrown_db',
  ssl:      false,
  max:      5,
});

// Auth
const API_KEY = process.env.ANALYTICS_KEY || 'vc-analytics-2026';
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Init tables
async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id          BIGSERIAL PRIMARY KEY,
      event       VARCHAR(100) NOT NULL,
      properties  JSONB DEFAULT '{}',
      session_id  VARCHAR(100),
      user_id     UUID,
      page        VARCHAR(500),
      referrer    VARCHAR(500),
      country     VARCHAR(10),
      device      VARCHAR(50),
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at)`);
  console.log('[Analytics] Tables ready');
}

// ── TRACK EVENT (public — called from website/app) ────────────────────────────
app.post('/track', async (req, res) => {
  try {
    const { event, properties = {}, session_id, user_id, page, referrer } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });

    // Detect device from user agent
    const ua     = req.headers['user-agent'] || '';
    const device = /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';

    await db.query(
      `INSERT INTO analytics_events (event, properties, session_id, user_id, page, referrer, device)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event, JSON.stringify(properties), session_id || null, user_id || null, page || null, referrer || null, device]
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[Analytics] Track error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BATCH TRACK (for multiple events) ────────────────────────────────────────
app.post('/track/batch', async (req, res) => {
  try {
    const { events = [] } = req.body;
    for (const ev of events.slice(0, 50)) {
      const { event, properties = {}, session_id, user_id, page } = ev;
      if (!event) continue;
      const ua = req.headers['user-agent'] || '';
      const device = /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
      await db.query(
        `INSERT INTO analytics_events (event, properties, session_id, user_id, page, device)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [event, JSON.stringify(properties), session_id || null, user_id || null, page || null, device]
      );
    }
    res.json({ ok: true, count: events.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DASHBOARD DATA (admin only) ───────────────────────────────────────────────
app.get('/dashboard', auth, async (req, res) => {
  try {
    const [
      totalEvents,
      todayEvents,
      topEvents,
      topPages,
      deviceSplit,
      dailyTrend,
      recentEvents,
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM analytics_events`),
      db.query(`SELECT COUNT(*) FROM analytics_events WHERE created_at > NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT event, COUNT(*) as count FROM analytics_events GROUP BY event ORDER BY count DESC LIMIT 10`),
      db.query(`SELECT page, COUNT(*) as count FROM analytics_events WHERE page IS NOT NULL GROUP BY page ORDER BY count DESC LIMIT 10`),
      db.query(`SELECT device, COUNT(*) as count FROM analytics_events GROUP BY device`),
      db.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM analytics_events WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date ASC`),
      db.query(`SELECT event, page, properties, created_at FROM analytics_events ORDER BY created_at DESC LIMIT 20`),
    ]);

    res.json({
      total:       parseInt(totalEvents.rows[0].count),
      today:       parseInt(todayEvents.rows[0].count),
      topEvents:   topEvents.rows,
      topPages:    topPages.rows,
      deviceSplit: deviceSplit.rows,
      dailyTrend:  dailyTrend.rows,
      recent:      recentEvents.rows,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FUNNEL (signup → download → purchase) ────────────────────────────────────
app.get('/funnel', auth, async (req, res) => {
  try {
    const steps = ['page_view', 'signup', 'download', 'purchase'];
    const results = await Promise.all(steps.map(step =>
      db.query(`SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE event = $1`, [step])
    ));
    res.json(steps.map((step, i) => ({ step, count: parseInt(results[i].rows[0].count) })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', service: 'valcrown-analytics' });
  } catch(e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📊 ValCrown Analytics on port ${PORT}`);
  });
}).catch(e => {
  console.error('Init failed:', e.message);
  process.exit(1);
});
