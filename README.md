# ApexVoIP Call Center OS

ApexVoIP is a modern, responsive, and enterprise-ready Cloud Call Center Softphone and Real-Time Presence Monitor dashboard. It is designed to replace traditional hardware SIP desk phones with high-performance browser-based WebRTC signaling channels. 

The application is built with a Next.js frontend (using dynamic Tailwind styling) and a Node.js/Express backend paired with WebSocket events for low-latency status synchronization.

---

## Key Features

1. **Agent Softphone Dialer**:
   - High-fidelity visual dialpad (0-9, *, #) with outbound number buffering.
   - Session lifecycle signaling: Ringing, Connected, Hold/Resume, and Mute configurations.
   - Integrated warm/cold transfer logic.
   - Automated simulation sandbox using the Web Audio API for demonstration without requiring an external SIP server setup.

2. **Manager Real-Time Monitoring Portal**:
   - Live KPI Cards: Active Calls, Logged-in Agents, Average Answer Wait, and Call SLA status tracker.
   - Real-time Presence Grid: Displays live states (`Available`, `On-Call`, `Break`, `Wrap-Up`, `Offline`) with incrementing state-duration timers synced via WebSockets.
   - Call History CDR Table: Features pagination, search, and inline HTML5 audio controls for reviewing call recording logs.

3. **Production Architecture**:
   - Fallback Cache System: Automatic local in-memory fallback if Redis is offline.
   - Simulated Data Seeding: Auto-seeds initial mock data to showcase monitoring metrics immediately.
   - Clean, modern layout using HSL custom color palettes and responsive grid modules.

---

## Project Structure

```
call-center-softphone/
├── backend/
│   ├── models/            # MongoDB Schemas (Agent, CallLog)
│   ├── server.js          # Express API & WebSocket Presence Server
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── app/           # Next.js App Router (Layout & main Page)
│   │   ├── components/    # Reusable UI Panels (Dialer, ManagerPortal)
│   │   └── lib/           # SIP.js WebRTC Signaling Wrapper
│   └── package.json
└── README.md
```

---

## Local Setup & Development

### 1. Requirements
- Node.js (v18+)
- MongoDB (optional, falls back to mock seeding)
- Redis (optional, falls back to in-memory status tracking)

### 2. Backend Server Installation
```bash
cd backend
npm install
npm run dev
```
The backend server runs on `http://localhost:5000`.

### 3. Frontend Dashboard Installation
```bash
cd frontend
npm install
npm run dev
```
The Next.js dev server runs on `http://localhost:3000`.

---

## Production Cloud Deployment (Free Tiers)

To deploy the application live for clients to test, you can use the following free tier services:

### 1. MongoDB Database (MongoDB Atlas)
- Sign up for a free account at [MongoDB Atlas](https://www.mongodb.com/products/platform/atlas-database).
- Deploy a free **M0 Shared Cluster**.
- Add IP `0.0.0.0/0` under Network Access to allow Render web instances to connect.
- Copy your connection string (e.g., `mongodb+srv://<username>:<password>@cluster0.xxxx.mongodb.net/call_center_db`).

### 2. Node.js Express Backend (Render)
- Sign up for a free web-hosting account on [Render](https://render.com/).
- Create a **New Web Service** and link it to your GitHub repository.
- Apply the following settings:
  - **Root Directory**: `backend`
  - **Build Command**: `npm install`
  - **Start Command**: `npm start`
  - **Plan**: `Free`
- Under **Environment Variables**, configure:
  - `MONGODB_URI` = `[Your MongoDB Atlas Connection String]`
- Copy your Render Web Service URL (e.g., `https://apexvoip-backend.onrender.com`).

### 3. Next.js Frontend (Vercel)
- Sign up for a free deployment account at [Vercel](https://vercel.com/).
- Create a new project and import your GitHub repository.
- Apply the following settings:
  - **Root Directory**: `frontend`
  - **Framework Preset**: `Next.js`
- Under **Environment Variables**, configure:
  - `NEXT_PUBLIC_BACKEND_API_URL` = `https://apexvoip-backend.onrender.com`
  - `NEXT_PUBLIC_BACKEND_WS_URL` = `wss://apexvoip-backend.onrender.com/ws`
- Click **Deploy**.

---

## Portfolio Integration

To link this live demo to your developer portfolio:
1. Push the repository to your public GitHub account.
2. In your portfolio file (`https://harshilgithubriit.github.io/`), add a clean card showing the live deployment links:
   - **Demo Application**: `https://your-app-frontend.vercel.app`
   - **Source Code**: `https://github.com/your-username/call-center-softphone`
