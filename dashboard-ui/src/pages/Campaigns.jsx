import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Plus, Megaphone, Users, Phone, Settings, BarChart3, Play, Pause } from 'lucide-react';

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    Promise.all([api.getCampaigns(), api.getAgents()])
      .then(([c, a]) => { setCampaigns(c); setAgents(a); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleDelete = async (id) => {
    if (!confirm('Delete this campaign and all its data?')) return;
    await api.deleteCampaign(id);
    load();
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your outbound calling campaigns</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition">
          <Plus className="w-4 h-4" /> Add Campaign
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <Megaphone className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No campaigns yet. Create your first campaign.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {campaigns.map(c => (
            <CampaignCard key={c.id} campaign={c} navigate={navigate} onDelete={() => handleDelete(c.id)} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateCampaignModal
          agents={agents}
          onClose={() => setShowCreate(false)}
          onCreated={(campaign) => { setShowCreate(false); navigate(`/campaigns/${campaign.id}`); }}
        />
      )}
    </div>
  );
}

function CampaignCard({ campaign: c, navigate, onDelete }) {
  const statusColors = {
    running: 'bg-green-100 text-green-700',
    paused: 'bg-amber-100 text-amber-700',
    completed: 'bg-blue-100 text-blue-700',
    draft: 'bg-gray-100 text-gray-600',
  };

  const open = (tab) => navigate(`/campaigns/${c.id}${tab ? `?tab=${tab}` : ''}`, { state: { campaign: c } });

  return (
    <div
      className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition cursor-pointer"
      onClick={() => open()}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-semibold text-gray-900 text-lg">{c.name}</h3>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-xs text-gray-400 hover:text-red-500 transition">Delete</button>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-2.5 py-0.5 rounded-full flex items-center gap-1">
          ↗ {c.type || 'Outbound'}
        </span>
        <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${statusColors[c.status] || statusColors.draft}`}>
          {c.status === 'running' ? '● Running' : c.status === 'paused' ? '● Paused' : c.status}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-3 text-xs mb-4">
        <div>
          <p className="text-gray-400">agent</p>
          <p className="text-gray-700 font-medium truncate">{c.agent_name || '—'}</p>
        </div>
        <div>
          <p className="text-gray-400">Dialer</p>
          <p className="text-gray-700 font-medium">{c.dialer_mode || 'Single'}</p>
        </div>
        <div>
          <p className="text-gray-400">Leads</p>
          <p className="text-gray-700 font-medium">{c.total_leads || 0}</p>
        </div>
        <div>
          <p className="text-gray-400">Calls</p>
          <p className="text-gray-700 font-medium">{c.total_calls || 0}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
        <button onClick={() => open('leads')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-600 px-2.5 py-1.5 rounded-lg hover:bg-indigo-50 transition">
          <Users className="w-3.5 h-3.5" /> Leads
        </button>
        <button onClick={() => open('calls')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-600 px-2.5 py-1.5 rounded-lg hover:bg-indigo-50 transition">
          <Phone className="w-3.5 h-3.5" /> Calls
        </button>
        <button onClick={() => open('settings')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-600 px-2.5 py-1.5 rounded-lg hover:bg-indigo-50 transition">
          <Settings className="w-3.5 h-3.5" /> Settings
        </button>
        <button onClick={() => open('analytics')}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-600 px-2.5 py-1.5 rounded-lg hover:bg-indigo-50 transition">
          <BarChart3 className="w-3.5 h-3.5" /> Analytics
        </button>
      </div>
    </div>
  );
}

function CreateCampaignModal({ agents, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) return setError('Campaign name is required');
    setSaving(true);
    try {
      const campaign = await api.createCampaign({ name, agent_id: agentId || null });
      onCreated(campaign);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">Create Campaign</h2>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 text-red-600 text-sm rounded-lg px-4 py-3">{error}</div>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              placeholder="My Campaign" autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none">
              <option value="">Select an agent...</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition">Cancel</button>
          <button onClick={handleCreate} disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition">
            {saving ? 'Creating...' : 'Create Campaign'}
          </button>
        </div>
      </div>
    </div>
  );
}
