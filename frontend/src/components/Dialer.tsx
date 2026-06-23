'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Play, Pause, RefreshCw, Send, ArrowRightLeft, User, ShieldAlert } from 'lucide-react';
import { SipClient, SipClientState } from '../lib/sip-client';

interface DialerProps {
  userId: string;
  userName: string;
  wsSocket: WebSocket | null;
}

export default function Dialer({ userId, userName, wsSocket }: DialerProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [sipState, setSipState] = useState<SipClientState>('Offline');
  const [presence, setPresence] = useState('Offline');
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [showTransferPanel, setShowTransferPanel] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // WebRTC Peer-to-Peer local signaling state
  const [incomingCall, setIncomingCall] = useState<{ senderUserId: string, senderName: string, signal: any } | null>(null);
  const [isWebrtcMode, setIsWebrtcMode] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const sipClientRef = useRef<SipClient | null>(null);

  // Sync state values to refs to prevent stale closure bugs in SIP callbacks
  const sipStateRef = useRef(sipState);
  const callDurationRef = useRef(callDuration);
  const phoneNumberRef = useRef(phoneNumber);

  useEffect(() => { sipStateRef.current = sipState; }, [sipState]);
  useEffect(() => { callDurationRef.current = callDuration; }, [callDuration]);
  useEffect(() => { phoneNumberRef.current = phoneNumber; }, [phoneNumber]);

  // Initialize SIP.js Client Engine
  useEffect(() => {
    const wsUri = process.env.NEXT_PUBLIC_SIP_WS_URI || 'wss://telephony.company.com/ws';
    const domain = process.env.NEXT_PUBLIC_SIP_DOMAIN || 'telephony.company.com';

    const client = new SipClient({
      wsUri,
      username: userId,
      domain,
      displayName: userName,
      password: 'SecureAgentPassword123'
    });

    client.onStateChange((state, msg) => {
      // Ignore if we are in active WebRTC peer-to-peer mode
      if (pcRef.current) return;

      setSipState(state);
      if (msg) setErrorMsg(msg);
      else setErrorMsg('');

      // Auto update presence to On-Call if connected/ringing
      if (state === 'Connected' || state === 'Ringing') {
        updateAgentPresence('On-Call');
      } else if (state === 'OnHold') {
        // remains on-call
      } else if (state === 'Registered') {
        // If finished a call, transition to Wrap-Up state
        if (sipStateRef.current === 'Connected' || sipStateRef.current === 'OnHold') {
          updateAgentPresence('Wrap-Up');
        }
      }
    });

    client.onCallDuration((seconds) => {
      if (pcRef.current) return; // ignore WebRTC duration timer
      setCallDuration(seconds);
    });

    sipClientRef.current = client;

    // Start registration
    client.connect();

    return () => {
      if (sipClientRef.current) {
        sipClientRef.current.disconnect();
      }
    };
  }, [userId, userName]);

  // Listen for incoming WebRTC signaling messages
  useEffect(() => {
    if (!wsSocket) return;

    const handleWebRTCSignal = async (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'webrtc_signal') {
          const { senderUserId, senderName, signal } = message;

          if (signal.type === 'offer') {
            console.log('[WebRTC Dialer] Received offer from:', senderUserId);
            setIncomingCall({ senderUserId, senderName, signal });
          } else if (signal.type === 'answer') {
            console.log('[WebRTC Dialer] Received answer from:', senderUserId);
            if (pcRef.current) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
              setSipState('Connected');
            }
          } else if (signal.candidate) {
            console.log('[WebRTC Dialer] Received ICE candidate.');
            if (pcRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
          } else if (signal.type === 'decline' || signal.type === 'hangup') {
            console.log('[WebRTC Dialer] Call terminated by remote peer.');
            cleanupWebRTCCall();
          }
        }
      } catch (err) {
        console.error('[WebRTC] Signal parsing error:', err);
      }
    };

    wsSocket.addEventListener('message', handleWebRTCSignal);
    return () => {
      wsSocket.removeEventListener('message', handleWebRTCSignal);
    };
  }, [wsSocket]);

  // Update presence status to MongoDB and Redis
  const updateAgentPresence = (newStatus: string) => {
    setPresence(newStatus);
    if (wsSocket && wsSocket.readyState === WebSocket.OPEN) {
      wsSocket.send(JSON.stringify({
        type: 'status_change',
        status: newStatus
      }));
    }
  };

  // Sync active Call State updates through WebSockets to managers
  useEffect(() => {
    if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) return;

    let callState = 'Idle';
    if (sipState === 'Ringing') callState = 'Ringing';
    else if (sipState === 'Connected') callState = 'Connected';
    else if (sipState === 'OnHold') callState = 'Held';
    else if (sipState === 'Registered' && callDurationRef.current > 0) callState = 'Completed';

    if (callState !== 'Idle') {
      wsSocket.send(JSON.stringify({
        type: 'call_event',
        callState,
        callId: `SIP-UUID-${userId.toUpperCase()}-${Date.now()}`,
        callerId: phoneNumberRef.current || 'Inbound Queue',
        direction: 'Outbound'
      }));
    }

    // Save final call duration to database when hanging up
    if (callState === 'Completed' && callDurationRef.current > 0) {
      logCallToDatabase(phoneNumberRef.current, 'Outbound', 'Answered', callDurationRef.current);
    }
  }, [sipState]);

  const logCallToDatabase = async (caller: string, direction: string, status: string, duration: number) => {
    try {
      const apiBaseUrl = process.env.NEXT_PUBLIC_BACKEND_API_URL || 'http://127.0.0.1:5000';
      await fetch(`${apiBaseUrl}/api/calls/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callerId: caller || '+1 (555) 000-0000',
          agentUserId: userId,
          direction,
          status,
          durationInSeconds: duration,
          recordingUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
        })
      });
      console.log('[Dialer] Outbound call details synced to DB.');
    } catch (e) {
      console.error('[Dialer] Call log logging failed:', e);
    }
  };

  // Dialpad events
  const handleKeypress = (char: string) => {
    setPhoneNumber(prev => prev + char);
  };

  const handleClear = () => {
    setPhoneNumber('');
  };

  const handleBackspace = () => {
    setPhoneNumber(prev => prev.slice(0, -1));
  };

  // Starts peer-to-peer WebRTC voice signaling
  const startWebRTCPeerCall = async (targetUserId: string) => {
    setErrorMsg('');
    setIsWebrtcMode(true);
    setSipState('Ringing');
    updateAgentPresence('On-Call');

    try {
      // Capture microphone audio stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Create PeerConnection with public Google STUN servers for NAT traversal
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pcRef.current = pc;
      setPeerConnection(pc);

      // Add local stream tracks
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Hook remote streams to target element
      pc.ontrack = (event) => {
        console.log('[WebRTC Dialer] Received remote track:', event.streams[0]);
        if (remoteAudioRef.current && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
        }
      };

      // Relay local ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && wsSocket && wsSocket.readyState === WebSocket.OPEN) {
          wsSocket.send(JSON.stringify({
            type: 'webrtc_signal',
            targetUserId,
            signal: { candidate: event.candidate }
          }));
        }
      };

      // Create SDP Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer to target agent via websocket proxy
      if (wsSocket && wsSocket.readyState === WebSocket.OPEN) {
        wsSocket.send(JSON.stringify({
          type: 'webrtc_signal',
          targetUserId,
          signal: offer
        }));
      }

      // Start local duration timer
      let elapsed = 0;
      setCallDuration(0);
      const interval = setInterval(() => {
        elapsed++;
        setCallDuration(elapsed);
      }, 1000);
      (pc as any).durationInterval = interval;

    } catch (err: any) {
      console.error('[WebRTC] Failed to launch call:', err);
      setErrorMsg(`WebRTC Capture failed: ${err.message}`);
      cleanupWebRTCCall();
    }
  };

  const acceptIncomingCall = async () => {
    if (!incomingCall) return;
    const { senderUserId, signal } = incomingCall;
    
    // Bind dialed output parameter to remote caller ID for hangup triggers
    setPhoneNumber(senderUserId);
    phoneNumberRef.current = senderUserId;
    
    setIncomingCall(null);
    setIsWebrtcMode(true);
    setSipState('Connected');
    updateAgentPresence('On-Call');

    try {
      // Capture microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Create PeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pcRef.current = pc;
      setPeerConnection(pc);

      // Add tracks
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Hook remote streams to audio element
      pc.ontrack = (event) => {
        console.log('[WebRTC Dialer] Received remote track:', event.streams[0]);
        if (remoteAudioRef.current && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
        }
      };

      // Relay local ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && wsSocket && wsSocket.readyState === WebSocket.OPEN) {
          wsSocket.send(JSON.stringify({
            type: 'webrtc_signal',
            targetUserId: senderUserId,
            signal: { candidate: event.candidate }
          }));
        }
      };

      // Set remote offer
      await pc.setRemoteDescription(new RTCSessionDescription(signal));

      // Create Answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Send answer back to sender
      if (wsSocket && wsSocket.readyState === WebSocket.OPEN) {
        wsSocket.send(JSON.stringify({
          type: 'webrtc_signal',
          targetUserId: senderUserId,
          signal: answer
        }));
      }

      // Start call duration count
      let elapsed = 0;
      setCallDuration(0);
      const interval = setInterval(() => {
        elapsed++;
        setCallDuration(elapsed);
      }, 1000);
      (pc as any).durationInterval = interval;

    } catch (err: any) {
      console.error('[WebRTC] Failed to accept call:', err);
      setErrorMsg(`WebRTC Accept failed: ${err.message}`);
      declineIncomingCall();
    }
  };

  const declineIncomingCall = () => {
    if (!incomingCall) return;
    const { senderUserId } = incomingCall;
    setIncomingCall(null);

    if (wsSocket && wsSocket.readyState === WebSocket.OPEN) {
      wsSocket.send(JSON.stringify({
        type: 'webrtc_signal',
        targetUserId: senderUserId,
        signal: { type: 'decline' }
      }));
    }
  };

  const cleanupWebRTCCall = () => {
    // Stop local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);

    // Stop duration timer
    if (pcRef.current && (pcRef.current as any).durationInterval) {
      clearInterval((pcRef.current as any).durationInterval);
    }

    // Close peer connection
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setPeerConnection(null);

    // Revert state
    setIsWebrtcMode(false);
    setSipState('Registered');
    updateAgentPresence('Wrap-Up');

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  const startCall = async () => {
    if (!phoneNumber) return;

    // Check if the dialed target is one of our active agent IDs (e.g. agent_alice, agent_bob)
    if (phoneNumber.startsWith('agent_')) {
      startWebRTCPeerCall(phoneNumber);
      return;
    }

    if (sipClientRef.current) {
      try {
        await sipClientRef.current.call(phoneNumber);
      } catch (err: any) {
        setErrorMsg(err.message);
      }
    }
  };

  const endCall = async () => {
    if (isWebrtcMode) {
      // Notify other agent
      const targetUserId = phoneNumberRef.current;
      if (wsSocket && wsSocket.readyState === WebSocket.OPEN && targetUserId) {
        wsSocket.send(JSON.stringify({
          type: 'webrtc_signal',
          targetUserId,
          signal: { type: 'hangup' }
        }));
      }
      cleanupWebRTCCall();
      return;
    }

    if (sipClientRef.current) {
      await sipClientRef.current.hangup();
      setCallDuration(0);
      setIsMuted(false);
      setShowTransferPanel(false);
    }
  };

  const toggleMute = () => {
    if (isWebrtcMode && localStreamRef.current) {
      const nextMuted = !isMuted;
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
      setIsMuted(nextMuted);
      return;
    }

    if (sipClientRef.current) {
      const nextMuted = !isMuted;
      sipClientRef.current.mute(nextMuted);
      setIsMuted(nextMuted);
    }
  };

  const toggleHold = async () => {
    if (isWebrtcMode) {
      // P2P hold behaves similarly to mock local holds
      if (sipState === 'Connected') {
        setSipState('OnHold');
      } else if (sipState === 'OnHold') {
        setSipState('Connected');
      }
      return;
    }

    if (sipClientRef.current) {
      if (sipState === 'Connected') {
        await sipClientRef.current.hold(true);
      } else if (sipState === 'OnHold') {
        await sipClientRef.current.hold(false);
      }
    }
  };

  const triggerTransfer = async (isWarm: boolean) => {
    if (!transferTarget) return;

    if (isWebrtcMode) {
      setErrorMsg('Call transfer not supported in Peer-to-Peer sandbox calling.');
      return;
    }

    if (sipClientRef.current) {
      try {
        await sipClientRef.current.transfer(transferTarget, isWarm);
        setShowTransferPanel(false);
        setTransferTarget('');
      } catch (err: any) {
        setErrorMsg(`Transfer failed: ${err.message}`);
      }
    }
  };

  const formatTimer = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  // Color mappings for sip and presence status
  const getSipBadgeColor = () => {
    switch (sipState) {
      case 'Registered': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'Registering': return 'bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse';
      case 'Connected': return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
      case 'Ringing': return 'bg-pink-500/10 text-pink-400 border-pink-500/20 animate-bounce';
      case 'OnHold': return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      default: return 'bg-zinc-800 text-zinc-400 border-zinc-700';
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start max-w-6xl mx-auto">
      
      {/* LEFT COMPONENT: Softphone control panel */}
      <div className="lg:col-span-7 bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-6">
        
        {/* Softphone status banner */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-zinc-800/80 rounded-xl text-zinc-300">
              <User size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-100">{userName}</h2>
              <p className="text-xs text-zinc-500">ID: {userId} • Agent Portal</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${getSipBadgeColor()}`}>
              SIP: {isWebrtcMode ? 'P2P Mode' : sipState}
            </span>
          </div>
        </div>

        {/* Incoming Call Banner */}
        {incomingCall && (
          <div className="bg-gradient-to-r from-purple-950/40 to-indigo-950/40 border border-indigo-500/20 p-4 rounded-xl space-y-3 animate-slideDown">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-indigo-400 font-bold uppercase tracking-wider">Incoming WebRTC Call</p>
                <p className="text-sm font-semibold text-zinc-200">{incomingCall.senderName} ({incomingCall.senderUserId})</p>
              </div>
              <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-full animate-bounce">
                <Phone size={16} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={declineIncomingCall}
                className="bg-zinc-850 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-xs font-semibold py-2 rounded-lg transition"
              >
                Decline
              </button>
              <button
                onClick={acceptIncomingCall}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 rounded-lg transition"
              >
                Accept
              </button>
            </div>
          </div>
        )}

        {/* Presence Switcher Dropdown */}
        <div className="bg-zinc-850 p-4 rounded-xl border border-zinc-800 flex items-center justify-between">
          <div className="space-y-0.5">
            <label className="text-xs text-zinc-400 font-medium">Agent Status Queue</label>
            <p className="text-sm font-semibold text-zinc-200">Current: {presence}</p>
          </div>
          <select
            value={presence}
            onChange={(e) => updateAgentPresence(e.target.value)}
            disabled={sipState === 'Offline' && !isWebrtcMode}
            className="bg-zinc-850 text-zinc-200 border border-zinc-750 text-sm font-medium rounded-lg px-3 py-2 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none cursor-pointer"
          >
            <option value="Available">Available</option>
            <option value="Break">Break</option>
            <option value="Wrap-Up">Wrap-Up</option>
            <option value="Offline">Offline</option>
          </select>
        </div>

        {/* SIP/WebRTC Error Warning */}
        {errorMsg && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2.5 text-xs text-red-400">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Outbound String Dialer Output Area */}
        <div className="relative">
          <input
            type="text"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="Enter extension or agent ID..."
            disabled={sipState === 'Connected' || sipState === 'Ringing' || sipState === 'OnHold'}
            className="w-full bg-zinc-950 border border-zinc-850 text-zinc-100 text-xl font-mono tracking-wider rounded-xl py-4 pl-4 pr-12 text-center outline-none focus:border-zinc-700 transition"
          />
          {phoneNumber && (sipState === 'Registered') && (
            <button
              onClick={handleClear}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-zinc-500 hover:text-zinc-300 transition"
            >
              Clear
            </button>
          )}
        </div>

        {/* Grid Dialer Keyboard */}
        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((char) => (
            <button
              key={char}
              type="button"
              disabled={sipState === 'Connected' || sipState === 'Ringing' || sipState === 'OnHold'}
              onClick={() => handleKeypress(char)}
              className="bg-zinc-850 hover:bg-zinc-800 disabled:opacity-50 active:scale-95 text-zinc-200 text-lg font-mono font-bold py-3.5 rounded-xl border border-zinc-800/80 hover:border-zinc-700 shadow-sm transition-all duration-100"
            >
              {char}
            </button>
          ))}
        </div>

        {/* Dialer call actions */}
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={startCall}
            disabled={!phoneNumber || (sipState !== 'Registered')}
            className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white font-semibold py-4 rounded-xl shadow-lg shadow-emerald-950/20 transition-all active:scale-[0.98]"
          >
            <Phone size={18} />
            <span>Call</span>
          </button>
          
          <button
            onClick={endCall}
            disabled={sipState !== 'Connected' && sipState !== 'Ringing' && sipState !== 'OnHold'}
            className="flex items-center justify-center gap-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:hover:bg-rose-600 text-white font-semibold py-4 rounded-xl shadow-lg shadow-rose-950/20 transition-all active:scale-[0.98]"
          >
            <PhoneOff size={18} />
            <span>End Call</span>
          </button>
        </div>

      </div>

      {/* RIGHT COMPONENT: Media audio tools / Status parameters */}
      <div className="lg:col-span-5 space-y-6">
        
        {/* Dynamic active call telemetry dashboard */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl flex flex-col items-center justify-center min-h-[220px]">
          {sipState === 'Connected' || sipState === 'Ringing' || sipState === 'OnHold' ? (
            <div className="w-full text-center space-y-4 animate-fadeIn">
              <div className="inline-flex items-center justify-center p-4 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-500/20 mb-1 animate-pulse">
                <Phone size={24} />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold">Active Call Connection</p>
                <p className="text-xl font-mono text-zinc-200 font-semibold">{phoneNumber}</p>
              </div>
              <div className="text-3xl font-mono font-bold text-emerald-400 tracking-wider">
                {formatTimer(callDuration)}
              </div>

              {/* Audio Controls */}
              <div className="flex justify-center gap-3 pt-2">
                <button
                  onClick={toggleMute}
                  className={`p-3 rounded-xl border transition-all ${
                    isMuted 
                      ? 'bg-rose-600/20 border-rose-500/30 text-rose-400' 
                      : 'bg-zinc-850 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                  }`}
                  title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
                >
                  {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>

                <button
                  onClick={toggleHold}
                  className={`p-3 rounded-xl border transition-all ${
                    sipState === 'OnHold' 
                      ? 'bg-blue-600/20 border-blue-500/30 text-blue-400' 
                      : 'bg-zinc-850 border-zinc-800 text-zinc-300 hover:border-zinc-700'
                  }`}
                  title={sipState === 'OnHold' ? 'Resume Call' : 'Hold Call'}
                >
                  {sipState === 'OnHold' ? <Play size={18} /> : <Pause size={18} />}
                </button>

                <button
                  onClick={() => setShowTransferPanel(!showTransferPanel)}
                  disabled={isWebrtcMode}
                  className={`p-3 rounded-xl border transition-all ${
                    showTransferPanel 
                      ? 'bg-purple-600/20 border-purple-500/30 text-purple-400' 
                      : 'bg-zinc-850 border-zinc-800 text-zinc-300 hover:border-zinc-700 disabled:opacity-30'
                  }`}
                  title="Transfer Call"
                >
                  <ArrowRightLeft size={18} />
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center space-y-3 p-4">
              <div className="inline-flex items-center justify-center p-3 bg-zinc-850 text-zinc-500 rounded-full border border-zinc-800 mb-1">
                <PhoneOff size={22} />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-300">Ready for Telephony Actions</p>
                <p className="text-xs text-zinc-500 max-w-xs mx-auto mt-1">
                  Connect status dropdown, dial a number, or enter another agent's ID to call them directly.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Transfer Call Action Card */}
        {showTransferPanel && (sipState === 'Connected' || sipState === 'OnHold') && !isWebrtcMode && (
          <div className="bg-zinc-900 border border-purple-950/40 rounded-2xl p-6 shadow-2xl space-y-4 animate-slideDown">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">Call Transfer Module</h3>
              <p className="text-xs text-zinc-500">Route active connection to another extension</p>
            </div>
            
            <input
              type="text"
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              placeholder="Target Extension (e.g. 5002)..."
              className="w-full bg-zinc-950 border border-zinc-850 text-zinc-100 text-sm rounded-lg p-2.5 outline-none focus:border-purple-900 transition"
            />

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => triggerTransfer(false)}
                disabled={!transferTarget}
                className="flex items-center justify-center gap-1.5 bg-zinc-850 hover:bg-zinc-800 disabled:opacity-40 text-zinc-200 text-xs font-semibold py-2.5 rounded-lg border border-zinc-850 transition"
              >
                <Send size={12} />
                <span>Cold (Blind)</span>
              </button>

              <button
                onClick={() => triggerTransfer(true)}
                disabled={!transferTarget}
                className="flex items-center justify-center gap-1.5 bg-purple-900 hover:bg-purple-800 disabled:opacity-40 text-white text-xs font-semibold py-2.5 rounded-lg transition"
              >
                <RefreshCw size={12} />
                <span>Warm (Attended)</span>
              </button>
            </div>
          </div>
        )}

      </div>

      <audio ref={remoteAudioRef} autoPlay className="hidden" />

    </div>
  );
}
