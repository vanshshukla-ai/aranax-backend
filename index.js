
import express from 'express';
import cors from 'cors';
import pg from 'pg';

const app = express();
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


app.get('/reps/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT user_id, full_name, email, phone, role, region FROM users WHERE user_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Rep not found' });
    return res.json({ rep: rows[0] });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Aranax API on ' + PORT));
