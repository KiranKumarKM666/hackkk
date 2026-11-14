// Demo seed: 10 donors, 6 receivers, 3 volunteers, safety rules. Coordinates snap to the road graph.
const db = require('./db');
const { roads } = require('./lib/graph');

const DONORS = [
  ['Vidyarthi Hostel Mess', 'hostel', 12.945, 77.580], ['Sri Annapoorna Restaurant', 'restaurant', 12.950, 77.590],
  ['Green Leaf Caterers', 'caterer', 12.955, 77.585], ['University Boys Hostel Mess', 'hostel', 12.962, 77.575],
  ['Royal Banquet Hall', 'caterer', 12.970, 77.600], ['Tiffin Junction', 'restaurant', 12.940, 77.610],
  ['City Girls Hostel Mess', 'hostel', 12.975, 77.570], ['Spice Route Restaurant', 'restaurant', 12.985, 77.615],
  ['Sunrise Catering Co.', 'caterer', 12.935, 77.570], ['Tech Park Canteen', 'canteen', 12.958, 77.620]
];
// name, lat, lng, capacity, diet, can_collect, need_level
const RECEIVERS = [
  ['Shanti Ashram', 12.965, 77.595, 80, 'any', 0, 4], ['Annapurna Seva Trust', 12.948, 77.600, 120, 'any', 1, 3],
  ['Karuna Shelter Home', 12.972, 77.582, 50, 'veg_only', 0, 5], ['Asha Night Shelter', 12.938, 77.585, 100, 'any', 0, 4],
  ['Seva Sadan Orphanage', 12.985, 77.600, 60, 'veg_only', 1, 3], ['Hope Community Kitchen', 12.955, 77.630, 150, 'any', 0, 2]
];
const VOLUNTEERS = [['Ravi', 'bike', 30, 0, 24], ['Meera', 'car', 120, 0, 24], ['Arjun', 'van', 200, 18, 27]];
// Guidance drawn from public food-safety principles (hot hold >=60C, cold <=5C, 2-hour room-temperature rule).
// A GUIDE, NOT A CERTIFICATION. The receiving kitchen always makes the final call.
const RULES = [
  ['cooked_rice', 'hot', 240], ['cooked_rice', 'room', 120], ['curry', 'hot', 240], ['curry', 'room', 120],
  ['roti', 'hot', 180], ['roti', 'room', 120], ['biryani', 'hot', 240], ['sandwich', 'cold', 300],
  ['sandwich', 'room', 120], ['sweets', 'room', 360], ['bakery', 'room', 480]
];

function reseed() {
  db.exec('DELETE FROM events; DELETE FROM handovers; DELETE FROM matches; DELETE FROM routes; DELETE FROM posts; DELETE FROM donors; DELETE FROM receivers; DELETE FROM volunteers; DELETE FROM safety_rules; DELETE FROM donations;');
  const tx = db.transaction(() => {
    DONORS.forEach(([n, t, la, ln], i) => db.prepare('INSERT INTO donors VALUES (?,?,?,?,?,?,?)')
      .run(i + 1, n, t, la, ln, roads.nearest(la, ln), `+91 90000 1${String(i).padStart(4, '0')}`));
    RECEIVERS.forEach(([n, la, ln, cap, diet, col, need], i) => db.prepare('INSERT INTO receivers VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(i + 1, n, la, ln, roads.nearest(la, ln), cap, diet, col, need, `+91 90000 2${String(i).padStart(4, '0')}`));
    VOLUNTEERS.forEach(([n, v, c, s, e], i) => db.prepare('INSERT INTO volunteers VALUES (?,?,?,?,?,?)').run(i + 1, n, v, c, s, e));
    RULES.forEach(r => db.prepare('INSERT INTO safety_rules VALUES (?,?,?)').run(...r));
  });
  tx();
}
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM donors').get().c === 0) reseed();
}
module.exports = { reseed, seedIfEmpty };
