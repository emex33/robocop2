import { useState, useEffect, useRef, useCallback } from 'react';
import { api, getToken } from '../lib/api';
import { 
  Phone, PhoneOff, PhoneIncoming, PhoneOutgoing, Mic, MicOff, 
  Plus, Trash2, Power, PowerOff, Edit2, X, Check, Volume2, VolumeX,
  User, Settings, Clock, Activity
} from 'lucide-react';

export default function Softphone() {
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  
  // Call state
  const [callState, setCallState] = useState('idle'); // idle, ringing, active
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCallId, setActiveCallId] = useState(null);
  const [dialNumber, setDialNumber] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  
  // Audio
  const audioContextRef = useRef(null);
  const wsRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const callTimerRef = useRef(null);

  useEffect(() => {
    loadAgents();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    };
  }, []);

  const loadAgents = async () => {
    try {
      const data = await api.getSipAgents();
      setAgents(data);
      if (data.length > 0 && !selectedAgent) {
        setSelectedAgent(data[0]);
      }
    } catch (err) {
      console.error('Failed to load SIP agents:', err);
    } finally {
      setLoading(false);
    }
  };

  // Connect WebSocket for audio when agent goes online
  const connectAudioSocket = useCallback((agentId) => {
    if (wsRef.current) wsRef.current.close();

    const token = getToken();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/?token=${token}&agentId=${agentId}`);
    
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('Softphone WebSocket connected');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Audio data from remote party - play it
        playAudio(event.data);
      } else {
        // JSON message (call events)
        try {
          const msg = JSON.parse(event.data);
          handleCallEvent(msg);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      }
    };

    ws.onclose = () => {
      console.log('Softphone WebSocket disconnected');
    };

    wsRef.current = ws;
  }, []);

  const handleCallEvent = (msg) => {
    console.log('Call event:', msg);
    
    switch (msg.type) {
      case 'incoming_call':
        setIncomingCall(msg);
        setCallState('ringing');
        playRingtone();
        break;
      case 'call_answered':
      case 'call_connected':
        setCallState('active');
        setActiveCallId(msg.callId);
        startCallTimer();
        startMicrophone();
        break;
      case 'call_ended':
      case 'call_rejected':
        setCallState('idle');
        setIncomingCall(null);
        setActiveCallId(null);
        stopCallTimer();
        stopMicrophone();
        break;
      case 'registration':
        loadAgents(); // Refresh to get updated status
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
    
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }
    
    const audioBuffer = ctx.createBuffer(1, float32Array.length, 16000);
    audioBuffer.getChannelData(0).set(float32Array);
    
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start();
  };

  const playRingtone = () => {
    // Simple beep for now - could use actual ringtone file
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
    callTimerRef.current = setInterval(() => {
      setCallDuration(d => d + 1);
    }, 1000);
  };

  const stopCallTimer = () => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    setCallDuration(0);
  };

  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Agent actions
  const handleGoOnline = async (agent) => {
    try {
      await api.registerSipAgent(agent.id);
      connectAudioSocket(agent.id);
      loadAgents();
    } catch (err) {
      alert('Failed to go online: ' + err.message);
    }
  };

  const handleGoOffline = async (agent) => {
    try {
      await api.unregisterSipAgent(agent.id);
      if (wsRef.current) wsRef.current.close();
      loadAgents();
    } catch (err) {
      alert('Failed to go offline: ' + err.message);
    }
  };

  const handleMakeCall = async () => {
    if (!selectedAgent || !dialNumber.trim()) return;
    try {
      const result = await api.sipAgentCall(selectedAgent.id, dialNumber.trim());
      setActiveCallId(result.callId);
      setCallState('active');
      startCallTimer();
      startMicrophone();
      setDialNumber('');
    } catch (err) {
      alert('Failed to make call: ' + err.message);
    }
  };

  const handleAnswerCall = async () => {
    if (!incomingCall) return;
    try {
      await api.sipAgentAnswerCall(incomingCall.callId);
    } catch (err) {
      alert('Failed to answer: ' + err.message);
    }
  };

  const handleRejectCall = async () => {
    if (!incomingCall) return;
    try {
      await api.sipAgentRejectCall(incomingCall.callId);
      setCallState('idle');
      setIncomingCall(null);
    } catch (err) {
      alert('Failed to reject: ' + err.message);
    }
  };

  const handleHangup = async () => {
    if (!activeCallId) return;
    try {
      await api.sipAgentHangupCall(activeCallId);
      setCallState('idle');
      setActiveCallId(null);
      stopCallTimer();
      stopMicrophone();
    } catch (err) {
      alert('Failed to hangup: ' + err.message);
    }
  };

  const handleDeleteAgent = async (agent) => {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await api.deleteSipAgent(agent.id);
      loadAgents();
      if (selectedAgent?.id === agent.id) setSelectedAgent(null);
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Softphone</h1>
          <p className="text-gray-500 text-sm">Manage SIP accounts and make/receive calls</p>
        </div>
        <button
          onClick={() => { setEditingAgent(null); setShowModal(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          <Plus size={18} /> Add SIP Account
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent List */}
        <div className="lg:col-span-1 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">SIP Accounts</h2>
          </div>
          <div className="divide-y divide-gray-100 max-h-[500px] overflow-y-auto">
            {agents.length === 0 ? (
              <div className="p-8 text-center text-gray-400">
                <User size={40} className="mx-auto mb-2 opacity-50" />
                <p>No SIP accounts yet</p>
                <p className="text-xs mt-1">Add one to get started</p>
              </div>
            ) : agents.map(agent => (
              <div
                key={agent.id}
                onClick={() => setSelectedAgent(agent)}
                className={`p-4 cursor-pointer hover:bg-gray-50 transition ${
                  selectedAgent?.id === agent.id ? 'bg-indigo-50 border-l-4 border-indigo-600' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900">{agent.name}</div>
                    <div className="text-xs text-gray-500">{agent.sip_username}@{agent.sip_server}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${
                      agent.status === 'online' ? 'bg-green-500' : 'bg-gray-300'
                    }`} />
                    <span className="text-xs text-gray-500">{agent.status}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Softphone Panel */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          {!selectedAgent ? (
            <div className="p-12 text-center text-gray-400">
              <Phone size={48} className="mx-auto mb-3 opacity-50" />
              <p>Select a SIP account to use the softphone</p>
            </div>
          ) : (
            <div>
              {/* Agent Info Header */}
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-gray-900">{selectedAgent.name}</h2>
                  <p className="text-sm text-gray-500">{selectedAgent.sip_username}@{selectedAgent.sip_server}</p>
                </div>
                <div className="flex items-center gap-2">
                  {selectedAgent.status === 'online' ? (
                    <button
                      onClick={() => handleGoOffline(selectedAgent)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
                    >
                      <PowerOff size={14} /> Go Offline
                    </button>
                  ) : (
                    <button
                      onClick={() => handleGoOnline(selectedAgent)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded-lg hover:bg-green-200"
                    >
                      <Power size={14} /> Go Online
                    </button>
                  )}
                  <button
                    onClick={() => { setEditingAgent(selectedAgent); setShowModal(true); }}
                    className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    onClick={() => handleDeleteAgent(selectedAgent)}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* Call Area */}
              <div className="p-6">
                {callState === 'ringing' && incomingCall && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6 mb-6 text-center animate-pulse">
                    <PhoneIncoming size={48} className="mx-auto text-yellow-600 mb-3" />
                    <p className="font-semibold text-yellow-800">Incoming Call</p>
                    <p className="text-yellow-600 mb-4">{incomingCall.from}</p>
                    <div className="flex justify-center gap-4">
                      <button
                        onClick={handleAnswerCall}
                        className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-full hover:bg-green-700"
                      >
                        <Phone size={18} /> Answer
                      </button>
                      <button
                        onClick={handleRejectCall}
                        className="flex items-center gap-2 px-6 py-2 bg-red-600 text-white rounded-full hover:bg-red-700"
                      >
                        <PhoneOff size={18} /> Reject
                      </button>
                    </div>
                  </div>
                )}

                {callState === 'active' && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-6 mb-6 text-center">
                    <Activity size={48} className="mx-auto text-green-600 mb-3 animate-pulse" />
                    <p className="font-semibold text-green-800">Call Active</p>
                    <p className="text-3xl font-mono text-green-700 my-3">{formatDuration(callDuration)}</p>
                    <div className="flex justify-center gap-4">
                      <button
                        onClick={() => setIsMuted(!isMuted)}
                        className={`p-3 rounded-full ${isMuted ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'} hover:opacity-80`}
                      >
                        {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                      </button>
                      <button
                        onClick={handleHangup}
                        className="flex items-center gap-2 px-6 py-2 bg-red-600 text-white rounded-full hover:bg-red-700"
                      >
                        <PhoneOff size={18} /> Hangup
                      </button>
                    </div>
                  </div>
                )}

                {callState === 'idle' && selectedAgent.status === 'online' && (
                  <div className="text-center">
                    <div className="mb-6">
                      <input
                        type="text"
                        value={dialNumber}
                        onChange={(e) => setDialNumber(e.target.value)}
                        placeholder="Enter number to dial..."
                        className="w-full max-w-xs px-4 py-3 text-center text-xl border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        onKeyPress={(e) => e.key === 'Enter' && handleMakeCall()}
                      />
                    </div>
                    <button
                      onClick={handleMakeCall}
                      disabled={!dialNumber.trim()}
                      className="flex items-center gap-2 px-8 py-3 mx-auto bg-green-600 text-white rounded-full hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <PhoneOutgoing size={20} /> Call
                    </button>
                  </div>
                )}

                {callState === 'idle' && selectedAgent.status !== 'online' && (
                  <div className="text-center text-gray-400 py-8">
                    <PowerOff size={48} className="mx-auto mb-3 opacity-50" />
                    <p>Go online to make or receive calls</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <AgentModal
          agent={editingAgent}
          onClose={() => { setShowModal(false); setEditingAgent(null); }}
          onSaved={() => { setShowModal(false); setEditingAgent(null); loadAgents(); }}
        />
      )}
    </div>
  );
}

function AgentModal({ agent, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: agent?.name || '',
    sip_server: agent?.sip_server || '',
    sip_port: agent?.sip_port || 5060,
    sip_transport: agent?.sip_transport || 'udp',
    sip_username: agent?.sip_username || '',
    sip_password: '',
    sip_domain: agent?.sip_domain || '',
    caller_id: agent?.caller_id || '',
    can_receive_transfers: agent?.can_receive_transfers ?? 1,
    priority: agent?.priority || 1,
    max_concurrent_calls: agent?.max_concurrent_calls || 1,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setError('');
    if (!form.name || !form.sip_server || !form.sip_username) {
      setError('Name, SIP server, and username are required');
      return;
    }
    if (!agent && !form.sip_password) {
      setError('Password is required for new accounts');
      return;
    }

    setSaving(true);
    try {
      const data = { ...form };
      if (!data.sip_password) delete data.sip_password; // Don't send empty password on edit

      if (agent) {
        await api.updateSipAgent(agent.id, data);
      } else {
        await api.createSipAgent(data);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">{agent ? 'Edit SIP Account' : 'Add SIP Account'}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. John Agent"
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">SIP Server *</label>
              <input
                type="text"
                value={form.sip_server}
                onChange={e => setForm({ ...form, sip_server: e.target.value })}
                placeholder="sip.provider.com"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <input
                type="number"
                value={form.sip_port}
                onChange={e => setForm({ ...form, sip_port: parseInt(e.target.value) || 5060 })}
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Transport</label>
            <select
              value={form.sip_transport}
              onChange={e => setForm({ ...form, sip_transport: e.target.value })}
              className={inputCls}
            >
              <option value="udp">UDP</option>
              <option value="tcp">TCP</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SIP Username *</label>
            <input
              type="text"
              value={form.sip_username}
              onChange={e => setForm({ ...form, sip_username: e.target.value })}
              placeholder="username or extension"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              SIP Password {agent ? '(leave empty to keep current)' : '*'}
            </label>
            <input
              type="password"
              value={form.sip_password}
              onChange={e => setForm({ ...form, sip_password: e.target.value })}
              placeholder="••••••••"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">SIP Domain (optional)</label>
            <input
              type="text"
              value={form.sip_domain}
              onChange={e => setForm({ ...form, sip_domain: e.target.value })}
              placeholder="Optional domain/realm"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Caller ID (optional)</label>
            <input
              type="text"
              value={form.caller_id}
              onChange={e => setForm({ ...form, caller_id: e.target.value })}
              placeholder="Display number for outbound calls"
              className={inputCls}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="canReceive"
              checked={form.can_receive_transfers === 1}
              onChange={e => setForm({ ...form, can_receive_transfers: e.target.checked ? 1 : 0 })}
              className="rounded"
            />
            <label htmlFor="canReceive" className="text-sm text-gray-700">Can receive AI transfers</label>
          </div>
        </div>

        <div className="p-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : agent ? 'Save Changes' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
}
