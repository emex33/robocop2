import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Phone, PhoneOff, PhoneIncoming, Mic, MicOff,
  Power, PowerOff, LogOut, Headphones, Activity, User,
  Volume2, VolumeX, Pause, Play, Hash, Delete, Clock
} from 'lucide-react';

const BASE = '/api';

function agentRequest(path, options = {}) {
  const token = localStorage.getItem('robocop_agent_token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { ...options, headers }).then(async res => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

const DIALPAD = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

export default function AgentSoftphone() {
  const navigate = useNavigate();
  const [agent, setAgent] = useState(null);
  const [sipAgent, setSipAgent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [goingOnline, setGoingOnline] = useState(false);
  const [goingOffline, setGoingOffline] = useState(false);

  const [callState, setCallState] = useState('idle'); // idle, dialing, ringing, active
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCallId, setActiveCallId] = useState(null);
  const [dialNumber, setDialNumber] = useState('');
  const [dialingNumber, setDialingNumber] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isHeld, setIsHeld] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [recentCalls, setRecentCalls] = useState([]);

  const audioContextRef = useRef(null);
  const wsRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const callTimerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const stored = localStorage.getItem('robocop_agent');
    const token = localStorage.getItem('robocop_agent_token');
    if (!stored || !token) {
      navigate('/agent-login');
      return;
    }
    const parsed = JSON.parse(stored);
    setAgent(parsed);

    if (parsed.sip_agent_id) {
      loadSipAgent(parsed.sip_agent_id);
    } else {
      setLoading(false);
    }

    const savedCalls = localStorage.getItem('robocop_recent_calls');
    if (savedCalls) setRecentCalls(JSON.parse(savedCalls));

    return () => {
      if (wsRef.current) wsRef.current.close();
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    };
  }, []);

  const loadSipAgent = async (sipAgentId) => {
    try {
      const data = await agentRequest(`/sip-agents/${sipAgentId}`);
      setSipAgent(data);
    } catch (err) {
      console.error('Failed to load SIP agent:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    if (sipAgent?.status === 'online') {
      agentRequest(`/sip-agents/${sipAgent.id}/unregister`, { method: 'POST' }).catch(() => {});
    }
    if (wsRef.current) wsRef.current.close();
    localStorage.removeItem('robocop_agent_token');
    localStorage.removeItem('robocop_agent');
    navigate('/agent-login');
  };

  const connectAudioSocket = useCallback((agentId) => {
    if (wsRef.current) wsRef.current.close();
    const token = localStorage.getItem('robocop_agent_token');
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/?token=${token}&agentId=${agentId}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playAudio(event.data);
      } else {
        try { handleCallEvent(JSON.parse(event.data)); } catch (e) {}
      }
    };
    wsRef.current = ws;
  }, []);

  const handleCallEvent = (msg) => {
    switch (msg.type) {
      case 'incoming_call':
        setIncomingCall(msg);
        setCallState('ringing');
        playRingtone();
        break;
      case 'call_answered':
      case 'call_connected':
        setCallState('active');
        if (msg.callId) setActiveCallId(msg.callId);
        startCallTimer();
        startMicrophone();
        break;
      case 'call_failed':
        setCallState('idle');
        setDialingNumber('');
        setActiveCallId(null);
        stopMicrophone();
        break;
      case 'call_ended':
      case 'call_rejected':
        setCallState('idle');
        setIncomingCall(null);
        setActiveCallId(null);
        setDialingNumber('');
        stopCallTimer();
        stopMicrophone();
        break;
      case 'registration':
        if (agent?.sip_agent_id) loadSipAgent(agent.sip_agent_id);
        break;
    }
  };

  const playAudio = (arrayBuffer) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    }
    const ctx = audioContextRef.current;
    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768;
    const audioBuffer = ctx.createBuffer(1, float32Array.length, 16000);
    audioBuffer.getChannelData(0).set(float32Array);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start();
  };

  const playRingtone = () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 440;
    gain.gain.value = 0.3;
    osc.start();
    setTimeout(() => osc.stop(), 200);
  };

  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (isMuted || !wsRef.current || wsRef.current.readyState !== 1) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        }
        wsRef.current.send(int16.buffer);
      };
      source.connect(processor);
      processor.connect(ctx.destination);
    } catch (err) {
      console.error('Failed to access microphone:', err);
    }
  };

  const stopMicrophone = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
  };

  const startCallTimer = () => {
    setCallDuration(0);
    callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
  };

  const stopCallTimer = () => {
    if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null; }
    setCallDuration(0);
  };

  const fmt = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const addRecentCall = (number, type) => {
    const entry = { number, type, time: new Date().toISOString() };
    const updated = [entry, ...recentCalls].slice(0, 20);
    setRecentCalls(updated);
    localStorage.setItem('robocop_recent_calls', JSON.stringify(updated));
  };

  const pressDigit = (digit) => {
    setDialNumber(prev => prev + digit);
    // DTMF tone
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const freqs = { '1': 697, '2': 697, '3': 697, '4': 770, '5': 770, '6': 770, '7': 852, '8': 852, '9': 852, '*': 941, '0': 941, '#': 941 };
      osc.frequency.value = freqs[digit] || 800;
      gain.gain.value = 0.08;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 80);
    } catch (e) {}
  };

  const backspace = () => setDialNumber(prev => prev.slice(0, -1));

  const handleGoOnline = async () => {
    setGoingOnline(true);
    try {
      await agentRequest(`/sip-agents/${sipAgent.id}/register`, { method: 'POST' });
      connectAudioSocket(sipAgent.id);
      await loadSipAgent(sipAgent.id);
    } catch (err) {
      alert('Failed to go online: ' + err.message);
    } finally {
      setGoingOnline(false);
    }
  };

  const handleGoOffline = async () => {
    setGoingOffline(true);
    try {
      await agentRequest(`/sip-agents/${sipAgent.id}/unregister`, { method: 'POST' });
      if (wsRef.current) wsRef.current.close();
      await loadSipAgent(sipAgent.id);
    } catch (err) {
      alert('Failed to go offline: ' + err.message);
    } finally {
      setGoingOffline(false);
    }
  };

  const handleMakeCall = async () => {
    if (!sipAgent || !dialNumber.trim() || callState !== 'idle') return;
    const number = dialNumber.trim();
    setDialingNumber(number);
    setCallState('dialing');
    addRecentCall(number, 'outgoing');
    
    // Request mic permission early so it's ready when call connects
    startMicrophone();

    try {
      const result = await agentRequest(`/sip-agents/${sipAgent.id}/call`, {
        method: 'POST',
        body: JSON.stringify({ destination: number }),
      });
      // Backend returns callId immediately (call is still ringing on remote side)
      // call_connected or call_failed will come via WebSocket
      setActiveCallId(result.callId);
    } catch (err) {
      setCallState('idle');
      setDialingNumber('');
      stopMicrophone();
      alert('Call failed: ' + err.message);
    }
  };

  const handleAnswerCall = async () => {
    if (!incomingCall) return;
    try {
      await agentRequest(`/sip-agents/calls/${incomingCall.callId}/answer`, { method: 'POST' });
      addRecentCall(incomingCall.from, 'incoming');
    } catch (err) {
      alert('Failed to answer: ' + err.message);
    }
  };

  const handleRejectCall = async () => {
    if (!incomingCall) return;
    try {
      await agentRequest(`/sip-agents/calls/${incomingCall.callId}/reject`, { method: 'POST' });
      setCallState('idle');
      setIncomingCall(null);
    } catch (err) {
      alert('Failed to reject: ' + err.message);
    }
  };

  const handleHangup = async () => {
    if (activeCallId) {
      try {
        await agentRequest(`/sip-agents/calls/${activeCallId}/hangup`, { method: 'POST' });
      } catch (err) {
        console.error('Hangup error:', err);
      }
    }
    setCallState('idle');
    setActiveCallId(null);
    setDialingNumber('');
    stopCallTimer();
    stopMicrophone();
    setIsMuted(false);
    setIsHeld(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f1221] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full" />
      </div>
    );
  }

  const isOnline = sipAgent?.status === 'online';

  return (
    <div className="min-h-screen bg-[#0f1221] flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 bg-[#161a2e] border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <Headphones className="w-4 h-4 text-white" />
          </div>
          <div className="leading-tight">
            <p className="text-white font-medium text-sm">{agent?.name || agent?.username}</p>
            <p className="text-gray-500 text-[11px]">
              {sipAgent ? `${sipAgent.sip_username}@${sipAgent.sip_server}` : 'No SIP assigned'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sipAgent && (
            <div className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full ${
              isOnline ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-500/15 text-gray-500'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}`} />
              {isOnline ? 'Online' : 'Offline'}
            </div>
          )}
          <button onClick={handleLogout} className="text-gray-500 hover:text-gray-300 p-1.5 rounded-lg hover:bg-white/5 transition">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main */}
      <div className="flex-1 flex items-center justify-center p-4">
        {!sipAgent ? (
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
              <User size={36} className="text-gray-600" />
            </div>
            <p className="text-gray-300 font-medium">No SIP Account Assigned</p>
            <p className="text-gray-600 text-sm mt-1">Contact your administrator</p>
          </div>
        ) : (
          <div className="w-full max-w-[360px]">
            {/* Phone body */}
            <div className="bg-[#1a1f35] rounded-3xl border border-white/5 shadow-2xl shadow-black/40 overflow-hidden">

              {/* Incoming call overlay */}
              {callState === 'ringing' && incomingCall && (
                <div className="p-8 text-center">
                  <div className="w-20 h-20 mx-auto mb-5 rounded-full bg-emerald-500/10 border-2 border-emerald-500/30 flex items-center justify-center animate-pulse">
                    <PhoneIncoming size={32} className="text-emerald-400" />
                  </div>
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Incoming Call</p>
                  <p className="text-white text-xl font-semibold mb-1">{incomingCall.from}</p>
                  <p className="text-gray-500 text-sm mb-8">{sipAgent.name}</p>
                  <div className="flex justify-center gap-6">
                    <button
                      onClick={handleRejectCall}
                      className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center transition-all hover:scale-105 shadow-lg shadow-red-500/30"
                    >
                      <PhoneOff size={24} className="text-white" />
                    </button>
                    <button
                      onClick={handleAnswerCall}
                      className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-400 flex items-center justify-center transition-all hover:scale-105 shadow-lg shadow-emerald-500/30 animate-bounce"
                    >
                      <Phone size={24} className="text-white" />
                    </button>
                  </div>
                </div>
              )}

              {/* Dialing */}
              {callState === 'dialing' && (
                <div className="p-8 text-center">
                  <div className="w-20 h-20 mx-auto mb-5 relative">
                    <div className="absolute inset-0 rounded-full border-2 border-indigo-500/30 animate-ping" />
                    <div className="absolute inset-2 rounded-full border-2 border-indigo-500/20 animate-ping" style={{ animationDelay: '0.3s' }} />
                    <div className="w-20 h-20 rounded-full bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center relative">
                      <Phone size={28} className="text-indigo-400" />
                    </div>
                  </div>
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Calling</p>
                  <p className="text-white text-xl font-semibold mb-1">{dialingNumber}</p>
                  <p className="text-indigo-400/60 text-sm mb-8 animate-pulse">Ringing...</p>
                  <button
                    onClick={handleHangup}
                    className="w-16 h-16 mx-auto rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center transition-all hover:scale-105 shadow-lg shadow-red-500/30"
                  >
                    <PhoneOff size={24} className="text-white" />
                  </button>
                </div>
              )}

              {/* Active call */}
              {callState === 'active' && (
                <div className="p-6 text-center">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Activity size={28} className="text-emerald-400 animate-pulse" />
                  </div>
                  <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Connected</p>
                  <p className="text-white text-lg font-semibold">{dialingNumber || dialNumber || incomingCall?.from || 'Call'}</p>
                  <p className="text-emerald-400 text-3xl font-mono font-light mt-3 mb-6">{fmt(callDuration)}</p>

                  {/* Call controls */}
                  <div className="grid grid-cols-3 gap-3 mb-6 px-4">
                    <button
                      onClick={() => setIsMuted(!isMuted)}
                      className={`flex flex-col items-center gap-1.5 py-3 rounded-xl transition ${
                        isMuted ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                      <span className="text-[10px] font-medium">{isMuted ? 'Unmute' : 'Mute'}</span>
                    </button>
                    <button
                      onClick={() => setIsHeld(!isHeld)}
                      className={`flex flex-col items-center gap-1.5 py-3 rounded-xl transition ${
                        isHeld ? 'bg-amber-500/20 text-amber-400' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {isHeld ? <Play size={20} /> : <Pause size={20} />}
                      <span className="text-[10px] font-medium">{isHeld ? 'Resume' : 'Hold'}</span>
                    </button>
                    <button className="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white transition">
                      <Volume2 size={20} />
                      <span className="text-[10px] font-medium">Speaker</span>
                    </button>
                  </div>

                  {/* Hangup */}
                  <button
                    onClick={handleHangup}
                    className="w-16 h-16 mx-auto rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center transition-all hover:scale-105 shadow-lg shadow-red-500/30"
                  >
                    <PhoneOff size={26} className="text-white rotate-[135deg]" />
                  </button>
                </div>
              )}

              {/* Idle state — dialpad */}
              {callState === 'idle' && (
                <>
                  {/* Number display */}
                  <div className="px-6 pt-5 pb-2">
                    <div className="relative">
                      <input
                        ref={inputRef}
                        type="text"
                        value={dialNumber}
                        onChange={(e) => setDialNumber(e.target.value.replace(/[^0-9+*#]/g, ''))}
                        placeholder={isOnline ? 'Enter number' : 'Go online to dial'}
                        disabled={!isOnline}
                        className="w-full text-center text-2xl font-light tracking-wider bg-transparent text-white placeholder-gray-600 outline-none py-3 disabled:opacity-40"
                        onKeyDown={(e) => e.key === 'Enter' && handleMakeCall()}
                      />
                      {dialNumber && (
                        <button
                          onClick={backspace}
                          className="absolute right-0 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-white transition"
                        >
                          <Delete size={18} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Dialpad */}
                  <div className="px-6 pb-4">
                    <div className="grid grid-cols-3 gap-2">
                      {DIALPAD.map(({ digit, letters }) => (
                        <button
                          key={digit}
                          onClick={() => isOnline && pressDigit(digit)}
                          disabled={!isOnline}
                          className="flex flex-col items-center justify-center py-3.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] active:bg-white/[0.14] active:scale-95 disabled:opacity-25 disabled:hover:bg-white/[0.04] transition-all duration-100"
                        >
                          <span className="text-white text-xl font-light">{digit}</span>
                          {letters && <span className="text-gray-500 text-[9px] tracking-[0.2em] mt-0.5">{letters}</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="px-6 pb-5">
                    {isOnline ? (
                      <div className="flex items-center justify-between">
                        {/* Recent calls */}
                        <div className="w-12" />

                        {/* Call button */}
                        <button
                          onClick={handleMakeCall}
                          disabled={!dialNumber.trim()}
                          className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-gray-700 disabled:hover:bg-gray-700 flex items-center justify-center transition-all hover:scale-105 disabled:hover:scale-100 shadow-lg shadow-emerald-500/20 disabled:shadow-none"
                        >
                          <Phone size={26} className="text-white" />
                        </button>

                        {/* Go offline */}
                        <button
                          onClick={handleGoOffline}
                          disabled={goingOffline}
                          className="w-10 h-10 rounded-full bg-red-500/15 hover:bg-red-500/25 flex items-center justify-center transition text-red-400 hover:text-red-300 disabled:opacity-50"
                          title="Go Offline"
                        >
                          {goingOffline ? (
                            <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <PowerOff size={16} />
                          )}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={handleGoOnline}
                        disabled={goingOnline}
                        className="w-full py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm flex items-center justify-center gap-2 transition disabled:opacity-60"
                      >
                        {goingOnline ? (
                          <>
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          <>
                            <Power size={16} />
                            Go Online
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* Recent calls */}
                  {recentCalls.length > 0 && isOnline && (
                    <div className="border-t border-white/5">
                      <div className="px-5 py-2.5 flex items-center justify-between">
                        <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wider">Recent</p>
                        <button
                          onClick={() => { setRecentCalls([]); localStorage.removeItem('robocop_recent_calls'); }}
                          className="text-gray-600 text-[11px] hover:text-gray-400 transition"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="max-h-[140px] overflow-y-auto">
                        {recentCalls.slice(0, 5).map((call, i) => (
                          <button
                            key={i}
                            onClick={() => setDialNumber(call.number)}
                            className="w-full px-5 py-2.5 flex items-center gap-3 hover:bg-white/[0.03] transition text-left"
                          >
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
                              call.type === 'incoming' ? 'bg-blue-500/10 text-blue-400' : 'bg-emerald-500/10 text-emerald-400'
                            }`}>
                              {call.type === 'incoming' ? <PhoneIncoming size={12} /> : <Phone size={12} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-gray-300 text-sm truncate">{call.number}</p>
                              <p className="text-gray-600 text-[10px]">
                                {new Date(call.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Status bar under phone */}
            <div className="mt-3 text-center">
              <p className="text-gray-600 text-[10px]">
                {sipAgent.name} &middot; {isOnline ? 'Registered' : 'Not registered'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
