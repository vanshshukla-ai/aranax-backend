
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { VertexAI } from '@google-cloud/vertexai';

const app = express();

// Vertex AI (Gemini) for AI features — doctor pitch, meeting notes
const vertex = new VertexAI({ project: process.env.GCP_PROJECT || 'direct-tribute-502305-q5', location: 'us-central1' });
const genModel = vertex.getGenerativeModel({ model: 'gemini-2.0-flash-001' });
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,   // /cloudsql/<connection-name>
});

const nid = (p) => p + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);

// Health
app.get('/', (req, res) => res.json({ ok: true, service: 'aranax-field-force' }));

// ---------- REP PROFILE ----------
app.get('/reps/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_id, full_name, email, phone, role, region FROM users WHERE user_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Rep not found' });
    return res.json({ rep: rows[0] });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------- DAILY CLIENT LIST (today's plan for a rep) ----------
app.get('/reps/:id/today', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.assignment_id, a.purpose, a.status AS plan_status,
              c.client_id, c.client_name, c.client_type, c.address, c.contact_person, c.contact_phone,
              v.visit_id, v.checkin_at, v.checkout_at, v.duration_min, v.status AS visit_status
         FROM assignments a
         JOIN clients c ON c.client_id = a.client_id
         LEFT JOIN visits v ON v.assignment_id = a.assignment_id
        WHERE a.rep_id = $1 AND a.plan_date = CURRENT_DATE
        ORDER BY a.assignment_id`,
      [req.params.id]
    );
    return res.json({ date: new Date().toISOString().slice(0, 10), clients: rows });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------- CHECK-IN ----------
app.post('/visits/checkin', async (req, res) => {
  try {
    const { rep_id, client_id, assignment_id, lat, lng } = req.body;
    if (!rep_id || !client_id) return res.status(400).json({ error: 'rep_id and client_id required' });

    // geo-validate: distance to client vs geofence radius
    const c = await pool.query('SELECT latitude, longitude, geofence_radius FROM clients WHERE client_id = $1', [client_id]);
    let geo_validated = false;
    if (c.rows.length && lat != null && lng != null) {
      const { latitude, longitude, geofence_radius } = c.rows[0];
      const dist = haversine(lat, lng, latitude, longitude); // metres
      geo_validated = dist <= (geofence_radius || 100);
    }
    const visit_id = nid('V');
    await pool.query(
      `INSERT INTO visits (visit_id, rep_id, client_id, assignment_id, checkin_at, checkin_lat, checkin_lng, geo_validated, status)
       VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,'IN_PROGRESS')`,
      [visit_id, rep_id, client_id, assignment_id || null, lat || null, lng || null, geo_validated]
    );
    return res.json({ ok: true, visit_id, geo_validated });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------- CHECK-OUT ----------
app.post('/visits/:id/checkout', async (req, res) => {
  try {
    const v = await pool.query('SELECT checkin_at FROM visits WHERE visit_id = $1', [req.params.id]);
    if (!v.rows.length) return res.status(404).json({ error: 'Visit not found' });
    const mins = v.rows[0].checkin_at ? Math.round((Date.now() - new Date(v.rows[0].checkin_at).getTime()) / 60000) : null;
    await pool.query(
      `UPDATE visits SET checkout_at = NOW(), duration_min = $1, status = 'COMPLETED' WHERE visit_id = $2`,
      [mins, req.params.id]
    );
    // mark the assignment done
    await pool.query(`UPDATE assignments SET status = 'DONE' WHERE assignment_id = (SELECT assignment_id FROM visits WHERE visit_id = $1)`, [req.params.id]);
    return res.json({ ok: true, visit_id: req.params.id, duration_min: mins });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------- LOG MEETING NOTES (MoM) ----------
app.post('/visits/:id/mom', async (req, res) => {
  try {
    const { notes } = req.body;
    await pool.query('UPDATE visits SET mom_notes = $1 WHERE visit_id = $2', [notes || '', req.params.id]);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------- SALES ENTRY ----------
app.post('/sales', async (req, res) => {
  try {
    const { visit_id, rep_id, client_id, product, stage, deal_value, notes } = req.body;
    if (!rep_id || !client_id) return res.status(400).json({ error: 'rep_id and client_id required' });
    const sale_id = nid('S');
    await pool.query(
      `INSERT INTO sales_records (sale_id, visit_id, rep_id, client_id, product, stage, deal_value, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sale_id, visit_id || null, rep_id, client_id, product || '', stage || 'LEAD', deal_value || null, notes || '']
    );
    return res.json({ ok: true, sale_id });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// distance in metres between two lat/lng
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ---------- MANAGER DASHBOARD ----------
// Team overview: all reps with today's progress
app.get('/manager/team', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.user_id, u.full_name, u.region,
             COUNT(DISTINCT a.assignment_id) AS planned,
             COUNT(DISTINCT CASE WHEN v.status = 'COMPLETED' THEN v.visit_id END) AS completed,
             COUNT(DISTINCT CASE WHEN v.status = 'IN_PROGRESS' THEN v.visit_id END) AS in_progress
        FROM users u
        LEFT JOIN assignments a ON a.rep_id = u.user_id AND a.plan_date = CURRENT_DATE
        LEFT JOIN visits v ON v.rep_id = u.user_id AND DATE(v.created_at) = CURRENT_DATE
       WHERE u.role = 'REP'
       GROUP BY u.user_id, u.full_name, u.region
       ORDER BY u.full_name`);
    return res.json({ team: rows });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Live locations of all reps (latest GPS point each) — for the map
app.get('/manager/live', async (req, res) => {
  try {
    // latest known position per rep (falls back to last check-in if no gps yet)
    const { rows } = await pool.query(`
      SELECT u.user_id, u.full_name,
             COALESCE(g.latitude, v.checkin_lat) AS latitude,
             COALESCE(g.longitude, v.checkin_lng) AS longitude,
             v.client_id, c.client_name, v.status AS visit_status
        FROM users u
        LEFT JOIN LATERAL (SELECT latitude, longitude FROM gps_logs WHERE rep_id = u.user_id ORDER BY recorded_at DESC LIMIT 1) g ON true
        LEFT JOIN LATERAL (SELECT client_id, checkin_lat, checkin_lng, status FROM visits WHERE rep_id = u.user_id ORDER BY created_at DESC LIMIT 1) v ON true
        LEFT JOIN clients c ON c.client_id = v.client_id
       WHERE u.role = 'REP'`);
    return res.json({ reps: rows });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Visit history for a rep (recent visits)
app.get('/manager/reps/:id/visits', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.visit_id, v.checkin_at, v.checkout_at, v.duration_min, v.geo_validated, v.status, v.mom_notes,
             c.client_name, c.client_type, c.address
        FROM visits v JOIN clients c ON c.client_id = v.client_id
       WHERE v.rep_id = $1
       ORDER BY v.created_at DESC LIMIT 50`, [req.params.id]);
    return res.json({ visits: rows });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Monthly summary for a rep (payroll-ready figures)
app.get('/manager/reps/:id/monthly', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS total_visits,
             COALESCE(SUM(duration_min),0) AS total_minutes,
             COUNT(CASE WHEN geo_validated THEN 1 END) AS verified_visits
        FROM visits
       WHERE rep_id = $1 AND status = 'COMPLETED'
         AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`, [req.params.id]);
    const r = rows[0] || {};
    return res.json({
      rep_id: req.params.id,
      total_visits: parseInt(r.total_visits || 0, 10),
      total_hours: Math.round((r.total_minutes || 0) / 60 * 10) / 10,
      verified_visits: parseInt(r.verified_visits || 0, 10),
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ---------- AI: DOCTOR PITCH (Vertex AI / Gemini) ----------
app.post('/ai/doctor-pitch', async (req, res) => {
  try {
    const { doctor_name, specialty, hospital, product, past_interactions } = req.body;
    const facts = [
      'Doctor: ' + (doctor_name || 'the doctor'),
      'Specialty: ' + (specialty || 'not specified'),
      'Hospital: ' + (hospital || 'not specified'),
      'Product to pitch: ' + (product || 'Aranax medical products'),
      past_interactions ? 'Past interactions: ' + past_interactions : '',
    ].filter(Boolean).join('\n');

    const prompt = 'You are a medical sales assistant for Aranax Medical. Write a short, professional, persuasive pitch a sales rep can use with a doctor. '
      + 'Use ONLY the facts provided; do not invent clinical claims or data. Keep it under 120 words. '
      + 'Structure: 1) a one-line hook tailored to the specialty, 2) 2-3 key benefits, 3) a clear next step. '
      + 'Return ONLY the pitch text.\n\nFACTS:\n' + facts;

    const result = await genModel.generateContent(prompt);
    const pitch = result.response.candidates[0].content.parts[0].text.trim();
    return res.json({ pitch });
  } catch (e) {
    return res.status(500).json({ error: 'Could not generate pitch', detail: e.message });
  }
});

// ---------- AI: MEETING NOTES SUMMARY (Vertex AI / Gemini) ----------
app.post('/ai/mom-summary', async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes || !notes.trim()) return res.status(400).json({ error: 'notes required' });
    const prompt = 'You are a medical sales assistant. From these raw meeting notes, produce ONLY valid JSON with keys: '
      + 'summary (2 sentences), sentiment (Positive/Neutral/Negative), next_steps (array of short strings), follow_up_email (a short professional email draft). '
      + 'Use only what is in the notes; do not invent. No markdown.\n\nNOTES:\n' + notes;
    const result = await genModel.generateContent(prompt);
    let out = result.response.candidates[0].content.parts[0].text.trim().replace(/```json/g,'').replace(/```/g,'').trim();
    let parsed; try { parsed = JSON.parse(out); } catch { parsed = { summary: out, sentiment: 'Neutral', next_steps: [], follow_up_email: '' }; }
    return res.json(parsed);
  } catch (e) {
    return res.status(500).json({ error: 'Could not summarize notes', detail: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Aranax API on ' + PORT));
