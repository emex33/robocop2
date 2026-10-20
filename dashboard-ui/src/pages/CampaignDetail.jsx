import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  ArrowLeft, Play, Pause, Users, Phone, Settings, BarChart3, Info,
  Plus, Trash2, X, Upload, PhoneCall, PhoneOff, Clock, Zap, Radio,
  Terminal, MessageSquare, Mic, Bot, User, AlertCircle, CheckCircle, ArrowRight, Download
} from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b'];

const TABS = [
  { id: 'info', label: 'Info', icon: Info },
  { id: 'leads', label: 'Leads', icon: Users },
  { id: 'calls', label: 'Calls', icon: Phone },
  { id: 'live', label: 'Live Logs', icon: Terminal },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
];

export default function CampaignDetail() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const seed = location.state?.campaign && location.state.campaign.id === id
    ? location.state.campaign
    : null;
  const [campaign, setCampaign] = useState(seed);
  const [loading, setLoading] = useState(!seed);
  const tab = searchParams.get('tab') || 'info';

  // Live call tracking
  const [liveState, setLiveState] = useState({ running: false, activeCalls: [], completedCalls: 0, totalLeads: 0, remainingLeads: 0 });
  const [recentEvents, setRecentEvents] = useState([]);
  const [liveEvents, setLiveEvents] = useState([]); // Detailed live events for Live Logs tab
  const { connected, on } = useWebSocket(id);

  const load = useCallback(() => {
    return api.getCampaign(id)
      .then(setCampaign)
      .catch(() => { setCampaign(prev => { if (!prev) navigate('/campaigns'); return prev; }); })
      .finally(() => setLoading(false));
  }, [id, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll campaign status on mount and every 5s while running
  useEffect(() => {
    const fetchStatus = () => api.getCampaignStatus(id).then(s => {
      setLiveState(prev => ({
        ...prev,
        activeCalls: s.activeCalls || [],
        completedCalls: s.completedCalls || 0,
        totalLeads: s.totalLeads || 0,
        remainingLeads: s.remainingLeads || 0,
      }));
    }).catch(() => {});
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [id]);

  // Subscribe to WebSocket events
  useEffect(() => {
    const handleCallStarted = (data) => {
      if (data.campaignId !== id) return;
      setLiveState(prev => ({ 
        ...prev, 
        running: true, 
        activeCalls: [...prev.activeCalls.filter(c => c.leadId !== data.call?.leadId), data.call].filter(Boolean), 
        remainingLeads: data.remainingLeads ?? prev.remainingLeads 
      }));
      setRecentEvents(prev => [{ type: 'started', ...data, time: new Date().toISOString() }, ...prev].slice(0, 30));
    };

    const handleCallEnded = (data) => {
      if (data.campaignId !== id) return;
      setLiveState(prev => ({
        ...prev,
        activeCalls: prev.activeCalls.filter(c => c.leadId !== data.leadId),
        completedCalls: data.completedCalls ?? prev.completedCalls,
        remainingLeads: data.remainingLeads ?? prev.remainingLeads,
      }));
      setRecentEvents(prev => [{ type: 'ended', ...data, time: new Date().toISOString() }, ...prev].slice(0, 30));
    };

    const handleCampaignFinished = (data) => {
      if (data.campaignId !== id) return;
      setLiveState(prev => ({ ...prev, running: false, activeCalls: [] }));
      load();
    };

    const handleCampaignLog = (data) => {
      if (data.campaignId !== id) return;
      setRecentEvents(prev => [{ type: 'log', message: data.message, level: data.level, time: data.time }, ...prev].slice(0, 30));
    };

    const handleLiveEvent = (data) => {
      if (data.campaignId !== id) return;
      setLiveEvents(prev => [data, ...prev].slice(0, 500)); // Keep last 500 events
    };

    const unsubs = [
      on('call_started', handleCallStarted),
      on('call_ended', handleCallEnded),
      on('campaign_finished', handleCampaignFinished),
      on('campaign_log', handleCampaignLog),
      on('live_event', handleLiveEvent),
    ];
    return () => unsubs.forEach(fn => fn && fn());
  }, [on, id]);

  const handleStart = async () => {
    setCampaign(prev => prev ? { ...prev, status: 'running' } : prev);
    setLiveState(prev => ({ ...prev, running: true }));
    try {
      await api.startCampaign(id);
    } catch (e) {
      console.error('Start campaign error:', e);
      setCampaign(prev => prev ? { ...prev, status: 'paused' } : prev);
      alert(e.message || 'Failed to start campaign');
    }
    load();
  };
  const handleStop = async () => {
    setCampaign(prev => prev ? { ...prev, status: 'paused' } : prev);
    setLiveState(prev => ({ ...prev, running: false }));
    try {
      await api.stopCampaign(id, { force: false });
    } catch (e) {
      console.error('Stop campaign error:', e);
    }
  };
  const handleForceStop = async () => {
    setCampaign(prev => prev ? { ...prev, status: 'paused' } : prev);
    setLiveState(prev => ({ ...prev, running: false, activeCalls: [] }));
    try {
      await api.stopCampaign(id, { force: true });
    } catch (e) {
      console.error('Force stop campaign error:', e);
    }
  };

  if (loading) return <div className="p-8 flex justify-center"><div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" /></div>;
  if (!campaign) return null;

  const isRunning = campaign.status === 'running';

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate('/campaigns')} className="p-1.5 hover:bg-gray-100 rounded-lg transition">
          <ArrowLeft className="w-4 h-4 text-gray-500" />
        </button>
        <h1 className="text-xl font-bold text-gray-900">{campaign.name}</h1>
        <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${
          isRunning ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
        }`}>
          {isRunning ? '● Running' : '● Paused'}
        </span>
        <div className="flex-1" />
        {isRunning ? (
          <div className="flex items-center gap-2">
            <button onClick={handleStop}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition bg-amber-500 text-white hover:bg-amber-600"
              title="Stop dialing new leads — active calls finish naturally">
              <Pause className="w-4 h-4" /> STOP
            </button>
            <button onClick={handleForceStop}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition bg-red-600 text-white hover:bg-red-700"
              title="Kill all active calls immediately">
              <PhoneOff className="w-4 h-4" /> FORCE STOP
            </button>
          </div>
        ) : (
          <button onClick={handleStart}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition bg-green-600 text-white hover:bg-green-700">
            <Play className="w-4 h-4" /> Start Campaign
          </button>
        )}
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-6 text-xs text-gray-500 mb-6 ml-10">
        <span><b className="text-gray-700">{campaign.total_leads || 0}</b> Total Leads</span>
        <span><b className="text-gray-700">{campaign.answered_leads || 0}</b> Answered</span>
        <span><b className="text-gray-700">{campaign.transferred_calls || 0}</b> Transfers</span>
        <span><b className="text-gray-700">{campaign.dnc_leads || 0}</b> DNC</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setSearchParams({ tab: t.id })}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition ${
              tab === t.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* Live Calls Panel — visible when campaign is running or has active calls */}
      {(isRunning || liveState.activeCalls.length > 0) && (
        <LiveCallsPanel liveState={liveState} recentEvents={recentEvents} connected={connected} onStop={handleStop} onForceStop={handleForceStop} />
      )}

      {tab === 'info' && <InfoTab campaign={campaign} />}
      {tab === 'leads' && <LeadsTab campaignId={id} lists={campaign.lists || []} onUpdate={load} />}
      {tab === 'calls' && <CallsTab campaignId={id} />}
      {tab === 'live' && <LiveLogsTab events={liveEvents} connected={connected} onClear={() => setLiveEvents([])} />}
      {tab === 'settings' && <SettingsTab campaign={campaign} onUpdate={load} />}
      {tab === 'analytics' && <AnalyticsTab campaignId={id} />}
    </div>
  );
}

function LiveCallsPanel({ liveState, recentEvents, connected, onStop, onForceStop }) {
  const { activeCalls, completedCalls, totalLeads, remainingLeads } = liveState;
  const progress = totalLeads > 0 ? Math.round(((completedCalls) / totalLeads) * 100) : 0;

  return (
    <div className="mb-6 bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 flex items-center justify-between border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Radio className="w-4 h-4 text-green-400" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-ping" />
          </div>
          <h3 className="text-sm font-semibold text-white">Live Monitor</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
            {connected ? 'Connected' : 'Reconnecting...'}
          </span>
          {activeCalls.length > 0 && (
            <div className="flex items-center gap-2">
              {onStop && (
                <button onClick={onStop}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-white hover:bg-amber-600 transition"
                  title="Stop dialing — active calls finish naturally">
                  <Pause className="w-3.5 h-3.5" /> STOP
                </button>
              )}
              {onForceStop && (
                <button onClick={onForceStop}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 text-white hover:bg-red-700 transition animate-pulse"
                  title="Kill all active calls immediately">
                  <PhoneOff className="w-3.5 h-3.5" /> FORCE STOP
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stats Row */}
      <div className="px-5 py-3 grid grid-cols-4 gap-4 border-b border-gray-700/50">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1">
            <Zap className="w-3 h-3" /> Active Calls
          </div>
          <span className="text-2xl font-bold text-green-400">{activeCalls.length}</span>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1">
            <Phone className="w-3 h-3" /> Completed
          </div>
          <span className="text-2xl font-bold text-white">{completedCalls}</span>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1">
            <Users className="w-3 h-3" /> Remaining
          </div>
          <span className="text-2xl font-bold text-gray-300">{remainingLeads}</span>
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">Progress</div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-white">{progress}%</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-1.5 mt-1">
            <div className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      {/* Active Calls + Recent Events */}
      <div className="grid grid-cols-2 divide-x divide-gray-700/50">
        {/* Active Calls */}
        <div className="px-4 py-3">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Active Calls</h4>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {activeCalls.length === 0 ? (
              <p className="text-xs text-gray-500 italic">No active calls</p>
            ) : (
              activeCalls.map((call, i) => (
                <div key={call.leadId || i} className="flex items-center gap-2 text-xs bg-gray-800/50 rounded-lg px-3 py-2">
                  <div className="relative">
                    <PhoneCall className="w-3.5 h-3.5 text-green-400" />
                    <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                  </div>
                  <span className="text-white font-medium truncate">{call.name}</span>
                  <span className="text-gray-500 font-mono">{call.phone}</span>
                  <span className="ml-auto text-gray-500">
                    <CallTimer startedAt={call.startedAt} />
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Events */}
        <div className="px-4 py-3">
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Recent Activity</h4>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {recentEvents.length === 0 ? (
              <p className="text-xs text-gray-500 italic">Waiting for calls...</p>
            ) : (
              recentEvents.slice(0, 10).map((evt, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {evt.type === 'started' ? (
                    <PhoneCall className="w-3 h-3 text-blue-400 shrink-0" />
                  ) : evt.type === 'ended' ? (
                    <PhoneOff className="w-3 h-3 text-gray-400 shrink-0" />
                  ) : evt.type === 'log' && evt.level === 'warn' ? (
                    <AlertCircle className="w-3 h-3 text-yellow-300 shrink-0" />
                  ) : (
                    <Info className="w-3 h-3 text-gray-500 shrink-0" />
                  )}
                  <span className={`truncate ${evt.type === 'log' && evt.level === 'warn' ? 'text-yellow-300' : 'text-gray-300'}`}>
                    {evt.type === 'started' && `Calling ${evt.call?.name || 'lead'}...`}
                    {evt.type === 'ended' && `${evt.name}: ${evt.outcome} (${evt.duration}s)`}
                    {evt.type === 'log' && evt.message}
                  </span>
                  <span className="ml-auto text-gray-600 shrink-0">
                    {evt.time ? new Date(evt.time).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CallTimer({ startedAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return <span className="font-mono">{mins}:{secs.toString().padStart(2, '0')}</span>;
}

function InfoTab({ campaign }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Campaign Details</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Name</span><span className="text-gray-900 font-medium">{campaign.name}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Type</span><span className="text-gray-900">{campaign.type}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Status</span><span className="text-gray-900">{campaign.status}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Agent</span><span className="text-gray-900">{campaign.agent_name || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Created</span><span className="text-gray-900">{campaign.created_at?.slice(0, 10)}</span></div>
        </div>
      </div>

      {(campaign.agent_mode || 'live_transfer') === 'live_transfer' ? (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Transfer Extensions</h3>
          {(campaign.extensions || []).length === 0 ? (
            <p className="text-sm text-gray-400">No extensions configured</p>
          ) : (
            <div className="space-y-1.5">
              {campaign.extensions.map(ext => (
                <div key={ext.id} className="flex items-center justify-between text-sm bg-gray-50 px-3 py-1.5 rounded-lg">
                  <span className="font-mono text-gray-700">{ext.extension}</span>
                  <span className={`text-xs ${ext.active ? 'text-green-600' : 'text-gray-400'}`}>
                    {ext.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Agent Mode</h3>
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
            <span className="font-medium">Appointment Setting</span>
          </div>
          <p className="text-xs text-gray-400">Agent will collect date/time from qualified leads. No transfer extensions needed.</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Assigned Lists</h3>
        {(campaign.lists || []).length === 0 ? (
          <p className="text-sm text-gray-400">No lists assigned</p>
        ) : (
          <div className="space-y-1.5">
            {campaign.lists.map(l => (
              <div key={l.id} className="flex items-center justify-between text-sm bg-gray-50 px-3 py-1.5 rounded-lg">
                <span className="text-gray-700">{l.name}</span>
                <span className="text-xs text-gray-400">{l.total_leads} leads</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Schedule</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Start Date</span><span className="text-gray-900">{campaign.start_date || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">End Date</span><span className="text-gray-900">{campaign.end_date || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Window</span><span className="text-gray-900">{campaign.daily_start_time} — {campaign.daily_end_time}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Timezone</span><span className="text-gray-900">{campaign.timezone}</span></div>
          <div className="flex flex-wrap gap-1 mt-1">
            {(campaign.days_of_week || []).map(d => (
              <span key={d} className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{d.slice(0, 3)}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LeadsTab({ campaignId, lists, onUpdate }) {
  const [leads, setLeads] = useState({ leads: [], total: 0, page: 1, pages: 1 });
  const [allLists, setAllLists] = useState([]);
  const [showAssign, setShowAssign] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getCampaignLeads(campaignId).then(setLeads).catch(() => {}).finally(() => setLoading(false));
    api.getLists().then(setAllLists).catch(() => {});
  }, [campaignId]);

  const assignList = async (listId) => {
    await api.assignList(campaignId, listId);
    setShowAssign(false);
    onUpdate();
    api.getCampaignLeads(campaignId).then(setLeads);
  };

  const removeList = async (listId) => {
    await api.removeList(campaignId, listId);
    onUpdate();
    api.getCampaignLeads(campaignId).then(setLeads);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{leads.total} leads from {lists.length} list(s)</p>
        <button onClick={() => setShowAssign(true)}
          className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-700 font-medium">
          <Plus className="w-3.5 h-3.5" /> Assign List
        </button>
      </div>

      {lists.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {lists.map(l => (
            <span key={l.id} className="inline-flex items-center gap-1.5 bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-xs font-medium">
              {l.name} ({l.total_leads})
              <button onClick={() => removeList(l.id)} className="hover:text-red-600"><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Phone</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Email</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">List</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {leads.leads.map(l => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 font-mono text-gray-700">{l.phone}</td>
                <td className="px-4 py-2.5 text-gray-700">{l.first_name} {l.last_name}</td>
                <td className="px-4 py-2.5 text-gray-500">{l.email || '—'}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    l.status === 'new' ? 'bg-blue-100 text-blue-700' :
                    l.status === 'called' ? 'bg-green-100 text-green-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{l.status}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-400">{l.list_name}</td>
              </tr>
            ))}
            {leads.leads.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No leads. Assign a list to this campaign.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAssign && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowAssign(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b"><h3 className="font-bold text-gray-900">Assign List</h3></div>
            <div className="p-6 space-y-2 max-h-80 overflow-auto">
              {allLists.filter(l => !lists.find(cl => cl.id === l.id)).map(l => (
                <button key={l.id} onClick={() => assignList(l.id)}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 transition">
                  <p className="text-sm font-medium text-gray-700">{l.name}</p>
                  <p className="text-xs text-gray-400">{l.total_leads} leads</p>
                </button>
              ))}
              {allLists.filter(l => !lists.find(cl => cl.id === l.id)).length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No available lists. Create one first.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CallsTab({ campaignId }) {
  const [data, setData] = useState({ calls: [], total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);

  useEffect(() => {
    api.getCampaignCalls(campaignId).then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [campaignId]);

  const playRecording = async (callId) => {
    if (playingId === callId) {
      // Stop current playback
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingId(null);
      return;
    }
    
    // Stop previous playback
    if (audioRef.current) {
      audioRef.current.pause();
    }
    
    setPlayingId(callId);
    
    try {
      // Get token from localStorage and add to query string
      const token = localStorage.getItem('robocop_token');
      const url = `/api/campaigns/${campaignId}/calls/${callId}/recording?token=${encodeURIComponent(token)}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error('Recording not available');
      }
      
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const audio = new Audio(blobUrl);
      audio.onended = () => {
        setPlayingId(null);
        URL.revokeObjectURL(blobUrl);
      };
      audio.onerror = () => {
        alert('Error playing recording');
        setPlayingId(null);
        URL.revokeObjectURL(blobUrl);
      };
      audio.play();
      audioRef.current = audio;
    } catch (err) {
      alert('Recording not available');
      setPlayingId(null);
    }
  };

  const downloadRecording = async (c) => {
    try {
      const token = localStorage.getItem('robocop_token');
      const res = await fetch(`/api/campaigns/${campaignId}/calls/${c.id}/recording?token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error('Recording not available');
      const blob = await res.blob();
      const when = c.started_at ? new Date(c.started_at) : new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}-${pad(when.getMinutes())}`;
      const safe = (s) => String(s || '').replace(/[^\w\- ]+/g, '').trim();
      const name = `${stamp} ${safe(c.lead_name) || c.phone} ${c.phone} ${safe(c.outcome)}.wav`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (err) {
      alert('Recording not available (it may have been removed by retention)');
    }
  };

  const fmtLocal = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso.replace('T', ' ').slice(0, 16);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  if (loading) return <div className="py-8 text-center"><div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full mx-auto" /></div>;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Phone</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Lead</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Outcome</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Duration</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Recording</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.calls.map(c => (
            <tr key={c.id} className="hover:bg-gray-50">
              <td className="px-4 py-2.5 font-mono text-gray-700">{c.phone}</td>
              <td className="px-4 py-2.5 text-gray-700">{c.lead_name || '—'}</td>
              <td className="px-4 py-2.5">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  c.outcome === 'transferred' ? 'bg-green-100 text-green-700' :
                  c.outcome === 'interested' ? 'bg-blue-100 text-blue-700' :
                  c.outcome === 'not_interested' ? 'bg-amber-100 text-amber-700' :
                  c.outcome === 'error' ? 'bg-red-100 text-red-700' :
                  'bg-gray-100 text-gray-600'
                }`}>{c.outcome}</span>
              </td>
              <td className="px-4 py-2.5 text-gray-500">{c.duration_seconds}s</td>
              <td className="px-4 py-2.5 text-gray-500 text-xs" title={c.started_at}>{fmtLocal(c.started_at)}</td>
              <td className="px-4 py-2.5">
                {c.recording_path ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => playRecording(c.id)}
                      className={`p-1.5 rounded-lg transition ${
                        playingId === c.id
                          ? 'bg-indigo-100 text-indigo-600'
                          : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'
                      }`}
                      title={playingId === c.id ? 'Stop' : 'Play recording'}
                    >
                      {playingId === c.id ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => downloadRecording(c)}
                      className="p-1.5 rounded-lg transition hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                      title="Download recording (.wav)"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-gray-300">—</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-gray-400 text-xs max-w-48 truncate">{c.notes || '—'}</td>
            </tr>
          ))}
          {data.calls.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No calls yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab({ campaign, onUpdate }) {
  const [form, setForm] = useState({
    name: campaign.name || '',
    agent_id: campaign.agent_id || '',
    phone_number: campaign.phone_number || '',
    start_date: campaign.start_date || '',
    end_date: campaign.end_date || '',
    daily_start_time: campaign.daily_start_time || '15:00',
    daily_end_time: campaign.daily_end_time || '00:00',
    timezone: campaign.timezone || 'Europe/Amsterdam',
    days_of_week: campaign.days_of_week || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    total_dial_attempts: campaign.total_dial_attempts || 5,
    max_daily_attempts: campaign.max_daily_attempts || 3,
    redial_wait_minutes: campaign.redial_wait_minutes || 5,
    campaign_priority: campaign.campaign_priority || 5,
    voicemail_as_answered: campaign.voicemail_as_answered || 0,
    webhook_url: campaign.webhook_url || '',
    max_concurrent_calls: campaign.max_concurrent_calls || 1,
    google_sheet_id: campaign.google_sheet_id || '',
    google_drive_folder_id: campaign.google_drive_folder_id || '',
    sip_settings_id: campaign.sip_settings_id || '',
  });
  const [agents, setAgents] = useState([]);
  const [sipTrunks, setSipTrunks] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sheetTesting, setSheetTesting] = useState(false);
  const [sheetTestResult, setSheetTestResult] = useState(null);
  const [newExt, setNewExt] = useState('');
  const [extensions, setExtensions] = useState(campaign.extensions || []);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => {});
    api.getSipTrunks().then(data => setSipTrunks(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const setNum = (key) => (e) => setForm({ ...form, [key]: parseInt(e.target.value) || 0 });

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateCampaign(campaign.id, form);
      onUpdate();
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  const addExtension = async () => {
    if (!newExt.trim()) return;
    const ext = await api.addExtension(campaign.id, { extension: newExt.trim() });
    setExtensions([...extensions, ext]);
    setNewExt('');
  };

  const deleteExtension = async (extId) => {
    await api.deleteExtension(campaign.id, extId);
    setExtensions(extensions.filter(e => e.id !== extId));
  };

  const toggleDay = (day) => {
    const days = form.days_of_week.includes(day)
      ? form.days_of_week.filter(d => d !== day)
      : [...form.days_of_week, day];
    setForm({ ...form, days_of_week: days });
  };

  const allDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Campaign Config */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <div className="w-5 h-5 bg-green-100 rounded-full flex items-center justify-center"><span className="text-green-600 text-xs">●</span></div>
          Campaign Config
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Campaign Name</label>
            <input type="text" value={form.name} onChange={set('name')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Agent</label>
            <select value={form.agent_id} onChange={set('agent_id')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">Select agent...</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Max Concurrent Calls</label>
            <input type="number" value={form.max_concurrent_calls} onChange={setNum('max_concurrent_calls')} min={1} max={50}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">SIP Trunk</label>
            <select value={form.sip_settings_id} onChange={set('sip_settings_id')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">Use default trunk</option>
              {sipTrunks.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.is_default ? '(default)' : ''} — {t.mode === 'trunk' ? t.trunkHost : t.server}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-1">Select which SIP trunk this campaign uses for outbound calls</p>
          </div>
        </div>
      </div>

      {/* Transfer Extensions — only shown for live_transfer agents */}
      {(() => {
        const selectedAgent = agents.find(a => a.id === form.agent_id);
        const agentMode = selectedAgent?.mode || campaign.agent_mode || 'live_transfer';
        return agentMode === 'live_transfer' ? (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-700">Transfer Extensions (up to 100)</h3>
            <div className="flex gap-2">
              <input type="text" value={newExt} onChange={e => setNewExt(e.target.value)} placeholder="e.g. 676"
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 w-40"
                onKeyDown={e => e.key === 'Enter' && addExtension()} />
              <button onClick={addExtension}
                className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition">Add</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {extensions.map(ext => (
                <span key={ext.id} className="inline-flex items-center gap-1.5 bg-gray-100 text-gray-700 px-3 py-1 rounded-full text-sm font-mono">
                  {ext.extension}
                  <button onClick={() => deleteExtension(ext.id)} className="text-gray-400 hover:text-red-500"><X className="w-3 h-3" /></button>
                </span>
              ))}
              {extensions.length === 0 && <p className="text-sm text-gray-400">No extensions added</p>}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-2">
            <h3 className="text-sm font-semibold text-gray-700">Agent Mode: Appointment Setting</h3>
            <p className="text-xs text-gray-400">This agent books appointments instead of transferring calls. No extensions needed.</p>
          </div>
        );
      })()}

      {/* Schedule */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <div className="w-5 h-5 bg-green-100 rounded-full flex items-center justify-center"><span className="text-green-600 text-xs">●</span></div>
          Schedule
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
            <input type="date" value={form.start_date} onChange={set('start_date')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">End Date (Optional)</label>
            <input type="date" value={form.end_date} onChange={set('end_date')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
            <input type="time" value={form.daily_start_time} onChange={set('daily_start_time')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
            <input type="time" value={form.daily_end_time} onChange={set('daily_end_time')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Timezone</label>
            <input type="text" value={form.timezone} onChange={set('timezone')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">Days of the Week</label>
          <div className="flex flex-wrap gap-2">
            {allDays.map(day => (
              <button key={day} onClick={() => toggleDay(day)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition ${
                  form.days_of_week.includes(day)
                    ? 'bg-indigo-100 border-indigo-300 text-indigo-700 font-medium'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                }`}>{day}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Outbound Settings */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700">Outbound Settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Total Dial Attempts (per lead)</label>
            <input type="number" value={form.total_dial_attempts} onChange={setNum('total_dial_attempts')} min={1} max={20}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Max Daily Attempts (per lead)</label>
            <input type="number" value={form.max_daily_attempts} onChange={setNum('max_daily_attempts')} min={1} max={10}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Redial Wait (minutes)</label>
            <input type="number" value={form.redial_wait_minutes} onChange={setNum('redial_wait_minutes')} min={1}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Campaign Priority (1-10)</label>
            <input type="number" value={form.campaign_priority} onChange={setNum('campaign_priority')} min={1} max={10}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
        </div>
      </div>

      {/* Webhook */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700">Webhook Configuration</h3>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Outgoing Webhook URL (Optional)</label>
          <input type="url" value={form.webhook_url} onChange={set('webhook_url')} placeholder="https://hook.example.com/..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
        </div>
      </div>

      {/* Google Sheets */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-700">Google Sheets Sync</h3>
        <p className="text-xs text-gray-500">
          Link a Google Sheet to auto-push all appointment and lead data from this campaign.
          First, set up credentials in Settings &gt; Google Sheets.
        </p>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Google Sheet ID</label>
          <input type="text" value={form.google_sheet_id} onChange={set('google_sheet_id')} placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono outline-none" />
          <p className="text-xs text-gray-400 mt-1">
            From your sheet URL: docs.google.com/spreadsheets/d/<strong>THIS_PART</strong>/edit
          </p>
        </div>
        {form.google_sheet_id && (
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setSheetTesting(true); setSheetTestResult(null);
                try {
                  const res = await api.testGoogleSheet(form.google_sheet_id);
                  setSheetTestResult({ success: true, title: res.title });
                } catch (e) {
                  setSheetTestResult({ success: false, error: e.message });
                }
                setSheetTesting(false);
              }}
              disabled={sheetTesting}
              className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded-lg text-xs font-medium hover:bg-green-100 disabled:opacity-50 transition"
            >
              {sheetTesting ? 'Testing...' : 'Test Connection'}
            </button>
            {sheetTestResult && (
              <span className={`text-xs ${sheetTestResult.success ? 'text-green-600' : 'text-red-600'}`}>
                {sheetTestResult.success ? `Connected: "${sheetTestResult.title}"` : sheetTestResult.error}
              </span>
            )}
          </div>
        )}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <label className="block text-xs font-medium text-gray-600 mb-1">Google Drive Folder ID (for recordings)</label>
          <input type="text" value={form.google_drive_folder_id} onChange={set('google_drive_folder_id')} placeholder="e.g. 1AbC_dEfGhIjKlMnOpQrStUvWxYz"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono outline-none" />
          <p className="text-xs text-gray-400 mt-1">
            From your Drive folder URL: drive.google.com/drive/folders/<strong>THIS_PART</strong>
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            Share this folder with your service account email. Recordings will be uploaded here and linked in the sheet.
          </p>
        </div>
      </div>

      <button onClick={handleSave} disabled={saving}
        className="bg-gray-900 text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 transition">
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

function AnalyticsTab({ campaignId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getCampaignAnalytics(campaignId).then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [campaignId]);

  if (loading) return <div className="py-8 text-center"><div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full mx-auto" /></div>;
  if (!data) return <p className="text-sm text-gray-400">No analytics data</p>;

  const s = data.summary || {};

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Total Calls</p>
          <p className="text-xl font-bold text-gray-900">{s.total_calls || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Transfers</p>
          <p className="text-xl font-bold text-green-600">{s.transfers || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Avg Duration</p>
          <p className="text-xl font-bold text-gray-900">{Math.round(s.avg_duration || 0)}s</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500">Errors</p>
          <p className="text-xl font-bold text-red-600">{s.errors || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Calls Over Time</h3>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={data.callsByDay || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={d => d?.slice(5)} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Area type="monotone" dataKey="count" stroke="#6366f1" fill="#eef2ff" strokeWidth={2} />
              <Area type="monotone" dataKey="transfers" stroke="#22c55e" fill="#f0fdf4" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Outcomes</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.outcomes || []} dataKey="count" nameKey="outcome" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2}>
                {(data.outcomes || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function LiveLogsTab({ events, connected, onClear }) {
  const [filter, setFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsRef = useRef(null);

  useEffect(() => {
    if (autoScroll && logsRef.current) {
      logsRef.current.scrollTop = 0;
    }
  }, [events, autoScroll]);

  const getEventIcon = (type) => {
    switch (type) {
      case 'transcript': return <MessageSquare className="w-3.5 h-3.5" />;
      case 'call_init':
      case 'call_complete': return <Phone className="w-3.5 h-3.5" />;
      case 'sip_dialing':
      case 'sip_connected':
      case 'sip_hangup': return <PhoneCall className="w-3.5 h-3.5" />;
      case 'deepgram': return <Radio className="w-3.5 h-3.5" />;
      case 'audio_bridge': return <Mic className="w-3.5 h-3.5" />;
      case 'function_call': return <Zap className="w-3.5 h-3.5" />;
      case 'barge_in': return <User className="w-3.5 h-3.5" />;
      case 'error': return <AlertCircle className="w-3.5 h-3.5" />;
      case 'blocked': return <AlertCircle className="w-3.5 h-3.5" />;
      case 'appointment_saved':
      case 'transfer_complete': return <CheckCircle className="w-3.5 h-3.5" />;
      default: return <ArrowRight className="w-3.5 h-3.5" />;
    }
  };

  const getEventColor = (type, data) => {
    if (type === 'transcript') {
      return data.role === 'assistant' ? 'text-indigo-600 bg-indigo-50' : 'text-emerald-600 bg-emerald-50';
    }
    switch (type) {
      case 'error': return 'text-red-600 bg-red-50';
      case 'blocked': return 'text-yellow-800 bg-yellow-300';
      case 'function_call': return 'text-amber-600 bg-amber-50';
      case 'appointment_saved':
      case 'transfer_complete':
      case 'call_complete': return 'text-green-600 bg-green-50';
      case 'sip_dialing': return 'text-blue-600 bg-blue-50';
      case 'sip_connected':
      case 'deepgram': return 'text-blue-600 bg-blue-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  const formatEventMessage = (evt) => {
    const { type, ...data } = evt;
    switch (type) {
      case 'transcript':
        return `[${data.role === 'assistant' ? 'AI' : 'User'}] ${data.text}`;
      case 'call_init':
        return `📞 Initializing call to ${data.name} (${data.phone})`;
      case 'audio_bridge':
        return `🎤 Audio bridge ${data.status}${data.port ? ` on port ${data.port}` : ''}`;
      case 'sip_dialing':
        return `📱 Dialing ${data.phone}...`;
      case 'sip_connected':
        return `✅ SIP connected - call answered`;
      case 'sip_hangup':
        return `📴 Call ended (${data.by} hung up)`;
      case 'deepgram':
        return `🔗 Voice engine ${data.status}`;
      case 'barge_in':
        return `🗣️ User interrupted (barge-in)`;
      case 'function_call':
        if (data.function === 'book_appointment') {
          return `⚡ Function: book_appointment(${data.date} ${data.time})`;
        } else if (data.function === 'transfer_call') {
          return `⚡ Function: transfer_call("${data.reason}")`;
        } else if (data.function === 'end_call') {
          return `⚡ Function: end_call(${data.outcome})`;
        }
        return `⚡ Function: ${data.function}`;
      case 'appointment_saved':
        return `✅ Appointment saved: ${data.date} ${data.time}`;
      case 'transfer_complete':
        return `✅ Transfer complete to extension ${data.extension}`;
      case 'call_complete':
        return `🏁 Call complete: ${data.outcome}`;
      case 'error':
        return `❌ Error: ${data.message}`;
      case 'blocked':
        return data.message || `Blocked ${data.name || ''} (${data.phone || ''}): already called ${data.count || 5} times this hour — maximum is 5`;
      default:
        return `${type}: ${JSON.stringify(data)}`;
    }
  };

  const filteredEvents = events.filter(evt => {
    if (filter === 'all') return true;
    if (filter === 'transcript') return evt.type === 'transcript';
    if (filter === 'functions') return evt.type === 'function_call' || evt.type === 'appointment_saved' || evt.type === 'transfer_complete';
    if (filter === 'system') return !['transcript', 'function_call', 'appointment_saved', 'transfer_complete'].includes(evt.type);
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${connected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {connected ? '● Connected' : '○ Reconnecting...'}
          </span>
          <span className="text-sm text-gray-500">{events.length} events</span>
        </div>
        <div className="flex items-center gap-2">
          <select value={filter} onChange={e => setFilter(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
            <option value="all">All Events</option>
            <option value="transcript">Transcripts Only</option>
            <option value="functions">Functions Only</option>
            <option value="system">System Events</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
            Auto-scroll
          </label>
          <button onClick={onClear}
            className="text-xs text-gray-500 hover:text-red-600 px-2.5 py-1.5 rounded-lg hover:bg-red-50 transition">
            Clear
          </button>
        </div>
      </div>

      {/* Live Logs Container */}
      <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
        {/* Log Header */}
        <div className="px-4 py-2.5 border-b border-gray-700 flex items-center gap-2">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="text-sm font-mono text-gray-300">Live Call Events</span>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-xs text-gray-500">Streaming</span>
          </div>
        </div>

        {/* Log Content */}
        <div ref={logsRef} className="h-[600px] overflow-y-auto p-3 font-mono text-xs space-y-1">
          {filteredEvents.length === 0 ? (
            <div className="text-gray-500 text-center py-10">
              <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>Waiting for call events...</p>
              <p className="text-gray-600 mt-1">Start a campaign to see live logs</p>
            </div>
          ) : (
            filteredEvents.map((evt, i) => (
              <div key={i} className="flex items-start gap-2 py-1 hover:bg-gray-800/50 rounded px-2 -mx-2 transition">
                {/* Timestamp */}
                <span className="text-gray-600 shrink-0 w-20">
                  {evt.time ? new Date(evt.time).toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--'}
                </span>
                
                {/* Call ID */}
                <span className="text-gray-500 shrink-0 font-mono w-16 truncate" title={evt.callId}>
                  [{evt.callId || '----'}]
                </span>

                {/* Event Icon + Type */}
                <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 ${getEventColor(evt.type, evt)}`}>
                  {getEventIcon(evt.type)}
                  {evt.type}
                </span>

                {/* Message */}
                <span className={`flex-1 ${evt.type === 'transcript' && evt.role === 'assistant' ? 'text-indigo-300' : evt.type === 'transcript' ? 'text-emerald-300' : evt.type === 'error' ? 'text-red-400' : evt.type === 'blocked' ? 'text-yellow-300' : 'text-gray-300'}`}>
                  {formatEventMessage(evt)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-indigo-500" /> AI Speech</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-500" /> User Speech</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-500" /> Function Calls</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-purple-500" /> System</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-500" /> Errors</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-yellow-400" /> Hourly cap</span>
      </div>
    </div>
  );
}
