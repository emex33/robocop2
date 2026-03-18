import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Users, DollarSign, Phone, Clock, X, Plus, ChevronRight, Shield } from 'lucide-react';

function fmt$(v) { return '$' + (v || 0).toFixed(2); }
function fmtMin(s) { return ((s || 0) / 60).toFixed(1) + ' min'; }

export default function AdminBilling() {
  const [users, setUsers] = useState([]);
  const [overview, setOverview] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [showAddCredits, setShowAddCredits] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.adminGetUsers(), api.adminGetBilling()])
      .then(([u, o]) => { setUsers(u); setOverview(o); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

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

        {/* Stats */}
        <div className="px-6 py-4 border-b border-gray-100 grid grid-cols-3 gap-4 flex-shrink-0">
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
        <div className="flex-1 overflow-y-auto p-6">
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
      </div>
    </div>
  );
}
