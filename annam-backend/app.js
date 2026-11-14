const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load environment variables from .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

const db = require('./db');
const clock = require('./lib/clock');
const bus = require('./lib/bus');
const { roads } = require('./lib/graph');
const R = require('./lib/rules');
const { urgentOpenPosts, getPostFull, annotate, POST_SQL } = require('./lib/queue');
const { rankReceivers } = require('./lib/matcher');
const { buildBatch } = require('./lib/batcher');
const { seedIfEmpty, reseed } = require('./seed');

seedIfEmpty();
const { MIN, MARGIN_MIN } = R;
const DEMO_SHOW_OTP = process.env.DEMO_SHOW_OTP !== 'false'; // on-screen OTP for the demo; set false to hide
const UPLOADS = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// WhatsApp OTP sender using Meta Cloud API with fallback to DEMO_SHOW_OTP
async function sendWhatsAppOtp(phone, otp, context = 'donation') {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  if (!token || !phoneId || token === 'YOUR_WHATSAPP_TOKEN' || phoneId === 'YOUR_WHATSAPP_PHONE_ID') {
    if (DEMO_SHOW_OTP) {
      console.log(`[WhatsApp OTP] Demo mode active (credentials not set). Demo OTP ${otp} generated for ${phone} (${context}).`);
    }
    return { sent: false, demo: true, reason: 'Credentials not set' };
  }

  let cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

  const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
  const bodyText = `Annam Food Rescue: Your verification OTP for ${context} is *${otp}*. Valid for 15 minutes. Please share this with the official upon completion.`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { preview_url: false, body: bodyText }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[WhatsApp API Warning] (${res.status}):`, data);
      return { sent: false, error: data };
    }
    console.log(`[WhatsApp API Success] OTP sent to ${cleanPhone}:`, data);
    return { sent: true, data };
  } catch (err) {
    console.warn(`[WhatsApp Network Error]:`, err.message);
    return { sent: false, error: err.message };
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use('/uploads', express.static(UPLOADS));
app.use(express.static(path.join(__dirname, 'public')));
const api = express.Router();
app.use('/api', api);

// ---------- helpers ----------
const iso = ms => (ms == null ? null : new Date(ms).toISOString());
function audit(postId, type, detail) {
  db.prepare('INSERT INTO events (post_id,type,detail,timestamp) VALUES (?,?,?,?)').run(postId, type, detail ? JSON.stringify(detail) : null, clock.now());
  bus.broadcast(type, { post_id: postId, ...(detail || {}) });
}
function colour(secondsLeft) { return secondsLeft > 5400 ? 'green' : secondsLeft > 1800 ? 'amber' : 'red'; }
function present(p, now = clock.now()) {
  const left = Math.floor((p.safe_until - now) / 1000);
  return {
    post_id: p.post_id, donor_id: p.donor_id, donor_name: p.donor_name, portions: p.portions, kg_estimate: p.kg_estimate,
    diet_type: p.diet_type, food_type: p.food_type, holding_method: p.holding_method, packaging: p.packaging,
    status: p.status, ready_at: iso(p.ready_at), safe_until: iso(p.safe_until), seconds_left: left,
    colour: p.status === 'expired' ? 'red' : colour(left),
    leave_by: p.leave_by ? iso(p.leave_by) : undefined, slack_min: p.slack_min,
    min_delivery_min: p.min_delivery_min, server_time: iso(now)
  };
}
const hashOtp = (otp, salt) => crypto.createHash('sha256').update(`${salt}:${otp}`).digest('hex');
const matchRow = id => db.prepare('SELECT * FROM matches WHERE match_id=?').get(id);

// ---------- reference data ----------
api.get('/health', (req, res) => res.json({
  ok: true,
  server_time: iso(clock.now()),
  sse_clients: bus.count(),
  whatsapp_configured: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_TOKEN !== 'YOUR_WHATSAPP_TOKEN'),
  demo_show_otp: DEMO_SHOW_OTP
}));
api.get('/config', (req, res) => res.json({
  google_maps_api_key: process.env.GOOGLE_MAPS_API_KEY || 'YOUR_GOOGLE_MAPS_API_KEY',
  whatsapp_configured: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_TOKEN !== 'YOUR_WHATSAPP_TOKEN'),
  demo_show_otp: DEMO_SHOW_OTP
}));
api.get('/donors', (req, res) => res.json(db.prepare('SELECT * FROM donors').all()));
api.get('/receivers', (req, res) => res.json(db.prepare('SELECT * FROM receivers').all()));
api.get('/volunteers', (req, res) => res.json(db.prepare('SELECT * FROM volunteers').all()));
api.get('/safety-rules', (req, res) => res.json({
  disclaimer: 'Guidance from public food-safety information. Not a certification. The receiving kitchen makes the final call.',
  rules: db.prepare('SELECT * FROM safety_rules').all()
}));
api.get('/graph', (req, res) => res.json({ nodes: roads.nodes, edges: roads.edgeList() }));
api.get('/stream', bus.handler);

// ---------- F1: surplus post ----------
api.get('/posts/suggest-safe-until', (req, res) => {
  const m = R.safeMinutes(req.query.food_type, req.query.holding_method);
  if (m == null) return res.status(404).json({ error: 'No rule for that food type / holding method' });
  const cookedAgo = R.clampNum(req.query.cooked_ago_min, 0, 720, 60);
  res.json({ safe_minutes: m, safe_until: iso(clock.now() - cookedAgo * MIN + m * MIN),
    note: 'Guide, not a certification. You may only shorten this time.' });
});

api.post('/posts', (req, res) => {
  const now = clock.now(); // any client-supplied time is ignored
  const v = R.validateNewPost(req.body || {}, now);
  if (v.error) { audit(null, 'post_refused', { reason: v.error.message }); return res.status(v.error.status).json({ error: v.error.message }); }
  const p = v.ok;
  const info = db.prepare(`INSERT INTO posts (donor_id,portions,kg_estimate,diet_type,food_type,holding_method,packaging,cooked_at,ready_at,safe_until,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?)`).run(p.donor_id, p.portions, p.kg_estimate, p.diet_type, p.food_type, p.holding_method, p.packaging, p.cooked_at, p.ready_at, p.safe_until, now);
  audit(info.lastInsertRowid, 'post_created', { portions: p.portions, safe_until: iso(p.safe_until) });
  res.status(201).json(present(getPostFull(info.lastInsertRowid, now), now));
});

// ---------- F2: expiry queue ----------
api.get('/posts', (req, res) => {
  const now = clock.now(), status = req.query.status;
  if (status === 'open') return res.json(urgentOpenPosts(now).map(p => present(p, now))); // heap order, most urgent first
  const rows = status ? db.prepare(POST_SQL + ' WHERE p.status=? ORDER BY p.created_at DESC').all(status)
                      : db.prepare(POST_SQL + ' ORDER BY p.created_at DESC').all();
  res.json(rows.map(p => present(annotate(p, now), now)));
});
api.get('/posts/:id', (req, res) => {
  const p = getPostFull(req.params.id, clock.now());
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(present(p));
});
api.get('/posts/:id/audit', (req, res) =>
  res.json(db.prepare('SELECT * FROM events WHERE post_id=? ORDER BY event_id').all(req.params.id)
    .map(e => ({ ...e, timestamp: iso(e.timestamp), detail: e.detail ? JSON.parse(e.detail) : null }))));

// ---------- F3: receiver match ----------
api.get('/posts/:id/matches', (req, res) => {
  const now = clock.now();
  const p = getPostFull(req.params.id, now);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.status !== 'open') return res.status(409).json({ error: `Post is ${p.status}` });
  const rank = rankReceivers(p, now);
  const tx = db.transaction(() => {
    db.prepare("UPDATE matches SET status='cancelled' WHERE post_id=? AND status='proposed'").run(p.post_id);
    for (const e of rank.eligible) {
      e.match_id = db.prepare('INSERT INTO matches (post_id,receiver_id,score,reason,status,created_at) VALUES (?,?,?,?,?,?)')
        .run(p.post_id, e.receiver_id, e.score, e.reason, 'proposed', now).lastInsertRowid;
    }
  });
  tx();
  if (!rank.eligible.length) audit(p.post_id, 'match_refused', { rejected: rank.rejected });
  res.json({
    post: present(p, now), disclaimer: 'Food-safety guidance only. The receiving kitchen makes the final decision.',
    top_choice: rank.eligible[0] || null, eligible: rank.eligible, refused: rank.rejected, weights: rank.weights,
    refusal_message: rank.eligible.length ? null : 'No receiver can take this food safely before its safe-until time. The system says no.'
  });
});

api.post('/matches/:id/accept', (req, res) => {
  const now = clock.now(), m = matchRow(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const p = getPostFull(m.post_id, now);
  if (p.status !== 'open' || m.status !== 'proposed') return res.status(409).json({ error: `Match is ${m.status}, post is ${p.status}` });
  const fresh = rankReceivers(p, now).eligible.find(e => e.receiver_id === m.receiver_id); // re-check with server time
  if (!fresh) {
    db.prepare("UPDATE matches SET status='cancelled' WHERE match_id=?").run(m.match_id);
    audit(p.post_id, 'match_refused', { match_id: m.match_id, reason: 'no longer feasible at accept time' });
    return res.status(409).json({ error: 'Refused: this match is no longer feasible before the safe-until time.' });
  }
  db.transaction(() => {
    db.prepare("UPDATE matches SET status='accepted' WHERE match_id=?").run(m.match_id);
    db.prepare("UPDATE matches SET status='cancelled' WHERE post_id=? AND match_id<>? AND status='proposed'").run(m.post_id, m.match_id);
    db.prepare("UPDATE posts SET status='matched' WHERE post_id=?").run(m.post_id);
  })();
  audit(p.post_id, 'match_accepted', { match_id: m.match_id, receiver_id: m.receiver_id });
  res.json({ match: matchRow(m.match_id), next: 'POST /api/routes/batch to plan the pickup' });
});
api.post('/matches/:id/decline', (req, res) => {
  const m = matchRow(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE matches SET status='declined' WHERE match_id=? AND status='proposed'").run(m.match_id);
  audit(m.post_id, 'match_declined', { match_id: m.match_id });
  res.json({ match: matchRow(m.match_id) });
});

// ---------- F4: pickup batching ----------
api.post('/routes/batch', (req, res) => {
  const b = buildBatch({ seedPostId: req.body.seed_post_id, postIds: req.body.post_ids, maxStops: req.body.max_stops || 5 });
  if (b.error) { audit(null, 'batch_refused', { reason: b.error }); return res.status(b.status || 409).json({ error: b.error, refused: b.rejected }); }
  const now = clock.now();
  const otp = String(crypto.randomInt(1000, 10000)); // one code per route, given by the receiver at delivery
  const out = db.transaction(() => {
    const stopsJson = b.stops.map(s => ({ post_id: s.post_id, donor_id: s.donor_id, portions: s.portions }));
    const routeId = db.prepare('INSERT INTO routes (volunteer_id,receiver_id,stops,etas,total_minutes,status,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(b.volunteer ? b.volunteer.volunteer_id : null, b.receiver.receiver_id, JSON.stringify(stopsJson),
           JSON.stringify({ stops: b.etas, deliver_ms: b.deliver_ms }), b.total_minutes, 'planned', now).lastInsertRowid;
    const handovers = [];
    for (const s of b.stops) {
      let m = db.prepare("SELECT * FROM matches WHERE post_id=? AND status='accepted' AND receiver_id=?").get(s.post_id, b.receiver.receiver_id);
      if (!m) {
        db.prepare("UPDATE matches SET status='cancelled' WHERE post_id=? AND status='proposed'").run(s.post_id);
        const id = db.prepare('INSERT INTO matches (post_id,receiver_id,score,reason,status,created_at) VALUES (?,?,?,?,?,?)')
          .run(s.post_id, b.receiver.receiver_id, null, 'batched route (operator confirmed)', 'accepted', now).lastInsertRowid;
        m = matchRow(id);
      }
      db.prepare('UPDATE matches SET route_id=? WHERE match_id=?').run(routeId, m.match_id);
      db.prepare("UPDATE posts SET status='matched' WHERE post_id=?").run(s.post_id);
      const hid = db.prepare('INSERT INTO handovers (match_id, otp_hash) VALUES (?, ?)').run(m.match_id, 'pending').lastInsertRowid;
      db.prepare('UPDATE handovers SET otp_hash=? WHERE handover_id=?').run(hashOtp(otp, hid), hid);
      handovers.push({ handover_id: hid, post_id: s.post_id, match_id: m.match_id });
    }
    return { routeId, handovers };
  })();
  b.stops.forEach(s => audit(s.post_id, 'route_planned', { route_id: out.routeId }));
  const row = db.prepare('SELECT * FROM routes WHERE route_id=?').get(out.routeId);

  // Send WhatsApp OTP to receiver contact if available
  const receiverContact = b.receiver && b.receiver.contact;
  if (receiverContact) {
    sendWhatsAppOtp(receiverContact, otp, `Delivery handover route #${out.routeId}`).catch(err => console.warn('[WhatsApp Error]', err.message));
  }
  res.status(201).json({
    route: presentRoute(row), handovers: out.handovers,
    leave_by: iso(Math.min(...b.stops.map(s => s.leave_by))),
    batching: { stops: b.stops.length, batched_minutes: b.total_minutes, separate_trips_minutes: b.solo_minutes,
                trips_saved: b.trips_saved, trip_reduction_pct: b.trip_reduction_pct, rejected_stops: b.rejected_stops },
    volunteer: b.volunteer ? { volunteer_id: b.volunteer.volunteer_id, name: b.volunteer.name, vehicle: b.volunteer.vehicle } : 'receiver collects',
    demo_otp: DEMO_SHOW_OTP ? otp : undefined
  });
});
function presentRoute(r) {
  const blob = JSON.parse(r.etas), stops = JSON.parse(r.stops);
  const etas = Array.isArray(blob) ? blob : blob.stops;
  return {
    route_id: r.route_id, status: r.status, volunteer_id: r.volunteer_id, total_minutes: r.total_minutes,
    receiver: { receiver_id: r.receiver_id, ...db.prepare('SELECT name,lat,lng FROM receivers WHERE receiver_id=?').get(r.receiver_id) },
    stops: stops.map(s => ({
      post_id: s.post_id, portions: s.portions,
      donor: db.prepare('SELECT donor_id,name,lat,lng FROM donors WHERE donor_id=?').get(s.donor_id),
      eta: iso((etas.find(e => e.post_id === s.post_id) || {}).arrive_ms)
    })),
    deliver_eta: blob.deliver_ms ? iso(blob.deliver_ms) : null
  };
}
api.get('/routes', (req, res) => res.json(db.prepare('SELECT * FROM routes ORDER BY route_id DESC LIMIT 50').all().map(presentRoute)));
api.get('/routes/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM routes WHERE route_id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const path = [];
  const pts = JSON.parse(r.stops).map(s => db.prepare('SELECT node FROM donors WHERE donor_id=?').get(s.donor_id).node);
  pts.push(db.prepare('SELECT node FROM receivers WHERE receiver_id=?').get(r.receiver_id).node);
  for (let i = 0; i < pts.length - 1; i++) roads.shortest(pts[i], pts[i + 1]).path.forEach(n => path.push([roads.nodes[n].lat, roads.nodes[n].lng]));
  res.json({ ...presentRoute(r), polyline: path });
});
api.post('/routes/:id/start', (req, res) => {
  const r = db.prepare('SELECT * FROM routes WHERE route_id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.status !== 'planned') return res.status(409).json({ error: `Route is ${r.status}` });
  const now = clock.now();
  const posts = JSON.parse(r.stops).map(s => db.prepare('SELECT * FROM posts WHERE post_id=?').get(s.post_id));
  const late = posts.filter(p => now > p.safe_until - MARGIN_MIN * MIN);
  if (late.length) return res.status(409).json({ error: 'Refused: a post is past its safe window', post_ids: late.map(p => p.post_id) });
  db.transaction(() => {
    db.prepare("UPDATE routes SET status='in_transit' WHERE route_id=?").run(r.route_id);
    posts.forEach(p => db.prepare("UPDATE posts SET status='in_transit' WHERE post_id=?").run(p.post_id));
  })();
  posts.forEach(p => audit(p.post_id, 'in_transit', { route_id: r.route_id }));
  res.json({ route_id: r.route_id, status: 'in_transit' });
});

// ---------- F5: handover & impact ----------
api.get('/handovers', (req, res) => {
  const rows = db.prepare(`SELECT h.handover_id,h.match_id,h.donor_confirmed,h.receiver_confirmed,h.completed_at,h.photo,m.post_id,m.route_id
    FROM handovers h JOIN matches m USING(match_id) ${req.query.route_id ? 'WHERE m.route_id=?' : ''} ORDER BY h.handover_id`)
    .all(...(req.query.route_id ? [req.query.route_id] : []));
  res.json(rows.map(h => ({ ...h, completed_at: iso(h.completed_at) })));
});
api.post('/handovers/:id/confirm', (req, res) => {
  const now = clock.now();
  const h = db.prepare('SELECT * FROM handovers WHERE handover_id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'not found' });
  if (h.completed_at) return res.status(409).json({ error: 'Already completed' });
  const m = matchRow(h.match_id), p = db.prepare('SELECT * FROM posts WHERE post_id=?').get(m.post_id);
  const { role, otp, photo } = req.body || {};

  if (role === 'donor') {
    db.prepare('UPDATE handovers SET donor_confirmed=1 WHERE handover_id=?').run(h.handover_id);
    audit(p.post_id, 'donor_confirmed_pickup', { handover_id: h.handover_id });
  } else if (role === 'driver') {
    if (typeof photo !== 'string' || photo.length < 20) return res.status(422).json({ error: 'photo (base64 or data URL) required' });
    const buf = Buffer.from(photo.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'photo too large (max 5 MB)' });
    const file = `handover-${h.handover_id}.jpg`;
    fs.writeFileSync(path.join(UPLOADS, file), buf);
    db.prepare('UPDATE handovers SET photo=? WHERE handover_id=?').run(`/uploads/${file}`, h.handover_id);
    audit(p.post_id, 'photo_uploaded', { handover_id: h.handover_id });
  } else if (role === 'receiver') {
    if (h.attempts >= 5) return res.status(429).json({ error: 'Too many wrong OTP attempts. Handover locked.' });
    if (now > p.safe_until) {   // hard deadline, enforced with server time
      db.prepare("UPDATE posts SET status='expired' WHERE post_id=?").run(p.post_id);
      audit(p.post_id, 'expired', { at: 'delivery' });
      return res.status(409).json({ error: 'Refused: delivery is after the safe-until time. Food must not be served.' });
    }
    if (hashOtp(String(otp || ''), h.handover_id) !== h.otp_hash) {
      db.prepare('UPDATE handovers SET attempts=attempts+1 WHERE handover_id=?').run(h.handover_id);
      audit(p.post_id, 'otp_failed', { handover_id: h.handover_id });
      return res.status(403).json({ error: 'Wrong OTP' });
    }
    db.prepare('UPDATE handovers SET receiver_confirmed=1 WHERE handover_id=?').run(h.handover_id);
    audit(p.post_id, 'receiver_confirmed', { handover_id: h.handover_id });
  } else return res.status(422).json({ error: "role must be 'donor', 'driver' or 'receiver'" });

  const cur = db.prepare('SELECT * FROM handovers WHERE handover_id=?').get(h.handover_id);
  let completed = false;
  if (cur.donor_confirmed && cur.receiver_confirmed && cur.photo) { // impact moves ONLY now
    db.transaction(() => {
      db.prepare('UPDATE handovers SET completed_at=? WHERE handover_id=?').run(now, h.handover_id);
      db.prepare("UPDATE posts SET status='delivered' WHERE post_id=?").run(p.post_id);
      if (m.route_id) {
        const left = db.prepare(`SELECT COUNT(*) c FROM matches m JOIN handovers h USING(match_id) WHERE m.route_id=? AND h.completed_at IS NULL`).get(m.route_id).c;
        if (left === 0) db.prepare("UPDATE routes SET status='completed' WHERE route_id=?").run(m.route_id);
      }
    })();
    completed = true;
    audit(p.post_id, 'delivered', { handover_id: h.handover_id, kg: p.kg_estimate, portions: p.portions });
  }
  res.json({ handover_id: h.handover_id, donor_confirmed: !!cur.donor_confirmed, receiver_confirmed: !!cur.receiver_confirmed,
    photo: !!cur.photo, completed, impact_counted: completed });
});

function impact(whereDonor) {
  const arg = whereDonor ? [whereDonor] : [];
  const base = `FROM handovers h JOIN matches m USING(match_id) JOIN posts p ON p.post_id=m.post_id
                WHERE h.completed_at IS NOT NULL ${whereDonor ? 'AND p.donor_id=?' : ''}`;
  const t = db.prepare(`SELECT COALESCE(SUM(p.portions),0) meals, COALESCE(SUM(p.kg_estimate),0) kg, COUNT(*) handovers ${base}`).get(...arg);
  const routes = db.prepare(`SELECT m.route_id, COUNT(*) c ${base} AND m.route_id IS NOT NULL GROUP BY m.route_id`).all(...arg);
  const trips_saved = routes.reduce((s, r) => s + (r.c - 1), 0);
  return { meals: t.meals, kg: +t.kg.toFixed(1), verified_handovers: t.handovers, trips_saved, kg_waste_avoided: +t.kg.toFixed(1) };
}
api.get('/impact', (req, res) => res.json({ ...impact(), counted_from: 'verified handovers only (OTP + photo + both confirmations)' }));
api.get('/impact/donors', (req, res) => {
  const rows = db.prepare(`SELECT d.donor_id, d.name, strftime('%Y-W%W', h.completed_at/1000, 'unixepoch') week,
      SUM(p.portions) meals, ROUND(SUM(p.kg_estimate),1) kg, COUNT(*) handovers
    FROM handovers h JOIN matches m USING(match_id) JOIN posts p ON p.post_id=m.post_id JOIN donors d ON d.donor_id=p.donor_id
    WHERE h.completed_at IS NOT NULL GROUP BY d.donor_id, week ORDER BY week DESC, kg DESC`).all();
  res.json(rows);
});
api.get('/impact/donors/:id', (req, res) => res.json(impact(Number(req.params.id))));

// ---------- timer: expire posts that can no longer be delivered ----------
function expirySweep() {
  const now = clock.now(), expired = [];
  for (const p of urgentOpenPosts(now)) {
    if (p.leave_by < now && Math.max(now, p.ready_at) + (p.min_delivery_min + MARGIN_MIN) * MIN >= p.safe_until) expired.push(p);
  }
  for (const p of db.prepare("SELECT p.* FROM posts p WHERE p.status='matched' AND p.safe_until - ? <= ?").all(MARGIN_MIN * MIN, now)) expired.push(p);
  for (const p of db.prepare("SELECT p.* FROM posts p WHERE p.status='in_transit' AND p.safe_until < ?").all(now)) expired.push(p);
  for (const p of expired) {
    db.prepare("UPDATE posts SET status='expired' WHERE post_id=?").run(p.post_id);
    db.prepare("UPDATE matches SET status='cancelled' WHERE post_id=? AND status IN ('proposed','accepted')").run(p.post_id);
    audit(p.post_id, 'expired', { at: 'sweep' });
  }
  return expired.length;
}
let timers = [];
function startTimers() {
  timers.push(setInterval(expirySweep, 15000), setInterval(() => bus.broadcast('tick', { server_time: iso(clock.now()) }), 5000));
  timers.forEach(t => t.unref());
}
api.post('/admin/sweep', (req, res) => res.json({ expired: expirySweep() }));

// ---------- demo/admin (disabled in production) ----------
if (process.env.NODE_ENV !== 'production') {
  api.post('/admin/clock', (req, res) => { clock.setOffsetMinutes(Number(req.body.offset_minutes) || 0); res.json({ offset_minutes: clock.offsetMinutes(), server_time: iso(clock.now()) }); });
  api.post('/admin/reseed', (req, res) => { reseed(); clock.setOffsetMinutes(0); res.json({ ok: true }); });
}

// ---------- legacy NGO OTP portal (meals / ration / biogas) used by the existing front end ----------
const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function donationOut(r) {
  return { id: r.id, type: r.type, phone: r.phone, ngo: r.ngo, ...JSON.parse(r.payload), otp: r.otp, status: r.status,
    createdAtMonth: r.created_month, servedAt: r.served_at, servedMonth: r.served_month };
}
api.post('/donations', (req, res) => {
  const { type, phone, ngo, ...rest } = req.body || {};
  if (!['MEAL', 'RATION', 'BIOGAS'].includes(type) || !phone || !ngo) return res.status(422).json({ error: 'type (MEAL|RATION|BIOGAS), phone and ngo are required' });
  const count = db.prepare('SELECT COUNT(*) c FROM donations').get().c;
  const id = 'DON-' + (1000 + count + 1), otp = String(crypto.randomInt(1000, 10000)), d = new Date(clock.now());
  db.prepare('INSERT INTO donations (id,type,phone,ngo,payload,otp,status,created_month,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, type, String(phone).trim(), ngo, JSON.stringify(rest), otp, 'PENDING', ym(d), clock.now());

  // Asynchronously send OTP via WhatsApp (falling back to demo mode if credentials not set)
  sendWhatsAppOtp(phone, otp, `${type} donation ${id} for ${ngo}`).catch(err => console.warn('[WhatsApp Error]', err.message));

  res.status(201).json(donationOut(db.prepare('SELECT * FROM donations WHERE id=?').get(id)));
});
api.post('/donations/verify', (req, res) => {
  const phone = String((req.body || {}).phone || '').trim(), otp = String((req.body || {}).otp || '').trim();
  const r = db.prepare('SELECT * FROM donations WHERE phone=? AND otp=? ORDER BY created_at DESC').get(phone, otp);
  if (!r) return res.status(404).json({ error: 'Invalid Phone Number or OTP.' });
  if (r.status === 'SERVED') return res.status(409).json({ error: 'This OTP was already verified.', servedAt: r.served_at });
  const dt = new Date(clock.now()); // server-side official timestamp
  const servedAt = dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' at ' +
                   dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  db.prepare("UPDATE donations SET status='SERVED', served_at=?, served_month=? WHERE id=?").run(servedAt, ym(dt), r.id);
  res.json(donationOut(db.prepare('SELECT * FROM donations WHERE id=?').get(r.id)));
});
api.get('/donations', (req, res) => {
  const { ngo, month, type } = req.query;
  let rows = db.prepare('SELECT * FROM donations ORDER BY created_at DESC, id DESC').all().map(donationOut);
  if (ngo && ngo !== 'ALL') rows = rows.filter(d => d.ngo === ngo);
  if (month) rows = rows.filter(d => (d.servedMonth || d.createdAtMonth) === month);
  if (type && type !== 'ALL') rows = rows.filter(d => d.type === type);
  res.json(rows);
});

api.use((req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

module.exports = { app, startTimers, expirySweep };
