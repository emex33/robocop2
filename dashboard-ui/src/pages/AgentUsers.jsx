import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { 
  Users, Plus, Edit2, Trash2, X, Check, UserCheck, UserX,
  Phone, Copy, Eye, EyeOff
} from 'lucide-react';

export default function AgentUsers() {
  const [users, setUsers] = useState([]);
  const [sipAgents, setSipAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [adminCode, setAdminCode] = useState('');

  useEffect(() => {
    loadData();
    // Get admin code from token
    const token = localStorage.getItem('robocop_token');
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setAdminCode(payload.userId);
      } catch (e) {}
    }
  }, []);

  const loadData = async () => {
    try {
      const [usersData, agentsData] = await Promise.all([
        api.getAgentUsers(),
        api.getSipAgents()
      ]);
      setUsers(usersData);
      setSipAgents(agentsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (user) => {
    if (!confirm(`Delete agent "${user.name}"? They will no longer be able to login.`)) return;
    try {
      await api.deleteAgentUser(user.id);
      loadData();
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  };

  const handleToggleActive = async (user) => {
    try {
      await api.updateAgentUser(user.id, { is_active: user.is_active ? 0 : 1 });
      loadData();
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert('Copied to clipboard!');
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agent Users</h1>
          <p className="text-gray-500 text-sm">Create login credentials for softphone agents</p>
        </div>
        <button
          onClick={() => { setEditingUser(null); setShowModal(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          <Plus size={18} /> Add Agent User
        </button>
      </div>

      {/* Admin Code Info Box */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-blue-900">Agent Login Info</h3>
            <p className="text-sm text-blue-700 mt-1">
              Agents use these credentials to login to the softphone. Share the Admin Code with your agents.
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-blue-600 mb-1">Admin Code</p>
            <div className="flex items-center gap-2">
              <code className="px-3 py-1 bg-blue-100 rounded font-mono text-blue-900">{adminCode}</code>
              <button
                onClick={() => copyToClipboard(adminCode)}
                className="p-1.5 text-blue-600 hover:bg-blue-100 rounded"
                title="Copy"
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Agent</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Username</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">SIP Account</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Last Login</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-600 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                  <Users size={40} className="mx-auto mb-2 opacity-50" />
                  <p>No agent users yet</p>
                  <p className="text-xs mt-1">Create users so agents can login to the softphone</p>
                </td>
              </tr>
            ) : users.map(user => (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{user.name}</div>
                  {user.email && <div className="text-xs text-gray-500">{user.email}</div>}
                </td>
                <td className="px-4 py-3">
                  <code className="text-sm bg-gray-100 px-2 py-0.5 rounded">{user.username}</code>
                </td>
                <td className="px-4 py-3">
                  {user.sip_agent_name ? (
                    <div className="flex items-center gap-2">
                      <Phone size={14} className="text-gray-400" />
                      <span className="text-sm">{user.sip_agent_name}</span>
                      {user.sip_agent_status === 'online' && (
                        <span className="w-2 h-2 rounded-full bg-green-500" />
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-400 text-sm">Not assigned</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {user.is_active ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                      <UserCheck size={12} /> Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-full">
                      <UserX size={12} /> Inactive
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Never'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => handleToggleActive(user)}
                      className={`p-1.5 rounded ${user.is_active ? 'text-gray-500 hover:bg-gray-100' : 'text-green-600 hover:bg-green-50'}`}
                      title={user.is_active ? 'Deactivate' : 'Activate'}
                    >
                      {user.is_active ? <UserX size={16} /> : <UserCheck size={16} />}
                    </button>
                    <button
                      onClick={() => { setEditingUser(user); setShowModal(true); }}
                      className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                      title="Edit"
                    >
                      <Edit2 size={16} />
                    </button>
                    <button
                      onClick={() => handleDelete(user)}
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                      title="Delete"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <AgentUserModal
          user={editingUser}
          sipAgents={sipAgents}
          onClose={() => setShowModal(false)}
          onSave={() => { setShowModal(false); loadData(); }}
        />
      )}
    </div>
  );
}

function AgentUserModal({ user, sipAgents, onClose, onSave }) {
  const [form, setForm] = useState({
    username: user?.username || '',
    password: '',
    name: user?.name || '',
    email: user?.email || '',
    sip_agent_id: user?.sip_agent_id || '',
    role: user?.role || 'agent',
  });
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSave = async () => {
    if (!form.username) {
      alert('Username is required');
      return;
    }
    if (!user && !form.password) {
      alert('Password is required for new users');
      return;
    }

    setSaving(true);
    try {
      const data = { ...form };
      if (!data.password) delete data.password;
      if (!data.sip_agent_id) data.sip_agent_id = null;
      
      if (user) {
        await api.updateAgentUser(user.id, data);
      } else {
        await api.createAgentUser(data);
      }
      onSave();
    } catch (err) {
      alert('Failed to save: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{user ? 'Edit Agent User' : 'Add Agent User'}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Agent's full name"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username *</label>
            <input
              type="text"
              value={form.username}
              onChange={e => setForm({ ...form, username: e.target.value })}
              placeholder="login_username"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password {user ? '(leave empty to keep current)' : '*'}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                placeholder="••••••••"
                className={inputCls + " pr-10"}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email (optional)</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="agent@company.com"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assigned SIP Account</label>
            <select
              value={form.sip_agent_id}
              onChange={e => setForm({ ...form, sip_agent_id: e.target.value })}
              className={inputCls}
            >
              <option value="">-- Not assigned --</option>
              {sipAgents.map(agent => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.sip_username})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Link this user to a SIP account for making/receiving calls
            </p>
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
            {saving ? 'Saving...' : user ? 'Save Changes' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  );
}
