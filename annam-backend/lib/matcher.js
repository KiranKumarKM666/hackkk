// Feasibility check (hard rules) + transparent scoring (soft rules).
const db = require('../db');
const clock = require('./clock');
const { roads } = require('./graph');
const { MIN, MARGIN_MIN, fmt, availableVolunteer } = require('./rules');

const W = { closeness: 0.35, capacity: 0.20, slack: 0.20, urgency: 0.15, fairness: 0.10 };

function rankReceivers(post, now = clock.now()) {
  const receivers = db.prepare('SELECT * FROM receivers').all();
  const vol = availableVolunteer(now);
  const recent = new Map(db.prepare("SELECT receiver_id, COUNT(*) c FROM matches WHERE status='accepted' AND created_at>? GROUP BY receiver_id")
    .all(now - 864e5).map(r => [r.receiver_id, r.c]));
  const depart = Math.max(now, post.ready_at);
  const eligible = [], rejected = [];

  for (const r of receivers) {
    const reasons = [];
    if (post.diet_type === 'nonveg' && r.diet_rules === 'veg_only') reasons.push('diet: receiver accepts vegetarian food only');
    if (post.portions > r.capacity_portions) reasons.push(`capacity: ${post.portions} portions exceed receiver capacity ${r.capacity_portions}`);
    if (!r.can_collect && !vol) reasons.push('logistics: receiver cannot collect and no volunteer is free');
    const t = roads.shortest(post.donor_node, r.node);
    const arrive = depart + (t.minutes + MARGIN_MIN) * MIN;
    if (arrive >= post.safe_until) reasons.push(`time: arrival (with ${MARGIN_MIN}m margin) is ${fmt(arrive - post.safe_until)} after the safe-until time`);
    if (reasons.length) { rejected.push({ receiver_id: r.receiver_id, name: r.name, reasons }); continue; }

    const slackMs = post.safe_until - arrive;
    const parts = {
      closeness: Math.max(0, 1 - t.minutes / 30),
      capacity: Math.min(1, post.portions / r.capacity_portions),
      slack: Math.min(1, slackMs / (180 * MIN)),
      urgency: r.need_level / 5,
      fairness: 1 - Math.min(1, (recent.get(r.receiver_id) || 0) / 5)
    };
    const score = Object.keys(W).reduce((s, k) => s + W[k] * parts[k], 0);
    eligible.push({
      receiver_id: r.receiver_id, name: r.name, score: +score.toFixed(4), parts,
      km: +t.km.toFixed(1), travel_min: +t.minutes.toFixed(1), slack_ms: slackMs,
      reason: `${t.km.toFixed(1)} km, capacity ${r.capacity_portions}, arrives with ${fmt(slackMs)} to spare`
    });
  }
  eligible.sort((a, b) => b.score - a.score);
  return { eligible, rejected, weights: W };
}
module.exports = { rankReceivers, W };
