# Prompt for Google Antigravity (paste everything below the line)

---

You are working on **Annam**, a surplus-food rescue web platform. Read `README.md` first, then work in this order. Do not skip steps. Use Planning mode and show me your plan before editing.

## Context
- `/annam-backend` is a finished Node/Express/SQLite backend (API under `/api`, SSE at `/api/stream`). It is already tested: run `npm install && npm test` and confirm **14 passed, 0 failed** before touching anything.
- The front end is my existing single-file page. Save it as `annam-backend/public/index.html`. It is a "Food Donations" site with an "NGO Donation & OTP Verification" portal (Meals / Ration / Biogas tabs, donor view, NGO dashboard). It currently stores everything in `localStorage` key `ngo_meal_donations`.
- The backend is the source of truth for time (never trust the browser clock) and for OTPs.

## Task 1: Integrate the existing NGO portal with the backend
Replace every `localStorage` use in the portal script with `fetch` calls (same-origin, base `/api`):
- `handleDonate`, `handleRationDonate`, `handleBiogasDonate` -> `POST /api/donations` with `{type:'MEAL'|'RATION'|'BIOGAS', phone, ngo, ...the same fields the code builds today}` (meal: `meals`; ration: `item, qtyKg, qtyLabel, note`; biogas: `wasteType, qtyKg, rate, amount, biogasM3, address, partnerName, partnerAddress, partnerPhone`). Use the returned record's `id` and `otp` in the success alert.
- `handleVerifyOTP` -> `POST /api/donations/verify` `{phone, otp}`. Show server errors (404 invalid, 409 already verified). Use the server's `servedAt`, not a client-generated timestamp.
- `renderNgoDashboard` -> `GET /api/donations?ngo=&month=&type=` and keep the existing stat cards and table logic.
- Make handlers `async`, add loading/disabled states on buttons and a visible error message if the server is unreachable. Keep the visual design unchanged.

## Task 2: Add the Annam features as new tabs in the same page
Add tabs next to the existing two. Large tap targets, low text density, works on a phone.
1. **Post Surplus** (3 taps): quantity, food type + holding method (call `GET /api/posts/suggest-safe-until` to show the suggested safe-until), veg/non-veg, then `POST /api/posts`. Donor picker from `GET /api/donors`.
2. **Expiry Board**: `GET /api/posts?status=open` (already in heap order, most urgent first). Live countdown per post that turns green -> amber -> red using `colour`/`seconds_left`. Correct the countdown with the server time from SSE `tick` events (`event: tick`, `data.server_time`). Show "Leave by HH:MM" from `leave_by`. Subscribe with `EventSource('/api/stream')` and refresh on `post_created`, `match_accepted`, `route_planned`, `in_transit`, `delivered`, `expired`.
3. **Match**: `GET /api/posts/:id/matches` -> show `top_choice.reason`, the ranked list, the `refused` list with reasons, and the food-safety disclaimer on every match screen. Buttons call `POST /api/matches/:id/accept` or `/decline`. If `eligible` is empty show `refusal_message` prominently (refusal is a feature).
4. **Route**: `POST /api/routes/batch` (optionally `{seed_post_id}`), then `GET /api/routes/:id` and draw `polyline` plus stop markers on a Leaflet + OpenStreetMap map (load Leaflet from a CDN). Show stop ETAs, `batching.trip_reduction_pct`, batched vs separate minutes. Add a "Start trip" button -> `POST /api/routes/:id/start`.
5. **Handover**: per handover, three buttons: donor confirms pickup (`role:'donor'`), driver uploads photo (`role:'driver'`, `photo` = base64 data URL from a file input or camera), receiver enters OTP (`role:'receiver'`, `otp`). Show the on-screen demo OTP from the batch response (`demo_otp`). Surface 403 (wrong OTP) and 409 (past safe-until) clearly.
6. **Impact**: `GET /api/impact` and `GET /api/impact/donors` -> meals, kg, trips saved, per-donor weekly table. State that only verified handovers are counted.

## Task 3: Verify like a user
1. Start the server (`npm start`) and open the app in the built-in browser.
2. Walk the whole loop: post 3 surplus items from donors 1, 2, 3 -> check board order -> match -> accept -> batch -> start -> handover (try a wrong OTP first) -> impact. Then post a nearly-expired sandwich (cooked_ago_min 118, room) and show it being refused.
3. Also exercise the NGO portal flow (meal donation -> OTP from NGO dashboard -> verify).
4. Capture screenshots of each step into `report/screenshots/`.
5. Re-run `npm test` and `npm run demo`; save the demo output to `report/demo-trace.txt`.
Fix any integration bug you find in the front end. If you think a backend change is needed, explain why and ask me first.

## Task 4: Write the report I can learn from (`report/REPORT.md`, plus a PDF export if available)
Write for a smart beginner who has to explain this project to judges. Plain language, short paragraphs, no filler. Include:
1. **The idea in one page**: the problem (time, not goodwill), the 4-hour safe window, the single number "60 meals, 24 kg, zero waste".
2. **Architecture**: a Mermaid diagram of browser -> Express API -> SQLite, road graph in memory, SSE, expiry timer. One paragraph per layer.
3. **Request lifecycle**: a Mermaid sequence diagram for the full loop (post, queue, match, accept, batch, start, handover, impact), annotated with the real endpoints and a real JSON snippet from `report/demo-trace.txt`.
4. **How each algorithm works, with a worked example using real numbers from the trace**: min-heap expiry queue (why leave-by, not posted-time), feasibility check (formula with margin), match scoring (list the weights from `lib/matcher.js` and show one calculation), Dijkstra on the road graph, cheapest-insertion batching (show the 67% trip reduction), OTP + photo + two-sided confirmation.
5. **Safety and trust design**: server-side time, hard deadline refusals, shorten-only safe-until, hashed OTP with attempt lock, disclaimer, anti-inflation rule. Point to the exact file and function for each.
6. **Front end <-> back end map**: a table of every UI action -> endpoint -> backend function -> DB tables touched.
7. **Data model**: ER diagram (Mermaid) of the tables in `db.js`.
8. **Test evidence**: the 14 tests, what each proves, and the checklist item it covers.
9. **Honest limitations and next steps**: no auth, synthetic road graph, on-screen OTP instead of SMS, no partial acceptance, localStorage replaced but data is not user-scoped.
10. **A 3-minute demo script** matching the pitch beats (hook, post, match, batch, handover, impact, enforcement) and a list of likely judge questions with short answers.
Embed the screenshots. Do not invent features, numbers or files: only describe what exists in the repo and in the trace. If something is unclear, say so in the report.

## Rules
- Keep the backend API contract unchanged unless I approve.
- No new paid services, no API keys.
- Commit in small steps with clear messages. At the end, list every file you changed.
