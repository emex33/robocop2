import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { Users, DollarSign, Phone, Clock, X, Plus, ChevronRight, Shield, Settings, Save, Play, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';

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
        </div>
      </div>
    </div>
  );
}
