// The SERVER decides what time it is. Client clocks are never trusted.
// The offset exists only so tests/demos can fast-forward time.
let offsetMs = 0;
module.exports = {
  now: () => Date.now() + offsetMs,
  setOffsetMinutes: m => { offsetMs = m * 60000; },
  offsetMinutes: () => offsetMs / 60000
};
