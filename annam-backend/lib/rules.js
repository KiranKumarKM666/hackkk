// Safety rules, validation, shared constants.
const db = require('../db');
const MIN = 60000;
const MARGIN_MIN = 10;   // safety margin before safe-until
const DWELL_MIN = 5;     // loading time at each stop
const KG_PER_MEAL = 0.4; // 60 meals ~ 24 kg

const fmt = ms => {
  const m = Math.round(ms / MIN), a = Math.abs(m), h = Math.floor(a / 60);
  return (m < 0 ? '-' : '') + (h ? `${h}h ` : '') + `${a % 60}m`;
};
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function safeMinutes(food, hold) {
  const r = db.prepare('SELECT safe_minutes FROM safety_rules WHERE food_type=? AND holding_method=?').get(food, hold);
  return r ? r.safe_minutes : null;
}

function availableVolunteer(now, minCapacity = 0) {
  const d = new Date(now), hr = d.getHours() + d.getMinutes() / 60;
  const busy = new Set(db.prepare("SELECT volunteer_id FROM routes WHERE status IN ('planned','in_transit') AND volunteer_id IS NOT NULL")
    .all().map(r => r.volunteer_id));
  return db.prepare('SELECT * FROM volunteers ORDER BY capacity ASC').all().find(v => {
    const h = hr < v.shift_start ? hr + 24 : hr;
    return h >= v.shift_start && h < v.shift_end && !busy.has(v.volunteer_id) && v.capacity >= minCapacity;
  }) || null;
}

// Returns {ok:{...row fields}} or {error:{status,message}}
function validateNewPost(b, now) {
  const fail = (status, message) => ({ error: { status, message } });
  const donor = db.prepare('SELECT * FROM donors WHERE donor_id=?').get(b.donor_id);
  if (!donor) return fail(404, 'Unknown donor_id');
  const portions = Number.parseInt(b.portions, 10);
  if (!(portions > 0 && portions <= 2000)) return fail(422, 'portions must be between 1 and 2000');
  if (!['veg', 'nonveg'].includes(b.diet_type)) return fail(422, "diet_type must be 'veg' or 'nonveg'");
  const rule = safeMinutes(b.food_type, b.holding_method);
  if (rule == null) return fail(422, `No safety rule for ${b.food_type}/${b.holding_method}`);
  const cookedAgo = clampNum(b.cooked_ago_min, 0, 720, 60);
  const readyIn = clampNum(b.ready_in_min, 0, 240, 10);
  const cooked_at = now - cookedAgo * MIN;
  const ruleUntil = cooked_at + rule * MIN;
  let safe_until = ruleUntil;
  if (b.safe_until_override) {            // editable only downward
    const o = Date.parse(b.safe_until_override);
    if (Number.isNaN(o)) return fail(422, 'safe_until_override is not a valid date');
    if (o > ruleUntil) return fail(422, 'safe_until cannot be later than the safety rule allows');
    safe_until = o;
  }
  if (safe_until <= now) return fail(422, 'Food is already past its safe-until time. Refused.');
  return { ok: {
    donor, donor_id: donor.donor_id, portions, kg_estimate: +(portions * KG_PER_MEAL).toFixed(1),
    diet_type: b.diet_type, food_type: b.food_type, holding_method: b.holding_method,
    packaging: b.packaging || 'not_provided', cooked_at, ready_at: now + readyIn * MIN, safe_until,
    rule_minutes: rule
  } };
}

module.exports = { MIN, MARGIN_MIN, DWELL_MIN, KG_PER_MEAL, fmt, clampNum, safeMinutes, availableVolunteer, validateNewPost };
