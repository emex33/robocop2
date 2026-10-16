import { useState, useEffect, useRef } from 'react';
import { Settings as SettingsIcon, Phone, Server, ArrowRightLeft, Save, RefreshCw, Play, CheckCircle2, XCircle, AlertTriangle, Info, FileSpreadsheet, Upload, Trash2, Plus, Star, Edit2, ChevronDown, ChevronUp, Key, Eye, EyeOff } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Navigate } from 'react-router-dom';

function ProxySettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [host, setHost] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState('');
  const [ips, setIps] = useState([]);

  useEffect(() => {
    api.getProxySettings().then(data => {
      setEnabled(!!data.enabled);
      setConfigured(!!data.configured);
      setHost(data.host || '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const apply = (data) => {
    setEnabled(!!data.enabled);
    setConfigured(!!data.configured);
    setHost(data.host || '');
    setUrl('');
  };

  const handleSave = async () => {
    setSaving(true); setMsg(''); setIps([]);
    try {
      apply(await api.updateProxySettings({ enabled, url }));
      setMsg('Proxy saved');
    } catch (e) { setMsg(e.message); }
    setSaving(false);
  };

  const handleTest = async () => {
    setTesting(true); setMsg(''); setIps([]);
    try {
      const res = await api.testProxy();
      setIps(res.ips || []);
      setMsg(res.success ? 'Each request left from a different IP' : (res.error || 'Test failed'));
    } catch (e) { setMsg(e.message); }
    setTesting(false);
  };

  if (loading) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-8">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-gray-900">Rotating proxy</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${enabled && configured ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
          {enabled && configured ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Each Deepgram connection opens through the proxy, so each call gets a new exit IP. The phone call itself stays on the SIP trunk. This proxy cannot carry SIP or call audio.
      </p>
      <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send Deepgram through the proxy
      </label>
      <label className="block text-xs font-medium text-gray-600 mb-1">HTTP proxy URL</label>
      <input
        type="password"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={configured ? `Saved (${host}). Paste a new URL to replace it.` : 'http://user:pass@host:port'}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 mb-3"
      />
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save proxy'}
        </button>
        <button onClick={handleTest} disabled={testing || !configured}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          {testing ? 'Testing...' : 'Test rotation'}
        </button>
        {msg && <span className="text-sm text-gray-600">{msg}</span>}
      </div>
      {ips.length > 0 && (
        <p className="text-xs text-gray-500 mt-3">Exit IPs: {ips.join('  →  ')}</p>
      )}
    </div>
  );
}

function DeepgramSettings() {
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState([]);
  const [status, setStatus] = useState({});
  const [keyInput, setKeyInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState({});

  const loadKeys = async () => {
    try {
      const data = await api.getDeepgramSettings();
      setKeys(data.keys || []);
      setStatus({ total: data.total, active: data.active, depleted: data.depleted, invalid: data.invalid, currentKey: data.currentKey });
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  useEffect(() => { loadKeys(); }, []);

  const handleAdd = async () => {
    if (!keyInput.trim()) return;
    setAdding(true); setMsg(''); setErr('');
    try {
      const res = await api.addDeepgramKey(keyInput.trim(), labelInput.trim());
      setMsg(res.message || 'Key added');
      setKeyInput(''); setLabelInput('');
      await loadKeys();
    } catch (e) { setErr(e.message || 'Failed to add key'); }
    setAdding(false);
  };

  const handleDelete = async (keyId) => {
    if (!confirm('Remove this API key from the pool?')) return;
    try {
      await api.deleteDeepgramKey(keyId);
      setMsg('Key removed');
      await loadKeys();
    } catch (e) { setErr(e.message); }
  };

  const handleReactivate = async (keyId) => {
    try {
      await api.reactivateDeepgramKey(keyId);
      setMsg('Key reactivated');
      await loadKeys();
    } catch (e) { setErr(e.message); }
  };

  const handleSetCurrent = async (keyId) => {
    try {
      await api.setCurrentDeepgramKey(keyId);
      setMsg('Active key updated');
      await loadKeys();
    } catch (e) { setErr(e.message); }
  };

  const handleTest = async (keyId) => {
    setTestingId(keyId);
    setTestResult({});
    try {
      const res = await api.testDeepgramKey(keyId);
      setTestResult({ [keyId]: res });
    } catch (e) { setTestResult({ [keyId]: { success: false, error: e.message } }); }
    setTestingId(null);
  };

  const statusColors = { active: 'bg-green-100 text-green-700', depleted: 'bg-orange-100 text-orange-700', invalid: 'bg-red-100 text-red-700', paused: 'bg-gray-100 text-gray-600' };

  if (loading) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <div className="flex items-center gap-3 mb-2">
        <Key className="w-5 h-5 text-violet-600" />
        <h2 className="text-lg font-semibold text-gray-900">API Keys</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Add multiple keys for auto-rotation. The moment a key is rejected for lack of credit (402), the system switches to the next active key. Keys are also checked every minute and retired before they run dry.
      </p>

      {/* Status summary */}
      <div className="flex gap-4 mb-4">
        <span className="px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">{status.active || 0} Active</span>
        <span className="px-3 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-700">{status.depleted || 0} Depleted</span>
        <span className="px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">{status.invalid || 0} Invalid</span>
        {status.currentKey && (
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
            Current: {status.currentKey.label || status.currentKey.id || status.currentKey.source}
          </span>
        )}
      </div>

      {/* Key list */}
      {keys.length > 0 && (
        <div className="space-y-2 mb-4">
          {keys.map((k) => (
            <div key={k.id} className={`flex items-center gap-3 p-3 rounded-lg border ${k.is_current ? 'border-violet-300 bg-violet-50' : 'border-gray-200'}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {k.is_current && <Star className="w-3.5 h-3.5 text-violet-600 flex-shrink-0" />}
                  <span className="font-medium text-sm text-gray-900 truncate">{k.label || 'Unnamed'}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[k.status] || 'bg-gray-100 text-gray-600'}`}>{k.status}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                  <code className="font-mono">{k.masked_key}</code>
                  {k.error_count_402 > 0 && <span className="text-orange-600">{k.error_count_402} credit rejection{k.error_count_402 === 1 ? '' : 's'}</span>}
                  {k.last_error && <span className="text-red-500 truncate">{k.last_error}</span>}
                  {testResult[k.id] && (
                    <span className={testResult[k.id].success ? 'text-green-600' : testResult[k.id].unreachable ? 'text-orange-600' : 'text-red-500'}>
                      {testResult[k.id].success
                        ? `Valid (${testResult[k.id].project})${typeof testResult[k.id].balance === 'number' ? ` — $${testResult[k.id].balance.toFixed(2)}` : ''}`
                        : testResult[k.id].error}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => handleTest(k.id)} disabled={testingId === k.id}
                  className="p-1.5 text-gray-400 hover:text-violet-600 hover:bg-violet-50 rounded transition" title="Test key">
                  {testingId === k.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                </button>
                {!k.is_current && k.status === 'active' && (
                  <button onClick={() => handleSetCurrent(k.id)}
                    className="p-1.5 text-gray-400 hover:text-violet-600 hover:bg-violet-50 rounded transition" title="Set as current">
                    <Star className="w-4 h-4" />
                  </button>
                )}
                {(k.status === 'depleted' || k.status === 'invalid') && (
                  <button onClick={() => handleReactivate(k.id)}
                    className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition" title="Reactivate">
                    <RefreshCw className="w-4 h-4" />
                  </button>
                )}
                <button onClick={() => handleDelete(k.id)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition" title="Remove">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {keys.length === 0 && (
        <div className="text-center py-6 text-gray-400 border border-dashed border-gray-200 rounded-lg mb-4">
          <Key className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No API keys configured. Add at least one to run campaigns.</p>
        </div>
      )}

      {/* Add new key */}
      <div className="border-t border-gray-200 pt-4">
        <p className="text-sm font-medium text-gray-700 mb-2">Add New Key</p>
        <div className="flex gap-2">
          <input
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder="Label (e.g. Account 1)"
            className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 outline-none"
          />
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="Paste API key..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-violet-500 outline-none"
          />
          <button onClick={handleAdd} disabled={adding || !keyInput.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm hover:bg-violet-700 disabled:opacity-50 transition">
            <Plus className="w-4 h-4" /> {adding ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>

      {msg && <p className="text-sm text-green-600 mt-3">{msg}</p>}
      {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
    </div>
  );
}

function GoogleSheetsSettings() {
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [credsInput, setCredsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getGoogleSheetsStatus().then(data => {
      setConfigured(data.configured);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true); setMsg(''); setErr('');
    try {
      const res = await api.saveGoogleSheetsCredentials(credsInput);
      setMsg(res.message || 'Saved');
      setConfigured(true);
      setCredsInput('');
    } catch (e) {
      setErr(e.message || 'Failed');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm('Remove Google Sheets credentials?')) return;
    try {
      await api.deleteGoogleSheetsCredentials();
      setConfigured(false);
      setMsg('Credentials removed');
    } catch (e) {
      setErr(e.message);
    }
  };

  if (loading) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mt-6">
      <div className="flex items-center gap-3 mb-4">
        <FileSpreadsheet className="w-5 h-5 text-green-600" />
        <h2 className="text-lg font-semibold text-gray-900">Google Sheets Integration</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Connect a Google service account to automatically push appointment data to Google Sheets.
        Link a Sheet ID on each campaign's settings to enable sync.
      </p>

      {configured ? (
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">
            <CheckCircle2 className="w-4 h-4" /> Credentials configured
          </span>
          <button onClick={handleDelete} className="flex items-center gap-1 text-sm text-red-600 hover:bg-red-50 px-3 py-2 rounded-lg transition">
            <Trash2 className="w-4 h-4" /> Remove
          </button>
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Service Account JSON</label>
          <textarea
            value={credsInput}
            onChange={(e) => setCredsInput(e.target.value)}
            rows={6}
            placeholder='Paste your service account JSON here (from Google Cloud Console)...'
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-green-500 outline-none"
          />
          <button
            onClick={handleSave}
            disabled={saving || !credsInput.trim()}
            className="mt-2 flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50 transition"
          >
            <Upload className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Credentials'}
          </button>
        </div>
      )}

      {msg && <p className="text-sm text-green-600 mt-2">{msg}</p>}
      {err && <p className="text-sm text-red-600 mt-2">{err}</p>}

      <div className="mt-4 p-3 bg-gray-50 rounded-lg text-xs text-gray-500 space-y-1">
        <p><strong>Setup:</strong></p>
        <p>1. Go to Google Cloud Console &gt; APIs &gt; Enable "Google Sheets API"</p>
        <p>2. Create a Service Account &gt; Keys &gt; Add Key &gt; JSON</p>
        <p>3. Paste the JSON above</p>
        <p>4. Share your Google Sheet with the service account email (Editor access)</p>
        <p>5. On each campaign, set the Google Sheet ID (from the sheet URL)</p>
      </div>
    </div>
  );
}

const EMPTY_TRUNK = {
  name: '', mode: 'trunk', username: '', password: '', server: '', port: 5060,
  transport: 'udp', callerId: '', trunkUsername: '', trunkAuth: 'ip', trunkHost: '', trunkPort: 5060,
  sourceIp: '', transferUri: '',
};

function TrunkForm({ trunk, onSave, onCancel, saving }) {
  const [form, setForm] = useState({ ...EMPTY_TRUNK, ...trunk });
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500";
  const selectCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 bg-white";
  const labelCls = "block text-xs font-medium text-gray-600 mb-1";

  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls}>Trunk Name</label>
        <input type="text" value={form.name} onChange={set('name')} className={inputCls} placeholder="e.g. MMD Spain, Dubai Trunk..." />
      </div>

      <div>
        <label className={labelCls}>Mode</label>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={() => setForm({ ...form, mode: 'account' })}
            className={`px-4 py-3 rounded-lg border-2 text-left transition ${form.mode === 'account' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
            <p className="text-sm font-semibold text-gray-800">SIP Account</p>
            <p className="text-xs text-gray-500 mt-0.5">REGISTER with username + password</p>
          </button>
          <button type="button" onClick={() => setForm({ ...form, mode: 'trunk' })}
            className={`px-4 py-3 rounded-lg border-2 text-left transition ${form.mode === 'trunk' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
            <p className="text-sm font-semibold text-gray-800">SIP Trunk</p>
            <p className="text-xs text-gray-500 mt-0.5">IP whitelist, or username and password</p>
          </button>
        </div>
      </div>

      {form.mode === 'account' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className={labelCls}>Username</label><input type="text" value={form.username} onChange={set('username')} className={inputCls} /></div>
            <div><label className={labelCls}>Password</label><input type="password" value={form.password} onChange={set('password')} className={inputCls} /></div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className={labelCls}>SIP Server</label><input type="text" value={form.server} onChange={set('server')} className={inputCls} /></div>
            <div><label className={labelCls}>Port</label><input type="text" value={form.port} onChange={set('port')} className={inputCls} /></div>
            <div><label className={labelCls}>Transport</label>
              <select value={form.transport} onChange={set('transport')} className={selectCls}>
                <option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option>
              </select>
            </div>
          </div>
          <div><label className={labelCls}>Caller ID</label><input type="text" value={form.callerId} onChange={set('callerId')} className={inputCls} placeholder="+15551234567" /></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Trunk authentication</label>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setForm({ ...form, trunkAuth: 'ip' })}
                className={`px-4 py-3 rounded-lg border-2 text-left transition ${form.trunkAuth !== 'credentials' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <p className="text-sm font-semibold text-gray-800">IP auth</p>
                <p className="text-xs text-gray-500 mt-0.5">The trunk allows your source IP. No password is sent.</p>
              </button>
              <button type="button" onClick={() => setForm({ ...form, trunkAuth: 'credentials' })}
                className={`px-4 py-3 rounded-lg border-2 text-left transition ${form.trunkAuth === 'credentials' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <p className="text-sm font-semibold text-gray-800">Username and password</p>
                <p className="text-xs text-gray-500 mt-0.5">The trunk challenges the call and Robocop answers with these credentials.</p>
              </button>
            </div>
          </div>
          <div className={form.trunkAuth === 'credentials' ? 'grid grid-cols-2 gap-4' : 'grid grid-cols-3 gap-4'}>
            <div><label className={labelCls}>Trunk Host / IP</label><input type="text" value={form.trunkHost} onChange={set('trunkHost')} className={inputCls} placeholder="193.111.199.30" /></div>
            <div><label className={labelCls}>Trunk Port</label><input type="text" value={form.trunkPort} onChange={set('trunkPort')} className={inputCls} placeholder="5060" /></div>
            {form.trunkAuth !== 'credentials' && (
              <div><label className={labelCls}>Source IP (your server)</label><input type="text" value={form.sourceIp} onChange={set('sourceIp')} className={inputCls} placeholder="193.23.126.238" /></div>
            )}
          </div>
          {form.trunkAuth === 'credentials' ? (
            <div className="grid grid-cols-2 gap-4">
              <div><label className={labelCls}>Username</label><input type="text" value={form.username} onChange={set('username')} className={inputCls} placeholder="Trunk username" /></div>
              <div><label className={labelCls}>Password</label><input type="password" value={form.password} onChange={set('password')} className={inputCls} placeholder="Trunk password" /></div>
            </div>
          ) : (
            <div>
              <label className={labelCls}>Trunk username (From header)</label>
              <input type="text" value={form.trunkUsername} onChange={set('trunkUsername')} className={inputCls} placeholder="Optional tech prefix" />
            </div>
          )}
          <div>
            <label className={labelCls}>Caller ID (optional)</label>
            <input type="text" value={form.callerId} onChange={set('callerId')} className={inputCls} placeholder="+34600000000" />
          </div>
          <p className="text-xs text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg">
            {form.trunkAuth === 'credentials'
              ? 'Calls are sent to the trunk IP and signed with the username and password. No REGISTER.'
              : 'Calls are sent to the trunk IP with no password. The source IP has to be allowed by the trunk.'}
          </p>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Transfer SIP URI</label>
        <input type="text" value={form.transferUri} onChange={set('transferUri')} className={inputCls} placeholder="sip:agent@provider.com" />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button onClick={() => onSave(form)} disabled={saving || !form.name.trim() || (form.mode === 'trunk' && form.trunkAuth === 'credentials' && (!form.username.trim() || !form.password))}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition disabled:opacity-50">
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {trunk?.id ? 'Update Trunk' : 'Create Trunk'}
        </button>
        <button onClick={onCancel} className="px-4 py-2.5 text-gray-600 hover:bg-gray-100 rounded-lg text-sm transition">Cancel</button>
      </div>
    </div>
  );
}

export default function Settings() {
  const { isSuperAdmin } = useAuth();
  const [trunks, setTrunks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(null);
  const [testLogs, setTestLogs] = useState([]);
  const [testResult, setTestResult] = useState(null);
  const [message, setMessage] = useState('');
  const logRef = useRef(null);

  const loadTrunks = () => {
    if (!isSuperAdmin) return;
    api.getSipTrunks().then(data => {
      setTrunks(Array.isArray(data) ? data : []);
    }).catch(() => setTrunks([])).finally(() => setLoading(false));
  };

  useEffect(() => { loadTrunks(); }, [isSuperAdmin]);

  if (!isSuperAdmin) return <Navigate to="/" replace />;

  const handleCreate = async (form) => {
    setSaving(true); setMessage('');
    try {
      await api.createSipTrunk(form);
      setCreating(false);
      loadTrunks();
      setMessage('Trunk created');
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const handleUpdate = async (form) => {
    setSaving(true); setMessage('');
    try {
      await api.updateSipTrunk(editing, form);
      setEditing(null);
      loadTrunks();
      setMessage('Trunk updated');
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete trunk "${name}"? Campaigns using it will fall back to the default trunk.`)) return;
    try {
      await api.deleteSipTrunk(id);
      loadTrunks();
      setMessage('Trunk deleted');
    } catch (e) { alert(e.message); }
  };

  const handleSetDefault = async (id) => {
    try {
      await api.setDefaultSipTrunk(id);
      loadTrunks();
      setMessage('Default trunk updated');
    } catch (e) { alert(e.message); }
  };

  const handleTest = async (id) => {
    setTesting(id); setTestLogs([]); setTestResult(null);
    try {
      const res = await api.testSipTrunk(id);
      setTestLogs(res.logs || []);
      setTestResult(res.success);
    } catch (e) {
      setTestLogs([{ level: 'error', message: e.message }]);
      setTestResult(false);
    }
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 100);
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
            <SettingsIcon className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Settings</h1>
            <p className="text-sm text-gray-500">API keys, SIP trunks, and integrations</p>
          </div>
        </div>
      </div>

      <DeepgramSettings />
      <ProxySettings />

      {message && <p className="text-sm text-green-600 mb-4">{message}</p>}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">SIP Trunks</h2>
        {!creating && !editing && (
          <button onClick={() => setCreating(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition">
            <Plus className="w-4 h-4" /> Add Trunk
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-white rounded-xl border border-indigo-200 shadow-sm p-6 mb-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2"><Plus className="w-4 h-4" /> New SIP Trunk</h2>
          <TrunkForm trunk={EMPTY_TRUNK} onSave={handleCreate} onCancel={() => setCreating(false)} saving={saving} />
        </div>
      )}

      {trunks.length === 0 && !creating && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-8 text-center">
          <Server className="w-8 h-8 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 font-medium">No SIP trunks configured</p>
          <p className="text-sm text-gray-400 mt-1">Add a trunk to start making calls</p>
        </div>
      )}

      {trunks.map(trunk => (
        <div key={trunk.id} className={`bg-white rounded-xl border shadow-sm mb-4 ${trunk.is_default ? 'border-indigo-300' : 'border-gray-200'}`}>
          {editing === trunk.id ? (
            <div className="p-6">
              <h2 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2"><Edit2 className="w-4 h-4" /> Edit: {trunk.name}</h2>
              <TrunkForm trunk={trunk} onSave={handleUpdate} onCancel={() => setEditing(null)} saving={saving} />
            </div>
          ) : (
            <div className="px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${trunk.is_default ? 'bg-indigo-500' : 'bg-gray-300'}`} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{trunk.name}</span>
                      {trunk.is_default && (
                        <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <Star className="w-3 h-3" /> Default
                        </span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${trunk.mode === 'trunk' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                        {trunk.mode === 'trunk' ? (trunk.trunkAuth === 'credentials' ? 'Username + password' : 'IP auth') : 'SIP Account'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {trunk.mode === 'trunk'
                        ? `${trunk.trunkHost}:${trunk.trunkPort} → ${trunk.trunkAuth === 'credentials' ? `user ${trunk.username || trunk.trunkUsername || '(not set)'}` : `Source: ${trunk.sourceIp || '(not set)'}`}`
                        : `${trunk.username}@${trunk.server}:${trunk.port}`
                      }
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!trunk.is_default && (
                    <button onClick={() => handleSetDefault(trunk.id)} title="Set as default"
                      className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition">
                      <Star className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={() => handleTest(trunk.id)} title="Test connection"
                    className="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition">
                    <Play className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditing(trunk.id)} title="Edit"
                    className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(trunk.id, trunk.name)} title="Delete"
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {testing === trunk.id && testLogs.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-600">Test Results</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      testResult === true ? 'bg-green-100 text-green-700' : testResult === false ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                    }`}>{testResult === true ? 'PASS' : testResult === false ? 'FAIL' : 'RUNNING'}</span>
                  </div>
                  <div ref={logRef} className="max-h-48 overflow-y-auto font-mono text-xs space-y-1">
                    {testLogs.map((log, i) => {
                      const Icon = log.level === 'success' ? CheckCircle2 : log.level === 'error' ? XCircle : log.level === 'warn' ? AlertTriangle : Info;
                      const color = log.level === 'success' ? 'text-green-600' : log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-amber-600' : 'text-gray-500';
                      return (
                        <div key={i} className={`flex items-start gap-2 ${color}`}>
                          <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <pre className="whitespace-pre-wrap break-all">{log.message}</pre>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      <GoogleSheetsSettings />
    </div>
  );
}
