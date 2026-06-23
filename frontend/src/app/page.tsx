'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Phone, Users, Shield, Server, RefreshCw, Layers } from 'lucide-react';
import Dialer from '../components/Dialer';
import ManagerPortal from '../components/ManagerPortal';

interface UserSession {
  id: string;
  name: string;
  role: 'agent' | 'manager';
}

const MOCK_USERS: UserSession[] = [
  { id: 'agent_alice', name: 'Alice Smith', role: 'agent' },
  { id: 'agent_bob', name: 'Bob Johnson', role: 'agent' },
  { id: 'manager_carol', name: 'Carol Danvers', role: 'manager' }
];

export default function Dashboard() {
  const [currentUser, setCurrentUser] = useState<UserSession>(MOCK_USERS[0]);
  const [activeTab, setActiveTab] = useState<'dialer' | 'manager'>('dialer');
  const [wsConnected, setWsConnected] = useState(false);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [reconnectCounter, setReconnectCounter] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);

  // Initialize unified telemetry socket connection
  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const backendWsUrl = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'ws://127.0.0.1:5000/ws';
    const wsUrl = `${backendWsUrl}?userId=${currentUser.id}&role=${currentUser.role}&name=${encodeURIComponent(currentUser.name)}`;
    console.log(`[WS Main] Initializing socket to: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS Main] Socket connection successfully opened.');
      setWsConnected(true);
    };

    ws.onclose = () => {
      // Only trigger auto-reconnect if this socket was not closed intentionally during cleanup
      if (wsRef.current === ws) {
        console.warn('[WS Main] Socket connection closed. Retrying...');
        setWsConnected(false);
        setTimeout(() => {
          if (wsRef.current === ws) {
            setReconnectCounter(prev => prev + 1);
          }
        }, 3000);
      }
    };

    ws.onerror = (err) => {
      console.error('[WS Main] WebSocket transport error:', err);
    };

    setSocket(ws);
    wsRef.current = ws;

    return () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.close();
    };
  }, [currentUser, reconnectCounter]);

  // Set default tab based on role
  useEffect(() => {
    if (currentUser.role === 'manager') {
      setActiveTab('manager');
    } else {
      setActiveTab('dialer');
    }
  }, [currentUser]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      
      {/* Dynamic Header Console */}
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4">
          
          {/* Branding Logo */}
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-tr from-emerald-600 to-teal-500 rounded-xl text-white shadow-md shadow-emerald-950/20">
              <Phone size={22} />
            </div>
            <div>
              <h1 className="text-md font-bold tracking-tight text-zinc-100">ApexVoIP</h1>
              <p className="text-[10px] font-semibold text-zinc-500 tracking-wider uppercase">Cloud Call Center OS</p>
            </div>
          </div>

          {/* User selector mock auth */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-xl p-1.5">
              <span className="text-[10px] text-zinc-500 font-bold uppercase pl-2 pr-1">Profile:</span>
              <select
                value={currentUser.id}
                onChange={(e) => {
                  const selected = MOCK_USERS.find(u => u.id === e.target.value);
                  if (selected) setCurrentUser(selected);
                }}
                className="bg-zinc-900 text-zinc-200 border-none outline-none text-xs font-semibold pr-2 cursor-pointer"
              >
                {MOCK_USERS.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} ({user.role === 'manager' ? 'Manager' : 'Agent'})
                  </option>
                ))}
              </select>
            </div>

            {/* Connection state tracker */}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full shadow-sm ${
                wsConnected ? 'bg-emerald-500 shadow-emerald-500/20' : 'bg-red-500 animate-pulse shadow-red-500/20'
              }`} />
              <span className="text-[10px] font-bold text-zinc-400 font-mono">
                {wsConnected ? 'WS CONNECTED' : 'WS OFFLINE'}
              </span>
            </div>
          </div>

        </div>
      </header>

      {/* Workspace Tabs Navigator */}
      <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 flex-1 flex flex-col gap-6">
        
        {/* Navigation Tabs Bar */}
        <div className="flex items-center gap-1 border-b border-zinc-900 pb-2">
          
          <button
            onClick={() => setActiveTab('dialer')}
            disabled={currentUser.role === 'manager'}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg border transition ${
              activeTab === 'dialer'
                ? 'bg-zinc-900 border-zinc-800 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300 disabled:opacity-30'
            }`}
          >
            <Layers size={14} />
            <span>Agent Softphone</span>
          </button>

          <button
            onClick={() => setActiveTab('manager')}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg border transition ${
              activeTab === 'manager'
                ? 'bg-zinc-900 border-zinc-800 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <Shield size={14} />
            <span>Manager Live Monitor</span>
          </button>

        </div>

        {/* Dynamic content panes */}
        <div className="flex-1 pb-12">
          {activeTab === 'dialer' ? (
            <Dialer userId={currentUser.id} userName={currentUser.name} wsSocket={socket} />
          ) : (
            <ManagerPortal userId={currentUser.id} userName={currentUser.name} wsSocket={socket} />
          )}
        </div>

      </div>

      {/* Footer System Diagnostics */}
      <footer className="border-t border-zinc-900 bg-zinc-950/60 py-3.5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between text-[10px] text-zinc-500 font-medium">
          <p>© 2026 ApexVoIP. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <Server size={10} /> WebRTC Mode: Browser Sandbox
            </span>
            <span>Telephony SLA Status: Optimal</span>
          </div>
        </div>
      </footer>

    </main>
  );
}
