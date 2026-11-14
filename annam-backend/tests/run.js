// Scripted tests from the Annam testing checklist. Run: npm test
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const assert = require('assert');
const { app, expirySweep } = require('../app');
const MinHeap = require('../lib/minheap');
const { roads } = require('../lib/graph');
const db = require('../db');

let server, base, passed = 0, failed = 0;
const call = async (method, url, body) => {
  const r = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  PASS', name); }
  catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message); }
};
const clean = () => db.exec('DELETE FROM events; DELETE FROM handovers; DELETE FROM matches; DELETE FROM routes; DELETE FROM posts;');
const post = (o = {}) => call('POST', '/posts', { donor_id: 1, portions: 20, diet_type: 'veg', food_type: 'curry', holding_method: 'hot', cooked_ago_min: 30, ready_in_min: 5, ...o });

(async () => {
  server = app.listen(0); base = `http://localhost:${server.address().port}`;
  console.log('Annam test checklist');

  await test('Min-heap pops smallest key first', () => {
    const h = new MinHeap(); [5, 1, 9, 3, 7, 2].forEach(k => h.push(k, k));
    const out = []; while (h.size) out.push(h.pop().key);
    assert.deepStrictEqual(out, [1, 2, 3, 5, 7, 9]);
  });

  await test('Dijkstra returns symmetric, positive travel times', () => {
    const a = roads.minutes(0, 41), b = roads.minutes(41, 0);
    assert(a > 0 && Math.abs(a - b) < 1e-9);
  });

  await test('Safety: post already past safe-until is rejected', async () => {
    const r = await post({ food_type: 'cooked_rice', holding_method: 'room', cooked_ago_min: 200 });
    assert.strictEqual(r.status, 422);
  });

  await test('Safety: safe-until can only be shortened, never extended', async () => {
    const tooLate = new Date(Date.now() + 10 * 3600e3).toISOString();
    assert.strictEqual((await post({ safe_until_override: tooLate })).status, 422);
    const ok = new Date(Date.now() + 90 * 60e3).toISOString();
    const r = await post({ safe_until_override: ok });
    assert.strictEqual(r.status, 201);
    assert(Math.abs(Date.parse(r.body.safe_until) - Date.parse(ok)) < 1000);
  });

  await test('Time handling: client-supplied timestamps are ignored', async () => {
    const r = await post({ ready_at: '2099-01-01', safe_until: '2099-01-01', cooked_at: '2099-01-01', client_time: '2099-01-01' });
    assert.strictEqual(r.status, 201);
    assert(Date.parse(r.body.safe_until) < Date.now() + 5 * 3600e3);
  });

  await test('Queue order: nearly-expired post jumps ahead of an earlier, fresher post', async () => {
    clean();
    const fresh = await post({ cooked_ago_min: 0 });                                    // safe ~4h
    const urgent = await post({ donor_id: 2, food_type: 'sandwich', holding_method: 'room', cooked_ago_min: 60 }); // safe ~1h
    const list = await call('GET', '/posts?status=open');
    assert.strictEqual(list.body[0].post_id, urgent.body.post_id);
    assert.strictEqual(list.body[1].post_id, fresh.body.post_id);
  });

  await test('Feasibility: late match is refused with reasons, not silently dropped', async () => {
    clean();
    const p = await post({ food_type: 'sandwich', holding_method: 'room', cooked_ago_min: 118, ready_in_min: 0 });
    assert.strictEqual(p.status, 201);
    const m = await call('GET', `/posts/${p.body.post_id}/matches`);
    assert.strictEqual(m.body.eligible.length, 0);
    assert(m.body.refused.every(r => r.reasons.some(x => x.startsWith('time'))));
    assert(/says no/.test(m.body.refusal_message));
  });

  await test('Dietary: non-veg post is never matched to a veg-only receiver', async () => {
    clean();
    const p = await post({ diet_type: 'nonveg', food_type: 'biryani' });
    const m = await call('GET', `/posts/${p.body.post_id}/matches`);
    const vegOnly = new Set(db.prepare("SELECT receiver_id FROM receivers WHERE diet_rules='veg_only'").all().map(r => r.receiver_id));
    assert(m.body.eligible.length > 0);
    assert(m.body.eligible.every(e => !vegOnly.has(e.receiver_id)));
  });

  await test('Capacity: receiver is never assigned more portions than it holds', async () => {
    clean();
    const p = await post({ portions: 100 });
    const m = await call('GET', `/posts/${p.body.post_id}/matches`);
    const caps = Object.fromEntries(db.prepare('SELECT receiver_id, capacity_portions c FROM receivers').all().map(r => [r.receiver_id, r.c]));
    assert(m.body.eligible.length > 0 && m.body.eligible.every(e => caps[e.receiver_id] >= 100));
  });

  await test('Match accept re-checks feasibility with SERVER time', async () => {
    clean();
    const p = await post({ food_type: 'sandwich', holding_method: 'room', cooked_ago_min: 60 });
    const m = await call('GET', `/posts/${p.body.post_id}/matches`);
    await call('POST', '/admin/clock', { offset_minutes: 55 });  // fast-forward the server clock
    const acc = await call('POST', `/matches/${m.body.top_choice.match_id}/accept`);
    await call('POST', '/admin/clock', { offset_minutes: 0 });
    assert.strictEqual(acc.status, 409);
  });

  await test('Timer expires posts that can no longer be delivered', async () => {
    clean();
    const p = await post({ food_type: 'sandwich', holding_method: 'room', cooked_ago_min: 60 });
    await call('POST', '/admin/clock', { offset_minutes: 58 });
    const n = expirySweep();
    await call('POST', '/admin/clock', { offset_minutes: 0 });
    assert(n >= 1);
    assert.strictEqual((await call('GET', `/posts/${p.body.post_id}`)).body.status, 'expired');
  });

  await test('Batching: every stop meets its deadline; trips fall by at least 30%', async () => {
    clean();
    const ids = [1, 2, 3];   // three nearby donors
    for (const d of ids) await post({ donor_id: d, portions: 20 });
    const r = await call('POST', '/routes/batch', {});
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert(r.body.batching.stops >= 2);
    assert(r.body.batching.trip_reduction_pct >= 30);
    const deliver = Date.parse(r.body.route.deliver_eta);
    const open = db.prepare('SELECT * FROM posts').all();
    for (const p of open) assert(deliver + 10 * 60000 <= p.safe_until, 'deadline broken');
    globalThis.__route = r.body;
  });

  await test('Handover: wrong OTP fails; counter moves only after BOTH confirmations + photo', async () => {
    const r = globalThis.__route, hs = r.handovers;
    assert.strictEqual((await call('GET', '/impact')).body.verified_handovers, 0);
    const bad = await call('POST', `/handovers/${hs[0].handover_id}/confirm`, { role: 'receiver', otp: '0000' });
    assert.strictEqual(bad.status, 403);
    await call('POST', `/routes/${r.route.route_id}/start`);
    for (const h of hs) {
      await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'donor' });
      await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'driver', photo: Buffer.from('fake-image-bytes-for-test').toString('base64') });
      assert.strictEqual((await call('GET', '/impact')).body.verified_handovers, hs.indexOf(h)); // not yet: receiver unconfirmed
      const ok = await call('POST', `/handovers/${h.handover_id}/confirm`, { role: 'receiver', otp: r.demo_otp });
      assert.strictEqual(ok.body.completed, true);
    }
    const imp = (await call('GET', '/impact')).body;
    assert.strictEqual(imp.verified_handovers, hs.length);
    assert.strictEqual(imp.meals, 20 * hs.length);
    assert.strictEqual(imp.kg, +(20 * 0.4 * hs.length).toFixed(1));
    assert.strictEqual(imp.trips_saved, hs.length - 1);
  });

  await test('Legacy NGO portal: donate -> wrong OTP -> verify -> dashboard list', async () => {
    const d = await call('POST', '/donations', { type: 'MEAL', phone: '9876543210', ngo: 'Shanti Ashram', meals: 5 });
    assert.strictEqual(d.status, 201);
    assert.strictEqual((await call('POST', '/donations/verify', { phone: '9876543210', otp: 'xxxx' })).status, 404);
    const v = await call('POST', '/donations/verify', { phone: '9876543210', otp: d.body.otp });
    assert.strictEqual(v.body.status, 'SERVED');
    assert.strictEqual((await call('POST', '/donations/verify', { phone: '9876543210', otp: d.body.otp })).status, 409);
    assert((await call('GET', '/donations?type=MEAL')).body.length === 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  process.exit(failed ? 1 : 0);
})();
