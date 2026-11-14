// Expiry queue: min-heap keyed by "leave-by" = safe_until - margin - fastest possible delivery.
// The most urgent surplus is always on top, regardless of when it was posted.
const db = require('../db');
const MinHeap = require('./minheap');
const { roads } = require('./graph');
const { MIN, MARGIN_MIN } = require('./rules');

const POST_SQL = `SELECT p.*, d.node AS donor_node, d.name AS donor_name, d.lat AS donor_lat, d.lng AS donor_lng
                  FROM posts p JOIN donors d USING(donor_id)`;

function minDeliveryMinutes(donorNode) {
  const rs = db.prepare('SELECT node FROM receivers').all();
  return rs.length ? Math.min(...rs.map(r => roads.minutes(donorNode, r.node))) : 0;
}
function annotate(p, now) {
  p.min_delivery_min = +minDeliveryMinutes(p.donor_node).toFixed(1);
  p.leave_by = p.safe_until - (p.min_delivery_min + MARGIN_MIN) * MIN;
  p.slack_min = +((p.leave_by - Math.max(now, p.ready_at)) / MIN).toFixed(1);
  return p;
}
function getPostFull(id, now) {
  const p = db.prepare(POST_SQL + ' WHERE p.post_id=?').get(id);
  return p ? annotate(p, now) : null;
}
function urgentOpenPosts(now) {
  const heap = new MinHeap();
  for (const p of db.prepare(POST_SQL + " WHERE p.status='open'").all()) heap.push(annotate(p, now).leave_by, p);
  const out = [];
  while (heap.size) out.push(heap.pop().value);
  return out;
}
module.exports = { urgentOpenPosts, getPostFull, annotate, POST_SQL, minDeliveryMinutes };
