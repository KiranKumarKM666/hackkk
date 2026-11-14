// Pickup batching: seed with the most urgent post, then cheapest insertion,
// re-checking EVERY deadline after every insertion.
const db = require('../db');
const clock = require('./clock');
const { roads } = require('./graph');
const { MIN, MARGIN_MIN, DWELL_MIN, availableVolunteer } = require('./rules');
const { urgentOpenPosts, getPostFull } = require('./queue');
const { rankReceivers } = require('./matcher');

// Simulate a route: visit stops in order, then drive to the receiver.
function evaluateRoute(stops, receiver, startMs) {
  let t = Math.max(startMs, stops[0].ready_at);
  const etas = [{ post_id: stops[0].post_id, donor: stops[0].donor_name, arrive_ms: t }];
  t += DWELL_MIN * MIN;
  for (let i = 1; i < stops.length; i++) {
    t += roads.minutes(stops[i - 1].donor_node, stops[i].donor_node) * MIN;
    t = Math.max(t, stops[i].ready_at);
    etas.push({ post_id: stops[i].post_id, donor: stops[i].donor_name, arrive_ms: t });
    t += DWELL_MIN * MIN;
  }
  t += roads.minutes(stops[stops.length - 1].donor_node, receiver.node) * MIN;
  const violated = stops.filter(s => t + MARGIN_MIN * MIN > s.safe_until).map(s => s.post_id);
  return { ok: violated.length === 0, etas, deliver_ms: t, total_minutes: (t - startMs) / MIN, violated };
}

function buildBatch({ seedPostId = null, postIds = null, maxStops = 5, maxExtraMinutes = 25 } = {}) {
  const now = clock.now();
  const queue = urgentOpenPosts(now);
  const allowed = postIds ? new Set(postIds.map(Number)) : null;
  const pool = allowed ? queue.filter(p => allowed.has(p.post_id)) : queue;
  const seed = seedPostId ? getPostFull(seedPostId, now) : pool[0];
  // A seed may be 'open' or 'matched' (receiver accepted) as long as it has no route yet.
  const routed = seed && db.prepare("SELECT 1 FROM matches WHERE post_id=? AND route_id IS NOT NULL AND status='accepted'").get(seed.post_id);
  if (!seed || !['open', 'matched'].includes(seed.status) || routed) return { error: 'No open post to batch', status: 409 };

  // Receiver: honour an already-accepted match, else take the top-ranked feasible receiver.
  const accepted = db.prepare("SELECT receiver_id FROM matches WHERE post_id=? AND status='accepted'").get(seed.post_id);
  const ranking = rankReceivers(seed, now);
  const pick = accepted ? ranking.eligible.find(e => e.receiver_id === accepted.receiver_id) : ranking.eligible[0];
  if (!pick) return { error: 'No feasible receiver: deadline, diet or capacity rules refuse this post', status: 409, rejected: ranking.rejected };
  const receiver = db.prepare('SELECT * FROM receivers WHERE receiver_id=?').get(pick.receiver_id);

  let stops = [seed];
  let cur = evaluateRoute(stops, receiver, now);
  if (!cur.ok) return { error: 'Deadline cannot be met even for a single stop', status: 409 };
  const rejectedStops = [];
  const maxCap = db.prepare('SELECT MAX(capacity) m FROM volunteers').get().m || 0;

  for (const cand of pool) {
    if (stops.length >= maxStops) break;
    if (stops.some(s => s.post_id === cand.post_id)) continue;
    const reject = why => rejectedStops.push({ post_id: cand.post_id, why });
    if (cand.diet_type === 'nonveg' && receiver.diet_rules === 'veg_only') { reject('diet'); continue; }
    const totalPortions = stops.reduce((s, x) => s + x.portions, 0) + cand.portions;
    if (totalPortions > receiver.capacity_portions) { reject('receiver capacity'); continue; }
    if (!receiver.can_collect && totalPortions > maxCap) { reject('vehicle capacity'); continue; }
    const other = db.prepare("SELECT receiver_id FROM matches WHERE post_id=? AND status='accepted'").get(cand.post_id);
    if (other && other.receiver_id !== receiver.receiver_id) { reject('already matched elsewhere'); continue; }

    let best = null;
    for (let pos = 0; pos <= stops.length; pos++) {      // cheapest insertion
      const trial = [...stops.slice(0, pos), cand, ...stops.slice(pos)];
      const ev = evaluateRoute(trial, receiver, now);
      if (ev.ok && (!best || ev.total_minutes < best.ev.total_minutes)) best = { trial, ev };
    }
    if (!best) { reject('would break a deadline'); continue; }
    if (best.ev.total_minutes - cur.total_minutes > maxExtraMinutes) { reject('detour too long'); continue; }
    stops = best.trial; cur = best.ev;
  }

  // Compare against one-trip-per-donor
  const solo = stops.reduce((s, p) => s + evaluateRoute([p], receiver, now).total_minutes, 0);
  const n = stops.length;
  const totalPortions = stops.reduce((s, p) => s + p.portions, 0);
  const volunteer = availableVolunteer(now, totalPortions);
  if (!volunteer && !receiver.can_collect) return { error: 'No free volunteer with enough vehicle capacity', status: 409 };
  return {
    receiver, volunteer, stops, etas: cur.etas, deliver_ms: cur.deliver_ms,
    total_minutes: +cur.total_minutes.toFixed(1), solo_minutes: +solo.toFixed(1),
    trips_saved: n - 1, trip_reduction_pct: +(((n - 1) / n) * 100).toFixed(1),
    total_portions: totalPortions, rejected_stops: rejectedStops
  };
}
module.exports = { buildBatch, evaluateRoute };
