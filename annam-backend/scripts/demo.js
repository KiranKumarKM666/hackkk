// Narrated end-to-end run against a RUNNING server:  npm start  (terminal 1),  npm run demo  (terminal 2)
// Prints every request/response summary so you can paste the trace into a report.
const BASE = process.env.BASE || 'http://localhost:3000/api';
const call = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const body = await r.json().catch(() => null);
  console.log(`  ${m} ${u} -> ${r.status}`);
  return { status: r.status, body };
};
const step = t => console.log(`\n=== ${t} ===`);

(async () => {
  await call('POST', '/admin/reseed');
  step('1. Donors post surplus (F1). Server computes safe-until from the rule table');
  const base = { diet_type: 'veg', food_type: 'curry', holding_method: 'hot', cooked_ago_min: 30, ready_in_min: 10 };
  const ids = [];
  for (const [donor_id, portions] of [[1, 20], [2, 25], [3, 15]]) {
    const p = await call('POST', '/posts', { ...base, donor_id, portions });
    ids.push(p.body.post_id);
    console.log(`  post ${p.body.post_id}: ${p.body.donor_name}, ${p.body.portions} portions, safe until ${p.body.safe_until}, colour ${p.body.colour}`);
  }
  step('2. Expiry queue (F2): min-heap order, most urgent first');
  (await call('GET', '/posts?status=open')).body.forEach((p, i) => console.log(`  #${i + 1} post ${p.post_id} leave_by ${p.leave_by} slack ${p.slack_min} min`));

  step('3. Receiver match (F3): feasible receivers ranked with one-line reasons');
  const m = await call('GET', `/posts/${ids[0]}/matches`);
  m.body.eligible.forEach(e => console.log(`  ${e.name} score ${e.score}: ${e.reason}`));
  m.body.refused.forEach(r => console.log(`  REFUSED ${r.name}: ${r.reasons.join('; ')}`));
  const acc = await call('POST', `/matches/${m.body.top_choice.match_id}/accept`);
  console.log('  accepted match', acc.body.match.match_id);

  step('4. Pickup batching (F4): cheapest insertion with deadline re-checks');
  const r = await call('POST', '/routes/batch', { seed_post_id: ids[0] });
  const b = r.body.batching;
  console.log(`  ${b.stops} stops, ${b.batched_minutes} min batched vs ${b.separate_trips_minutes} min separate, trips saved ${b.trips_saved} (${b.trip_reduction_pct}%)`);
  r.body.route.stops.forEach(s => console.log(`  stop: ${s.donor.name} ETA ${s.eta}`));
  console.log(`  deliver to ${r.body.route.receiver.name} ETA ${r.body.route.deliver_eta}; OTP (demo) ${r.body.demo_otp}`);
  await call('POST', `/routes/${r.body.route.route_id}/start`);

  step('5. Handover (F5): donor confirms, driver photo, receiver OTP');
  for (const h of r.body.handovers) {
    await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'donor' });
    await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'driver', photo: Buffer.from('demo-photo-bytes-demo-photo').toString('base64') });
    if (h === r.body.handovers[0]) await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'receiver', otp: '0000' });
    const ok = await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'receiver', otp: r.body.demo_otp });
    console.log('  completed:', ok.body.completed);
  }
  step('6. Impact (verified handovers only)');
  console.log(' ', JSON.stringify((await call('GET', '/impact')).body));

  step('7. Enforcement: a late match is refused');
  const late = await call('POST', '/posts', { ...base, donor_id: 4, portions: 10, food_type: 'sandwich', holding_method: 'room', cooked_ago_min: 118, ready_in_min: 0 });
  const lm = await call('GET', `/posts/${late.body.post_id}/matches`);
  console.log(' ', lm.body.refusal_message);
  lm.body.refused.slice(0, 2).forEach(x => console.log(`  ${x.name}: ${x.reasons.join('; ')}`));
  step('Audit trail for post ' + ids[0]);
  (await call('GET', `/posts/${ids[0]}/audit`)).body.forEach(e => console.log(`  ${e.timestamp} ${e.type}`));
})();
