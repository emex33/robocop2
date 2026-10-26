import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { Users, DollarSign, Phone, Clock, X, Plus, ChevronRight, Shield, Settings, Save, Play, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info, Sliders, Key, Trash2, FileText, Star, Cpu, Cloud } from 'lucide-react';

function fmt$(v) { return '$' + (v || 0).toFixed(2); }
function fmtMin(s) { return ((s || 0) / 60).toFixed(1) + ' min'; }

export default function AdminBilling() {
  const { isSuperAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [overview, setOverview] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [showAddCredits, setShowAddCredits] = useState(null);

  const load = () => {
    if (!isSuperAdmin) return;
    setLoading(true);
    Promise.all([api.adminGetUsers(), api.adminGetBilling()])
      .then(([u, o]) => { setUsers(u); setOverview(o); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, [isSuperAdmin]);

  if (!isSuperAdmin) return <Navigate to="/" replace />;

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-5 h-5 text-indigo-600" />
          <h1 className="text-2xl font-bold text-gray-900">Admin Billing</h1>
        </div>
        <p className="text-sm text-gray-500">Manage all users, credits, and platform usage</p>
      </div>

      {/* Global stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        {[
          { label: 'Total Users', value: users.length, icon: Users, color: 'text-indigo-600' },
          { label: 'Total Credit Balance', value: fmt$(overview.total_credit_balance), icon: DollarSign, color: 'text-green-600' },
          { label: 'Total Revenue', value: fmt$(overview.total_topups), icon: DollarSign, color: 'text-blue-600' },
          { label: 'Total Spent', value: fmt$(overview.total_charges), icon: DollarSign, color: 'text-red-500' },
          { label: 'Total Calls', value: overview.total_calls || 0, icon: Phone, color: 'text-gray-700' },
          { label: 'AI Minutes', value: fmtMin(overview.total_ai_duration), icon: Clock, color: 'text-purple-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-2 mb-2">
              <s.icon className={`w-4 h-4 ${s.color}`} />
              <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">{s.label}</p>
            </div>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Voice Engine + Cost Settings */}
      <VoiceEnginePanel />
      <CostSettingsPanel />

      {/* Users table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">All Users</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['User', 'Email', 'Balance', 'Total Spent', 'Total Calls', 'VoIP Cost', 'AI Cost', 'AI Minutes', 'Joined', ''].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={10} className="py-12 text-center"><div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full mx-auto" /></td></tr>
              ) : users.map(u => (
                <tr key={u.id} className="hover:bg-gray-50/50 transition">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center">
                        <span className="text-xs font-bold text-indigo-600">{(u.name || 'U')[0].toUpperCase()}</span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{u.name || 'Unnamed'}</p>
                        {u.is_super_admin === 1 && <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">ADMIN</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className={`font-bold ${u.credit_balance > 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {fmt$(u.credit_balance)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700 font-medium">{fmt$(u.total_spent)}</td>
                  <td className="px-4 py-3 text-gray-600">{u.total_calls}</td>
                  <td className="px-4 py-3 text-gray-500">{fmt$(u.total_voip_cost)}</td>
                  <td className="px-4 py-3 text-gray-500">{fmt$(u.total_ai_cost)}</td>
                  <td className="px-4 py-3 text-gray-500">{fmtMin(u.total_ai_duration)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{u.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setShowAddCredits(u)}
                        className="p-1.5 text-green-600 hover:bg-green-50 rounded transition"
                        title="Add credits"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          api.adminGetUser(u.id).then(setSelectedUser).catch(() => {});
                        }}
                        className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                        title="View details"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Credits Modal */}
      {showAddCredits && (
        <AddCreditsModal
          user={showAddCredits}
          onClose={() => setShowAddCredits(null)}
          onDone={() => { setShowAddCredits(null); load(); }}
        />
      )}

      {/* User Detail Modal */}
      {selectedUser && (
        <UserDetailModal data={selectedUser} onClose={() => setSelectedUser(null)} />
      )}
    </div>
  );
}

function AddCreditsModal({ user, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!val || val <= 0) return;
    setSaving(true);
    try {
      await api.adminAddCredits(user.id, val, description);
      onDone();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
          <h3 className="font-semibold text-gray-900">Add Credits</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <p className="text-sm text-gray-500 mb-3">Adding credits to <strong>{user.name || user.email}</strong></p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Amount (USD)</label>
            <input type="number" step="0.01" min="0.01" value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="10.00" required autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Description (optional)</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Monthly top-up" />
          </div>
          <button type="submit" disabled={saving}
            className="w-full py-2.5 bg-green-600 text-white rounded-lg font-semibold text-sm hover:bg-green-700 transition disabled:opacity-50">
            {saving ? 'Adding...' : `Add ${amount ? '$' + parseFloat(amount).toFixed(2) : ''} Credits`}
          </button>
        </form>
      </div>
    </div>
  );
}

function VoiceEnginePanel() {
  const [engine, setEngine] = useState('deepgram');
  const [localUrl, setLocalUrl] = useState('ws://voice-agent:8765');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.adminGetSettings()
      .then(s => {
        setEngine(s.voice_engine || 'deepgram');
        setLocalUrl(s.local_voice_agent_url || 'ws://voice-agent:8765');
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true); setMsg('');
    try {
      const res = await api.adminUpdateSettings({ voice_engine: engine, local_voice_agent_url: localUrl });
      setMsg(res.message || 'Saved');
    } catch (e) { setMsg('Error: ' + e.message); }
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Cpu className="w-4 h-4 text-violet-600" />
        <h2 className="font-semibold text-gray-900">Voice Engine</h2>
        <span className="text-xs text-gray-400 ml-1">Choose between cloud or local STT/TTS</span>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-lg mb-4">
        <button onClick={() => setEngine('deepgram')}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 text-left transition ${
            engine === 'deepgram' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'
          }`}>
          <Cloud className={`w-5 h-5 ${engine === 'deepgram' ? 'text-indigo-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-semibold text-gray-800">Deepgram (Cloud)</p>
            <p className="text-xs text-gray-500">API-based, requires API key</p>
          </div>
        </button>
        <button onClick={() => setEngine('local')}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 text-left transition ${
            engine === 'local' ? 'border-violet-500 bg-violet-50' : 'border-gray-200 hover:border-gray-300'
          }`}>
          <Cpu className={`w-5 h-5 ${engine === 'local' ? 'text-violet-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-semibold text-gray-800">Local (Self-hosted)</p>
            <p className="text-xs text-gray-500">faster-whisper + Coqui TTS</p>
          </div>
        </button>
        <button onClick={() => setEngine('assembly_google')}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 text-left transition ${
            engine === 'assembly_google' ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:border-gray-300'
          }`}>
          <Cloud className={`w-5 h-5 ${engine === 'assembly_google' ? 'text-emerald-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-semibold text-gray-800">Assembly + Google</p>
            <p className="text-xs text-gray-500">AssemblyAI STT + Google Cloud TTS</p>
          </div>
        </button>
        <button onClick={() => setEngine('google')}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 text-left transition ${
            engine === 'google' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'
          }`}>
          <Cloud className={`w-5 h-5 ${engine === 'google' ? 'text-amber-600' : 'text-gray-400'}`} />
          <div>
            <p className="text-sm font-semibold text-gray-800">Google STT + TTS</p>
            <p className="text-xs text-gray-500">Cloud Speech streaming + Chirp 3 (~300 sessions)</p>
          </div>
        </button>
      </div>

      {engine === 'local' && (
        <div className="max-w-lg mb-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">Local Voice Agent WebSocket URL</label>
          <input type="text" value={localUrl} onChange={e => setLocalUrl(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-violet-500 font-mono"
            placeholder="ws://voice-agent:8765" />
          <p className="text-xs text-gray-400 mt-1">In Docker: ws://voice-agent:8765 — Local dev: ws://localhost:8765</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-semibold hover:bg-violet-700 transition disabled:opacity-50">
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Engine'}
        </button>
        {msg && <span className={`text-sm ${msg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{msg}</span>}
      </div>

      {engine === 'local' && (
        <div className="mt-4 p-3 bg-violet-50 rounded-lg text-xs text-violet-700 space-y-1">
          <p><strong>Local engine uses:</strong></p>
          <p>STT: faster-whisper (Whisper model running locally)</p>
          <p>TTS: Coqui XTTSv2 (multi-language, voice cloning)</p>
          <p>LLM: Uses the same OpenAI-compatible API configured in .env (LLM_API_KEY, LLM_MODEL)</p>
          <p className="mt-1 text-violet-600 font-medium">The local voice-agent Docker service must be running.</p>
        </div>
      )}
    </div>
  );
}

function CostSettingsPanel() {
  const [rates, setRates] = useState({ voip_cost_per_min: '', ai_cost_per_min: '' });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.adminGetSettings()
      .then(s => { setRates({ voip_cost_per_min: s.voip_cost_per_min || '0.02', ai_cost_per_min: s.ai_cost_per_min || '0.40' }); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await api.adminUpdateSettings({
        voip_cost_per_min: rates.voip_cost_per_min,
        ai_cost_per_min: rates.ai_cost_per_min,
      });
      setMsg(res.message || 'Saved');
      if (res.settings) setRates({ voip_cost_per_min: res.settings.voip_cost_per_min, ai_cost_per_min: res.settings.ai_cost_per_min });
    } catch (e) { setMsg('Error: ' + e.message); }
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Sliders className="w-4 h-4 text-indigo-600" />
        <h2 className="font-semibold text-gray-900">Cost Settings</h2>
        <span className="text-xs text-gray-400 ml-1">Per-minute rates used to calculate call costs</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">VoIP Cost ($/min)</label>
          <input
            type="number" step="0.001" min="0"
            value={rates.voip_cost_per_min}
            onChange={e => setRates({ ...rates, voip_cost_per_min: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">AI Cost ($/min)</label>
          <input
            type="number" step="0.001" min="0"
            value={rates.ai_cost_per_min}
            onChange={e => setRates({ ...rates, ai_cost_per_min: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-50">
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Rates'}
        </button>
        {msg && <span className={`text-sm ${msg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{msg}</span>}
      </div>
    </div>
  );
}

function UserDetailModal({ data, onClose }) {
  const { user, transactions, callStats } = data;
  const [tab, setTab] = useState('overview');
  const [sip, setSip] = useState(null);
  const [sipLoading, setSipLoading] = useState(false);
  const [sipSaving, setSipSaving] = useState(false);
  const [sipTesting, setSipTesting] = useState(false);
  const [sipTestLogs, setSipTestLogs] = useState([]);
  const [sipTestResult, setSipTestResult] = useState(null);
  const [sipMsg, setSipMsg] = useState('');
  const logRef = useRef(null);

  const loadSip = () => {
    setSipLoading(true);
    api.adminGetUserSip(user.id).then(setSip).catch(() => {}).finally(() => setSipLoading(false));
  };

  const handleSipSave = async () => {
    setSipSaving(true);
    setSipMsg('');
    try {
      const res = await api.adminUpdateUserSip(user.id, sip);
      setSipMsg(res.message || 'Saved');
    } catch (e) { setSipMsg('Error: ' + e.message); }
    setSipSaving(false);
  };

  const handleSipTest = async () => {
    setSipTesting(true);
    setSipTestLogs([]);
    setSipTestResult(null);
    setSipMsg('');
    try {
      const res = await api.adminTestUserSip(user.id);
      setSipTestLogs(res.logs || []);
      setSipTestResult(res.success);
      setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 100);
    } catch (e) {
      setSipTestLogs([{ level: 'error', message: e.message || 'Test request failed' }]);
      setSipTestResult(false);
    }
    setSipTesting(false);
  };

  const sipSet = (key) => (e) => setSip({ ...sip, [key]: e.target.value });
  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center flex-shrink-0">
          <div>
            <h3 className="font-semibold text-gray-900">{user.name || user.email}</h3>
            <p className="text-sm text-gray-500">{user.email} · Balance: <strong className={user.credit_balance > 0 ? 'text-green-600' : 'text-red-500'}>{fmt$(user.credit_balance)}</strong></p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded"><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'sip', label: 'SIP Settings' },
            { id: 'deepgram', label: 'Deepgram' },
            { id: 'gsheets', label: 'Google Sheets' },
          ].map(t => (
            <button key={t.id}
              onClick={() => { setTab(t.id); if (t.id === 'sip' && !sip) loadSip(); }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>{t.label}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === 'overview' && (
            <>
              {/* Stats */}
              <div className="px-6 py-4 border-b border-gray-100 grid grid-cols-3 gap-4">
                {[
                  { label: 'Total Calls', value: callStats?.total_calls || 0 },
                  { label: 'Total Spent', value: fmt$(callStats?.total_spent) },
                  { label: 'AI Minutes', value: fmtMin(callStats?.total_ai_duration) },
                ].map(s => (
                  <div key={s.label} className="text-center">
                    <p className="text-lg font-bold text-gray-900">{s.value}</p>
                    <p className="text-[10px] text-gray-400 font-medium uppercase">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Transactions */}
              <div className="p-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">Recent Transactions</h4>
                {transactions.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">No transactions yet</p>
                ) : (
                  <div className="space-y-2">
                    {transactions.map(t => (
                      <div key={t.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {t.type === 'topup' ? 'Credit Top-up' : 'Call Charge'}
                          </p>
                          <p className="text-xs text-gray-400">{t.description || '—'}</p>
                          <p className="text-xs text-gray-300">{t.created_at?.replace('T', ' ').slice(0, 19)}</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-sm font-bold ${t.amount >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                            {t.amount >= 0 ? '+' : ''}{fmt$(t.amount)}
                          </p>
                          <p className="text-xs text-gray-400">Bal: {fmt$(t.balance_after)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'sip' && (
            <div className="p-6 space-y-4">
              {sipLoading ? (
                <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" /></div>
              ) : sip ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">SIP Mode</label>
                    <select value={sip.mode} onChange={sipSet('mode')} className={inputCls}>
                      <option value="account">Account (REGISTER)</option>
                      <option value="trunk">Trunk (IP-based)</option>
                    </select>
                  </div>

                  {sip.mode === 'account' ? (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
                          <input type="text" value={sip.username} onChange={sipSet('username')} className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                          <input type="password" value={sip.password} onChange={sipSet('password')} className={inputCls} />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Server</label>
                          <input type="text" value={sip.server} onChange={sipSet('server')} className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
                          <input type="number" value={sip.port} onChange={sipSet('port')} className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Transport</label>
                          <select value={sip.transport} onChange={sipSet('transport')} className={inputCls}>
                            <option value="udp">UDP</option>
                            <option value="tcp">TCP</option>
                          </select>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
                          <input type="text" value={sip.trunkUsername || sip.username} onChange={sipSet('trunkUsername')} className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Source IP</label>
                          <input type="text" value={sip.sourceIp} onChange={sipSet('sourceIp')} className={inputCls} placeholder="Your server public IP" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Trunk Host</label>
                          <input type="text" value={sip.trunkHost} onChange={sipSet('trunkHost')} className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Trunk Port</label>
                          <input type="number" value={sip.trunkPort} onChange={sipSet('trunkPort')} className={inputCls} />
                        </div>
                      </div>
                    </>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Caller ID</label>
                      <input type="text" value={sip.callerId} onChange={sipSet('callerId')} className={inputCls} placeholder="+15551234567" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Transfer URI</label>
                      <input type="text" value={sip.transferUri} onChange={sipSet('transferUri')} className={inputCls} placeholder="sip:agent@server.com" />
                    </div>
                  </div>

                  {sipMsg && <p className={`text-sm ${sipMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{sipMsg}</p>}

                  <div className="flex items-center gap-3">
                    <button onClick={handleSipSave} disabled={sipSaving}
                      className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-50">
                      {sipSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      {sipSaving ? 'Saving...' : 'Save SIP Settings'}
                    </button>
                    <button onClick={handleSipTest} disabled={sipTesting}
                      className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-50">
                      {sipTesting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      {sipTesting ? 'Testing...' : 'Test Connection'}
                    </button>
                  </div>

                  {sipTestLogs.length > 0 && (
                    <div className="bg-gray-50 rounded-lg border border-gray-200 mt-3">
                      <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-700 flex items-center gap-2">
                          {sipTestResult === true && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                          {sipTestResult === false && <XCircle className="w-3.5 h-3.5 text-red-500" />}
                          {sipTestResult === null && <RefreshCw className="w-3.5 h-3.5 text-gray-400 animate-spin" />}
                          SIP Test Results
                        </span>
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                          sipTestResult === true ? 'bg-green-100 text-green-700' :
                          sipTestResult === false ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-500'
                        }`}>
                          {sipTestResult === true ? 'PASS' : sipTestResult === false ? 'FAIL' : 'RUNNING'}
                        </span>
                      </div>
                      <div ref={logRef} className="px-3 py-2 max-h-48 overflow-y-auto font-mono text-xs space-y-1">
                        {sipTestLogs.map((l, i) => {
                          const Icon = l.level === 'success' ? CheckCircle2 : l.level === 'error' ? XCircle : l.level === 'warn' ? AlertTriangle : Info;
                          const color = l.level === 'success' ? 'text-green-600' : l.level === 'error' ? 'text-red-600' : l.level === 'warn' ? 'text-amber-600' : 'text-gray-500';
                          return (
                            <div key={i} className={`flex items-start gap-2 ${color}`}>
                              <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                              <pre className="whitespace-pre-wrap break-all">{l.message}</pre>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">Failed to load SIP settings</p>
              )}
            </div>
          )}
          {tab === 'deepgram' && <DeepgramTab userId={user.id} />}
          {tab === 'gsheets' && <GoogleSheetsTab userId={user.id} />}
        </div>
      </div>
    </div>
  );
}

function DeepgramTab({ userId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500";

  const load = () => {
    setLoading(true);
    api.adminGetUserDeepgram(userId).then(setData).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, [userId]);

  const handleAdd = async () => {
    if (!newKey.trim()) return;
    setAdding(true); setMsg('');
    try {
      const res = await api.adminAddUserDeepgramKey(userId, newKey.trim(), newLabel.trim());
      setData(res); setNewKey(''); setNewLabel(''); setMsg(res.message || 'Added');
    } catch (e) { setMsg('Error: ' + e.message); }
    setAdding(false);
  };

  const handleDelete = async (keyId) => {
    if (!confirm('Remove this key?')) return;
    try {
      const res = await api.adminDeleteUserDeepgramKey(userId, keyId);
      setData(res);
    } catch (e) { setMsg('Error: ' + e.message); }
  };

  const handleSetCurrent = async (keyId) => {
    try {
      const res = await api.adminSetCurrentUserDeepgramKey(userId, keyId);
      setData(res);
    } catch (e) { setMsg('Error: ' + e.message); }
  };

  const handleTest = async (keyId) => {
    setMsg('Testing...');
    try {
      const res = await api.adminTestUserDeepgramKey(userId, keyId);
      setMsg(res.success ? `Key valid (project: ${res.project})` : `Key failed: ${res.error || res.status}`);
    } catch (e) { setMsg('Error: ' + e.message); }
  };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" /></div>;

  const keys = data?.keys || [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Key className="w-4 h-4 text-purple-600" />
        <h4 className="text-sm font-semibold text-gray-700">Deepgram API Keys</h4>
        <span className="text-xs text-gray-400">({keys.length} key{keys.length !== 1 ? 's' : ''})</span>
      </div>

      {keys.length > 0 && (
        <div className="space-y-2">
          {keys.map(k => (
            <div key={k.id} className="flex items-center justify-between py-2 px-3 rounded-lg border border-gray-200 bg-gray-50">
              <div className="flex items-center gap-2 min-w-0">
                {k.is_current ? <Star className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /> : <Key className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{k.label || 'Unnamed'}</p>
                  <p className="text-xs text-gray-400 font-mono truncate">{k.api_key?.slice(0, 12)}...{k.api_key?.slice(-4)}</p>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${k.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{k.status}</span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {!k.is_current && <button onClick={() => handleSetCurrent(k.id)} className="p-1 text-amber-500 hover:bg-amber-50 rounded" title="Set as current"><Star className="w-3.5 h-3.5" /></button>}
                <button onClick={() => handleTest(k.id)} className="p-1 text-indigo-500 hover:bg-indigo-50 rounded" title="Test key"><Play className="w-3.5 h-3.5" /></button>
                <button onClick={() => handleDelete(k.id)} className="p-1 text-red-400 hover:bg-red-50 rounded" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-medium text-gray-500 mb-2">Add New Key</p>
        <div className="grid grid-cols-2 gap-3">
          <input type="text" value={newKey} onChange={e => setNewKey(e.target.value)} className={inputCls} placeholder="Deepgram API key" />
          <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} className={inputCls} placeholder="Label (optional)" />
        </div>
        <button onClick={handleAdd} disabled={adding || !newKey.trim()}
          className="mt-3 flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-semibold hover:bg-purple-700 transition disabled:opacity-50">
          {adding ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {adding ? 'Adding...' : 'Add Key'}
        </button>
      </div>

      {msg && <p className={`text-sm ${msg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{msg}</p>}
    </div>
  );
}

function GoogleSheetsTab({ userId }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500";

  const load = () => {
    setLoading(true);
    api.adminGetUserGoogleSheets(userId).then(setInfo).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, [userId]);

  const handleSave = async () => {
    if (!credentials.trim()) return;
    setSaving(true); setMsg('');
    try {
      const res = await api.adminUpdateUserGoogleSheets(userId, credentials.trim());
      setMsg(res.message || 'Saved');
      setInfo({ configured: true, client_email: res.client_email });
      setCredentials('');
    } catch (e) { setMsg('Error: ' + e.message); }
    setSaving(false);
  };

  const handleRemove = async () => {
    if (!confirm('Remove Google Sheets credentials for this user?')) return;
    try {
      await api.adminDeleteUserGoogleSheets(userId);
      setInfo({ configured: false, client_email: '' });
      setMsg('Credentials removed');
    } catch (e) { setMsg('Error: ' + e.message); }
  };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <FileText className="w-4 h-4 text-green-600" />
        <h4 className="text-sm font-semibold text-gray-700">Google Sheets Integration</h4>
      </div>

      {info?.configured ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-green-800">Credentials configured</p>
              <p className="text-xs text-green-600 mt-0.5">{info.client_email}</p>
            </div>
            <button onClick={handleRemove} className="p-1.5 text-red-400 hover:bg-red-50 rounded" title="Remove credentials">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-sm text-gray-500">No Google Sheets credentials configured for this user.</p>
        </div>
      )}

      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-medium text-gray-500 mb-2">{info?.configured ? 'Replace' : 'Upload'} Service Account JSON</p>
        <textarea
          value={credentials}
          onChange={e => setCredentials(e.target.value)}
          className={inputCls + ' h-32 font-mono text-xs'}
          placeholder='{"type": "service_account", "client_email": "...", "private_key": "...", ...}'
        />
        <button onClick={handleSave} disabled={saving || !credentials.trim()}
          className="mt-3 flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 transition disabled:opacity-50">
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Credentials'}
        </button>
      </div>

      {msg && <p className={`text-sm ${msg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>{msg}</p>}
    </div>
  );
}
