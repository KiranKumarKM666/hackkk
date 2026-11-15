# Annam & Food Rescue Platform — Integration Report

## 1. Project Overview & Deliverables Completed

This repository integrates the **Food Donations** front-end with the **Annam surplus-food rescue backend** (Node.js, Express, SQLite, SSE, Dijkstra Graph Routing, and algorithmic dispatch).

### Key Completed Tasks:
1. **Frontend Integration (`annam-backend/public/index.html`)**:
   - Replaced all `localStorage` usage with asynchronous `fetch` calls to backend endpoints (`/api/donations`, `/api/donations/verify`, `/api/donations`).
   - Unified the NGO portal with all Annam operational modules into an interactive single-page application:
     - **⏱️ Expiry Board (F2)**: Live min-heap urgency queue with real-time countdown synchronized to server time via Server-Sent Events (`/api/stream`).
     - **🍲 Post Surplus (F1)**: Fast surplus posting with live food-safety window calculations (`/api/posts/suggest-safe-until`).
     - **🤝 Receiver Match (F3)**: Multi-factor receiver scoring with transparent breakdown and explicit food-safety refusal justifications.
     - **🗺️ Batched Route Dispatch (F4)**: Cheapest-insertion vehicle route optimization with stop ETAs and trips-saved metrics.
     - **📦 Handover & Verification (F5)**: Two-sided confirmation requiring donor pickup confirmation, driver photo upload, and receiver OTP verification.
     - **📊 Impact Metrics (F6)**: Real-time calculation of verified meals rescued, kg diverted from landfills, and delivery trips saved.

2. **Google Maps Platform Integration**:
   - Added Google Maps JavaScript API with the `YOUR_GOOGLE_MAPS_API_KEY` placeholder.
   - Built dual-engine mapping: Interactive Google Maps for satellite/road views, with automatic Leaflet / OpenStreetMap fallback so maps and routes always render even before API credentials are provided.

3. **WhatsApp OTP Cloud API Integration**:
   - Added automated WhatsApp OTP messaging to `app.js` using Meta's Cloud API (`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`).
   - Triggered automatically whenever donations or delivery handover routes are created.
   - Kept `DEMO_SHOW_OTP=true` active as a zero-friction fallback so demos and automated test suites work seamlessly without requiring active WhatsApp credentials.

4. **Testing and Verification**:
   - `npm test`: **14 passed, 0 failed** (100% test compliance).
   - `npm run demo`: End-to-end trace executed successfully (60 meals rescued, 24 kg food saved, 66.7% trip reduction).
   - Server running live on `http://localhost:3000`.

---

## 2. Where to Paste Your API Keys

### A. WhatsApp Cloud API Keys
Edit the file: `annam-backend/.env`

```env
# Meta / WhatsApp Cloud API Credentials
# Replace the placeholders below with your actual values from Meta for Developers:
WHATSAPP_TOKEN=paste_your_meta_system_user_token_here
WHATSAPP_PHONE_ID=paste_your_meta_phone_number_id_here
```

#### How to obtain your WhatsApp credentials:
1. Go to [Meta for Developers](https://developers.facebook.com/).
2. Create or select an App (type: **Business**).
3. Add the **WhatsApp** product.
4. Under **API Setup**:
   - Copy your **Temporary Access Token** (or generate a permanent System User Token under Business Settings > System Users).
   - Copy your **Phone number ID**.
5. Paste them into `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` in `annam-backend/.env`.

---

### B. Google Maps API Key
There are two places configured for your Google Maps API key:

#### 1. In the Frontend (`annam-backend/public/index.html`):
Open `annam-backend/public/index.html` and locate line ~438:
```html
<!-- Google Maps JavaScript API with YOUR_GOOGLE_MAPS_API_KEY placeholder -->
<script>
  window.GOOGLE_MAPS_API_KEY = "YOUR_GOOGLE_MAPS_API_KEY";
</script>
<script src="https://maps.googleapis.com/maps/api/js?key=YOUR_GOOGLE_MAPS_API_KEY&libraries=geometry&callback=onGoogleMapsLoaded" async defer onerror="onGoogleMapsError()"></script>
```
Replace `YOUR_GOOGLE_MAPS_API_KEY` with your actual Google Maps API key.

#### 2. In the Backend Environment (`annam-backend/.env`):
Open `annam-backend/.env` and update:
```env
GOOGLE_MAPS_API_KEY=YOUR_GOOGLE_MAPS_API_KEY
```

#### How to obtain your Google Maps API key:
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **APIs & Services > Credentials**.
3. Click **+ Create Credentials > API Key**.
4. Enable the **Maps JavaScript API** under **APIs & Services > Library**.
5. Replace `YOUR_GOOGLE_MAPS_API_KEY` with your newly created key.

---

## 3. How to Run the Application

### Start the Server:
```bash
cd annam-backend
npm install
npm start
```
The server will start at: `http://localhost:3000`

### Accessing the Web Application:
Open your browser and navigate to:
```
http://localhost:3000
```

### Run Automated Tests:
```bash
cd annam-backend
npm test
```
*Expected result:* `14 passed, 0 failed`

### Run Narrated End-to-End Simulation:
```bash
cd annam-backend
npm run demo
```
*Demonstrates surplus posting, min-heap queueing, receiver matching, batch routing, and OTP handover verification.*
