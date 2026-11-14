# Annam Backend

Node.js + Express + SQLite (better-sqlite3). Implements the architecture in *Annam: Detailed Project Overview*.

## Run
```bash
npm install
npm start            # http://localhost:3000  (API under /api, static front end served from /public)
npm test             # 14 scripted tests from the testing checklist
npm run demo         # narrated end-to-end run (server must be running); paste the trace into your report
```
Put your front end at `public/index.html`. Set `DEMO_SHOW_OTP=false` to hide the on-screen OTP, `NODE_ENV=production` to disable `/api/admin/*`.

## Module map
| Overview module | File | What it does |
|---|---|---|
| F1 Surplus post | `lib/rules.js`, `POST /api/posts` | Validates, computes safe-until from rule table (shorten only), ignores client clock |
| F2 Expiry queue | `lib/minheap.js`, `lib/queue.js` | Min-heap keyed by leave-by = safe-until - margin - fastest delivery |
| F3 Receiver match | `lib/matcher.js` | Hard filters (diet, capacity, collection, feasibility) then weighted score + one-line reason + refusal reasons |
| F4 Pickup batching | `lib/batcher.js` | Cheapest insertion, every deadline re-checked, trips-saved metric |
| F5 Handover/impact | `app.js` handover + impact routes | OTP (hashed) + photo + both confirmations; impact counts verified handovers only |
| Road graph | `lib/graph.js` | 42-node grid, Dijkstra with min-heap (swap in an OSM extract later) |
| Server clock | `lib/clock.js` | Server decides time; offset only for demos/tests |
| Live updates | `lib/bus.js`, `GET /api/stream` | Server-sent events: post/match/route events + 5s `tick` with server time |
| Expiry timer | `expirySweep()` in `app.js` | Every 15 s expires posts that can no longer be delivered |
| Legacy NGO portal | `/api/donations*` | Replaces the front end's localStorage (meals / ration / biogas + OTP) |

## Endpoints
`GET /api/posts?status=open` · `POST /api/posts` · `GET /api/posts/suggest-safe-until` · `GET /api/posts/:id/matches` · `POST /api/matches/:id/accept|decline` ·
`POST /api/routes/batch` · `GET /api/routes/:id` (with polyline) · `POST /api/routes/:id/start` · `POST /api/handovers/:id/confirm` (role: donor | driver | receiver) ·
`GET /api/impact` · `GET /api/impact/donors` · `GET /api/donors|receivers|volunteers|graph|safety-rules` · `GET /api/stream` · `GET /api/posts/:id/audit` ·
`POST /api/donations` · `POST /api/donations/verify` · `GET /api/donations` · demo only: `POST /api/admin/clock|reseed`

## Known limits (be honest in the demo)
No authentication or roles yet; SMS is replaced by an on-screen OTP; the road graph is a synthetic grid; partial acceptance is not implemented; safe-window table is guidance, not certification.
