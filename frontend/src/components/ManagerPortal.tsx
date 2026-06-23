'use client';

import React, { useState, useEffect } from 'react';
import { Phone, Users, Clock, AlertTriangle, Play, Pause, ChevronLeft, ChevronRight, BarChart2 } from 'lucide-react';

interface AgentState {
  userId: string;
  name: string;
  role: string;
  status: 'Available' | 'On-Call' | 'Break' | 'Wrap-Up' | 'Offline';
  lastStatusChange: string;
}

interface CallLog {
  _id: string;
  callId: string;
  callerId: string;
  agentId: {
    userId: string;
    name: string;
  } | null;
  direction: 'Inbound' | 'Outbound';
  status: 'Answered' | 'Missed' | 'Busy' | 'Abandoned';
  startTime: string;
  endTime: string | null;
  durationInSeconds: number;
  recordingUrl: string | null;
}

interface ManagerPortalProps {
  userId: string;
  userName: string;
  wsSocket: WebSocket | null;
}

// Live timer component for agent status duration
function StateTimer({ lastStatusChange }: { lastStatusChange: string }) {
  const [duration, setDuration] = useState('00:00');

  useEffect(() => {
    const calculateDuration = () => {
      const elapsed = Date.now() - new Date(lastStatusChange).getTime();
      const totalSeconds = Math.max(0, Math.floor(elapsed / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      setDuration(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
    };

    calculateDuration(); // initial
    const interval = setInterval(calculateDuration, 1000);
    return () => clearInterval(interval);
  }, [lastStatusChange]);

  return <span className="font-mono text-xs">{duration}</span>;
}

export default function ManagerPortal({ userId, userName, wsSocket }: ManagerPortalProps) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [history, setHistory] = useState<CallLog[]>([]);
  const [kpis, setKpis] = useState({
    activeCalls: 0,
    loggedInAgents: 0,
    avgWaitTime: '00:18', // standard wait SLA target
    abandonedCount: 0
  });

  // Call history pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Performance metrics aggregates
  const [performanceData, setPerformanceData] = useState<any[]>([]);

  // Connect manager WS hooks
  useEffect(() => {
    if (!wsSocket) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        console.log('[Manager Portal] Received Event:', payload);

        switch (payload.type) {
          case 'current_agents_state':
            setAgents(payload.agents);
            break;

          case 'agent_status_updated':
            setAgents(prev => {
              const list = [...prev];
              const idx = list.findIndex(a => a.userId === payload.agent.userId);
              if (idx !== -1) {
                list[idx] = payload.agent;
              } else {
                list.push(payload.agent);
              }
              return list;
            });
            break;

          case 'call_telemetry_event':
            // Update Active Calls counts in real-time
            if (payload.telemetry.callState === 'Ringing' || payload.telemetry.callState === 'Connected') {
              setKpis(prev => ({
                ...prev,
                activeCalls: prev.activeCalls + 1
              }));
            } else if (payload.telemetry.callState === 'Completed') {
              setKpis(prev => ({
                ...prev,
                activeCalls: Math.max(0, prev.activeCalls - 1)
              }));
              // Refresh database logs
              fetchCallHistory(1);
              fetchPerformanceMetrics();
            }
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('[Manager Portal] WS payload process error:', err);
      }
    };

    wsSocket.addEventListener('message', handleMessage);
    
    // Initial fetches
    fetchCallHistory(1);
    fetchPerformanceMetrics();

    return () => {
      wsSocket.removeEventListener('message', handleMessage);
    };
  }, [wsSocket]);

  // Aggregate agent count whenever agent status changes
  useEffect(() => {
    const activeAgents = agents.filter(a => a.status !== 'Offline').length;
    setKpis(prev => ({
      ...prev,
      loggedInAgents: activeAgents
    }));
  }, [agents]);

  // Fetch Call History
  const fetchCallHistory = async (pageNumber: number) => {
    const apiBaseUrl = process.env.NEXT_PUBLIC_BACKEND_API_URL || 'http://127.0.0.1:5000';
    try {
      const response = await fetch(`${apiBaseUrl}/api/calls/history?page=${pageNumber}&limit=5`);
      const resData = await response.json();
      if (resData.success) {
        setHistory(resData.data);
        setPage(resData.pagination.page);
        setTotalPages(resData.pagination.pages);

        // Fetch count of abandoned calls from database logs for KPIs
        const abandonedQuery = await fetch(`${apiBaseUrl}/api/calls/history?limit=1000`);
        const abData = await abandonedQuery.json();
        if (abData.success) {
          const count = abData.data.filter((c: CallLog) => c.status === 'Abandoned').length;
          setKpis(prev => ({ ...prev, abandonedCount: count }));
        }
      }
    } catch (err) {
      console.error('[Manager Portal] Call history fetch error:', err);
    }
  };

  // Fetch Performance Metrics
  const fetchPerformanceMetrics = async () => {
    const apiBaseUrl = process.env.NEXT_PUBLIC_BACKEND_API_URL || 'http://127.0.0.1:5000';
    try {
      const response = await fetch(`${apiBaseUrl}/api/agents/performance`);
      const resData = await response.json();
      if (resData.success) {
        setPerformanceData(resData.data);
      }
    } catch (err) {
      console.error('[Manager Portal] Performance metrics fetch error:', err);
    }
  };

  const getStatusBadgeColor = (status: AgentState['status']) => {
    switch (status) {
      case 'Available': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'On-Call': return 'bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse';
      case 'Break': return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'Wrap-Up': return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
      default: return 'bg-zinc-800 text-zinc-500 border-zinc-700';
    }
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      
      {/* 1. KPI Counter Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        
        {/* Active Calls */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 flex items-center justify-between shadow-lg">
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider">Active Call Channels</p>
            <h3 className="text-3xl font-bold font-mono text-zinc-100">{kpis.activeCalls}</h3>
          </div>
          <div className="p-3 bg-rose-500/10 text-rose-400 rounded-xl border border-rose-500/20">
            <Phone size={24} />
          </div>
        </div>

        {/* Logged in Agents */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 flex items-center justify-between shadow-lg">
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider">Active Logged-In Agents</p>
            <h3 className="text-3xl font-bold font-mono text-zinc-100">{kpis.loggedInAgents}</h3>
          </div>
          <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
            <Users size={24} />
          </div>
        </div>

        {/* Average Wait Time */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 flex items-center justify-between shadow-lg">
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider">Avg Answer Wait (SLA)</p>
            <h3 className="text-3xl font-bold font-mono text-zinc-100">{kpis.avgWaitTime}</h3>
          </div>
          <div className="p-3 bg-blue-500/10 text-blue-400 rounded-xl border border-blue-500/20">
            <Clock size={24} />
          </div>
        </div>

        {/* Abandoned Calls */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 flex items-center justify-between shadow-lg">
          <div className="space-y-1">
            <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider">Abandoned Queue Calls</p>
            <h3 className="text-3xl font-bold font-mono text-zinc-100">{kpis.abandonedCount}</h3>
          </div>
          <div className="p-3 bg-amber-500/10 text-amber-400 rounded-xl border border-amber-500/20">
            <AlertTriangle size={24} />
          </div>
        </div>

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* 2. Agent Live State Matrix Grid (Spans 2 columns) */}
        <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Agent Presence Console</h2>
            <p className="text-xs text-zinc-500">Real-time mapping of connected call handlers</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {agents.length === 0 ? (
              <div className="col-span-2 text-center text-zinc-500 py-8 text-sm">
                No active agent connection telemetry received.
              </div>
            ) : (
              agents.map((agent) => (
                <div 
                  key={agent.userId}
                  className="bg-zinc-850 border border-zinc-800/80 rounded-xl p-4 flex items-center justify-between hover:border-zinc-700 transition"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-200">{agent.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">({agent.userId})</span>
                    </div>
                    <p className="text-xs text-zinc-500 capitalize">{agent.role}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${getStatusBadgeColor(agent.status)}`}>
                      {agent.status}
                    </span>
                    {agent.status !== 'Offline' && (
                      <div className="text-[10px] text-zinc-400 flex items-center gap-1">
                        <span>Duration:</span>
                        <StateTimer lastStatusChange={agent.lastStatusChange} />
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 3. Aggregated Agent performance analytics leaderboard */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Performance Leaderboard</h2>
            <p className="text-xs text-zinc-500">Historical performance metrics aggregated from DB</p>
          </div>

          <div className="space-y-3.5 max-h-[300px] overflow-y-auto pr-1">
            {performanceData.length === 0 ? (
              <div className="text-center text-zinc-500 py-8 text-sm">
                No performance data to display.
              </div>
            ) : (
              performanceData.map((data, index) => (
                <div key={data.agentId || index} className="bg-zinc-850 p-3.5 rounded-xl border border-zinc-800 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-zinc-500 font-mono">#{index + 1}</span>
                      <span className="text-sm font-semibold text-zinc-200">{data.name}</span>
                    </div>
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded font-medium capitalize">
                      {data.role}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-zinc-900/50 p-1.5 rounded">
                      <p className="text-[10px] text-zinc-500 font-semibold uppercase">Total</p>
                      <p className="text-sm font-bold font-mono text-zinc-300">{data.totalCalls}</p>
                    </div>
                    <div className="bg-zinc-900/50 p-1.5 rounded">
                      <p className="text-[10px] text-emerald-500 font-semibold uppercase">Ans</p>
                      <p className="text-sm font-bold font-mono text-emerald-400">{data.answeredCalls}</p>
                    </div>
                    <div className="bg-zinc-900/50 p-1.5 rounded">
                      <p className="text-[10px] text-blue-500 font-semibold uppercase">Avg Dur</p>
                      <p className="text-xs font-bold font-mono text-blue-400 mt-0.5">{data.avgDuration}s</p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* 4. Paginated Call Analytics CDR Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Historical Call Logs (CDRs)</h2>
            <p className="text-xs text-zinc-500">Browse historical call activities and call recordings</p>
          </div>
          
          {/* Pagination controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchCallHistory(page - 1)}
              disabled={page <= 1}
              className="p-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-400 transition"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs text-zinc-400 font-mono">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => fetchCallHistory(page + 1)}
              disabled={page >= totalPages}
              className="p-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-400 transition"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* CDR Table */}
        <div className="overflow-x-auto border border-zinc-800 rounded-xl">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-zinc-850 border-b border-zinc-800 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Caller ID</th>
                <th className="py-3 px-4">Agent Name</th>
                <th className="py-3 px-4">Direction</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Duration</th>
                <th className="py-3 px-4 max-w-[200px]">Call Recording Playback</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300 text-xs">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-zinc-500">
                    No historical logs matching database files.
                  </td>
                </tr>
              ) : (
                history.map((log) => (
                  <tr key={log._id} className="hover:bg-zinc-850/40 transition">
                    <td className="py-3.5 px-4 font-mono text-zinc-400">
                      {new Date(log.startTime).toLocaleString()}
                    </td>
                    <td className="py-3.5 px-4 font-mono font-medium text-zinc-200">
                      {log.callerId}
                    </td>
                    <td className="py-3.5 px-4">
                      {log.agentId ? (
                        <div>
                          <p className="font-semibold text-zinc-200">{log.agentId.name}</p>
                          <p className="text-[10px] text-zinc-500 font-mono">{log.agentId.userId}</p>
                        </div>
                      ) : (
                        <span className="text-zinc-500 italic">Queue Drop</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`px-2 py-0.5 rounded font-medium ${
                        log.direction === 'Inbound' 
                          ? 'bg-blue-500/10 text-blue-400' 
                          : 'bg-indigo-500/10 text-indigo-400'
                      }`}>
                        {log.direction}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`px-2 py-0.5 rounded font-medium ${
                        log.status === 'Answered' ? 'bg-emerald-500/10 text-emerald-400' :
                        log.status === 'Missed' ? 'bg-amber-500/10 text-amber-400' :
                        log.status === 'Busy' ? 'bg-zinc-800 text-zinc-400' :
                        'bg-red-500/10 text-red-400'
                      }`}>
                        {log.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-zinc-300">
                      {formatDuration(log.durationInSeconds)}
                    </td>
                    <td className="py-3.5 px-4 max-w-[220px]">
                      {log.recordingUrl ? (
                        <div className="flex items-center gap-2">
                          <audio 
                            controls 
                            preload="none"
                            src={log.recordingUrl} 
                            className="w-full max-w-[200px] h-7 outline-none accent-emerald-500"
                          />
                        </div>
                      ) : (
                        <span className="text-zinc-650 italic text-[11px]">Unrecorded Call</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
