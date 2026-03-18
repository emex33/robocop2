import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import {
  PhoneIncoming, Search, Download, ChevronLeft, ChevronRight,
  Clock, CheckCircle2, XCircle, PhoneOff, Filter, X, Play,
  MessageSquare, Phone, User, Building2, Globe
} from 'lucide-react';

const STATUS_CONFIG = {
  pending:        { label: 'Pending',        color: 'bg-amber-100 text-amber-700',   icon: Clock },
  called_back:    { label: 'Called Back',     color: 'bg-blue-100 text-blue-700',     icon: Phone },
  converted:      { label: 'Converted',      color: 'bg-green-100 text-green-700',   icon: CheckCircle2 },
  no_answer:      { label: 'No Answer',      color: 'bg-gray-100 text-gray-600',     icon: PhoneOff },
  not_interested: { label: 'Not Interested', color: 'bg-red-100 text-red-700',       icon: XCircle },
};

function formatDuration(s) {
  if (!s) return '0s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Callbacks() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: '', campaign_id: '', search: '', date_from: '', date_to: '', page: 1 });
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showTranscript, setShowTranscript] = useState(null);

  const fetchCallbacks = useCallback(() => {
    setLoading(true);
    api.getCallbacks(filters)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { fetchCallbacks(); }, [fetchCallbacks]);

  useEffect(() => {
    api.getCampaigns().then(c => setCampaigns(Array.isArray(c) ? c : c?.campaigns || [])).catch(() => {});
  }, []);

  const updateStatus = async (id, callback_status) => {
    setSaving(true);
    try {
      await api.updateCallback(id, { callback_status });
      fetchCallbacks();
      if (selected?.id === id) setSelected(prev => ({ ...prev, callback_status }));
    } catch {} finally { setSaving(false); }
  };

  const saveNotes = async (id) => {
    setSaving(true);
    try {
      await api.updateCallback(id, { callback_notes: editNotes });
      fetchCallbacks();
      if (selected?.id === id) setSelected(prev => ({ ...prev, callback_notes: editNotes }));
    } catch {} finally { setSaving(false); }
  };

  const stats = data?.stats || {};
  const callbacks = data?.callbacks || [];

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Callbacks</h1>
          <p className="text-sm text-gray-500 mt-0.5">Leads who were interested but couldn't talk — follow up to convert</p>
        </div>
        <button
          onClick={() => api.exportCallbacksCsv(filters)}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Total Callbacks" value={stats.total || 0} color="indigo" />
        <StatCard label="Pending" value={stats.pending || 0} color="amber"
          onClick={() => setFilters(f => ({ ...f, status: f.status === 'pending' ? '' : 'pending', page: 1 }))}
          active={filters.status === 'pending'} />
        <StatCard label="Called Back" value={stats.called_back || 0} color="blue"
          onClick={() => setFilters(f => ({ ...f, status: f.status === 'called_back' ? '' : 'called_back', page: 1 }))}
          active={filters.status === 'called_back'} />
        <StatCard label="Converted" value={stats.converted || 0} color="green"
          onClick={() => setFilters(f => ({ ...f, status: f.status === 'converted' ? '' : 'converted', page: 1 }))}
          active={filters.status === 'converted'} />
        <StatCard label="No Answer" value={stats.no_answer || 0} color="gray"
          onClick={() => setFilters(f => ({ ...f, status: f.status === 'no_answer' ? '' : 'no_answer', page: 1 }))}
          active={filters.status === 'no_answer'} />
        <StatCard label="Not Interested" value={stats.not_interested || 0} color="red"
          onClick={() => setFilters(f => ({ ...f, status: f.status === 'not_interested' ? '' : 'not_interested', page: 1 }))}
          active={filters.status === 'not_interested'} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search name, phone, summary..."
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
        <select
          value={filters.campaign_id}
          onChange={e => setFilters(f => ({ ...f, campaign_id: e.target.value, page: 1 }))}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
        >
          <option value="">All Campaigns</option>
          {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={filters.date_from}
            onChange={e => setFilters(f => ({ ...f, date_from: e.target.value, page: 1 }))}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            title="From date"
          />
          <span className="text-gray-400 text-sm">to</span>
          <input
            type="date"
            value={filters.date_to}
            onChange={e => setFilters(f => ({ ...f, date_to: e.target.value, page: 1 }))}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            title="To date"
          />
        </div>
        {(filters.status || filters.campaign_id || filters.search || filters.date_from || filters.date_to) && (
          <button
            onClick={() => setFilters({ status: '', campaign_id: '', search: '', date_from: '', date_to: '', page: 1 })}
            className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 hover:text-red-700"
          >
            <X className="w-3.5 h-3.5" /> Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center">
            <div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full" />
          </div>
        ) : callbacks.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            <PhoneIncoming className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p className="text-lg font-medium">No callbacks found</p>
            <p className="text-sm mt-1">Callback leads will appear here when leads request a call back</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Lead</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Phone</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Campaign</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Call Duration</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {callbacks.map(cb => {
                  const st = STATUS_CONFIG[cb.callback_status] || STATUS_CONFIG.pending;
                  const StIcon = st.icon;
                  return (
                    <tr key={cb.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => { setSelected(cb); setEditNotes(cb.callback_notes || ''); }}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{cb.lead_name || '—'}</div>
                        {cb.lead_company && <div className="text-xs text-gray-400">{cb.lead_company}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono text-gray-600">{cb.phone}</td>
                      <td className="px-4 py-3 text-gray-600">{cb.campaign_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{formatDuration(cb.duration_seconds)}</td>
                      <td className="px-4 py-3 text-gray-500">{formatDate(cb.started_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${st.color}`}>
                          <StIcon className="w-3 h-3" />
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <select
                          value={cb.callback_status || 'pending'}
                          onChange={e => updateStatus(cb.id, e.target.value)}
                          disabled={saving}
                          className="px-2 py-1 text-xs border border-gray-200 rounded-lg bg-white"
                        >
                          <option value="pending">Pending</option>
                          <option value="called_back">Called Back</option>
                          <option value="converted">Converted</option>
                          <option value="no_answer">No Answer</option>
                          <option value="not_interested">Not Interested</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">
              Showing {((data.page - 1) * 50) + 1}–{Math.min(data.page * 50, data.total)} of {data.total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}
                disabled={data.page <= 1}
                className="p-1.5 rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}
                disabled={data.page >= data.pages}
                className="p-1.5 rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/20" />
          <div
            className="relative w-full max-w-lg bg-white shadow-xl h-full overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Callback Details</h2>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-gray-100">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Lead info */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center">
                    <User className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{selected.lead_name || 'Unknown'}</h3>
                    <p className="text-sm font-mono text-gray-500">{selected.phone}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {selected.email && (
                    <div><span className="text-gray-400">Email:</span> <span className="text-gray-700">{selected.email}</span></div>
                  )}
                  {selected.lead_company && (
                    <div className="flex items-center gap-1"><Building2 className="w-3.5 h-3.5 text-gray-400" /> <span className="text-gray-700">{selected.lead_company}</span></div>
                  )}
                  {selected.country && (
                    <div className="flex items-center gap-1"><Globe className="w-3.5 h-3.5 text-gray-400" /> <span className="text-gray-700">{selected.country}</span></div>
                  )}
                  <div><span className="text-gray-400">Campaign:</span> <span className="text-gray-700">{selected.campaign_name || '—'}</span></div>
                  <div><span className="text-gray-400">Call Duration:</span> <span className="text-gray-700">{formatDuration(selected.duration_seconds)}</span></div>
                  <div><span className="text-gray-400">Called At:</span> <span className="text-gray-700">{formatDate(selected.started_at)}</span></div>
                </div>
              </div>

              {/* AI Summary */}
              {selected.call_summary && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">AI Call Summary</h4>
                  <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 whitespace-pre-wrap">{selected.call_summary}</div>
                </div>
              )}

              {/* Transcript */}
              {selected.transcript_json && (
                <div>
                  <button
                    onClick={() => setShowTranscript(showTranscript ? null : selected.id)}
                    className="flex items-center gap-2 text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                  >
                    <MessageSquare className="w-4 h-4" />
                    {showTranscript === selected.id ? 'Hide Transcript' : 'Show Transcript'}
                  </button>
                  {showTranscript === selected.id && (
                    <div className="mt-2 bg-gray-50 rounded-lg p-3 max-h-60 overflow-y-auto space-y-2">
                      {JSON.parse(selected.transcript_json || '[]').map((t, i) => (
                        <div key={i} className={`text-xs ${t.role === 'assistant' ? 'text-indigo-600' : 'text-gray-700'}`}>
                          <span className="font-semibold">{t.role === 'assistant' ? 'AI' : 'Lead'}:</span> {t.content || t.text || ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Status update */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Update Status</h4>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
                    const Icon = cfg.icon;
                    const isActive = (selected.callback_status || 'pending') === key;
                    return (
                      <button
                        key={key}
                        onClick={() => updateStatus(selected.id, key)}
                        disabled={saving}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                          isActive ? cfg.color + ' border-current' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Notes */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-2">Follow-up Notes</h4>
                <textarea
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  placeholder="Add notes about this callback..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                />
                <button
                  onClick={() => saveNotes(selected.id)}
                  disabled={saving}
                  className="mt-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Notes'}
                </button>
              </div>

              {/* Recording */}
              {selected.recording_url && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Recording</h4>
                  <audio controls className="w-full" src={selected.recording_url} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, onClick, active }) {
  const colors = {
    indigo: 'border-indigo-200 bg-indigo-50',
    amber: 'border-amber-200 bg-amber-50',
    blue: 'border-blue-200 bg-blue-50',
    green: 'border-green-200 bg-green-50',
    gray: 'border-gray-200 bg-gray-50',
    red: 'border-red-200 bg-red-50',
  };
  const textColors = {
    indigo: 'text-indigo-700',
    amber: 'text-amber-700',
    blue: 'text-blue-700',
    green: 'text-green-700',
    gray: 'text-gray-700',
    red: 'text-red-700',
  };

  return (
    <div
      onClick={onClick}
      className={`rounded-xl border p-4 transition ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${
        active ? colors[color] : 'bg-white border-gray-200'
      }`}
    >
      <p className="text-xs text-gray-500 font-medium">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${active ? textColors[color] : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
