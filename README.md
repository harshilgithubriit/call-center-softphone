# ApexVoIP Cloud Call Center OS

A modern, enterprise-ready Cloud Call Center Softphone and Real-Time Presence Monitor dashboard. Replaces traditional hardware SIP desk phones with high-performance browser-based WebRTC signaling.

## Features

- **Agent Softphone Dialer**: Full-featured dialpad with call hold/resume, mute, warm/cold transfer, and WebRTC peer-to-peer calling
- **Manager Live Monitor**: Real-time agent presence tracking with KPI dashboard, performance leaderboard, and paginated call history (CDR) with audio playback
- **Production Architecture**: MongoDB + Redis with automatic in-memory fallback for zero-config demo mode

## Quick Start

### Backend
```bash
cd backend
npm install
npm start
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Live Demo

- **Frontend**: [Vercel Deployment URL]
- **Backend API**: [Render Deployment URL]
- **Source Code**: [GitHub Repository](https://github.com/harshilgithubriit/call-center-softphone)

## Tech Stack

- **Frontend**: Next.js 14, React 18, Tailwind CSS, SIP.js, WebRTC
- **Backend**: Node.js, Express, WebSocket, MongoDB, Redis
