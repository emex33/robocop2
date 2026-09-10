import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import {
  Search, Download, Filter, Phone, ChevronLeft, ChevronRight, X, Eye,
  Clock, PhoneForwarded, PhoneOff, CalendarCheck, Bot, AlertCircle,
  MessageSquare, ArrowUpDown, RotateCcw
} from 'lucide-react';

const OUTCOME_CONFIG = {
  transferred: { label: 'Transferred', color: 'bg-blue-100 text-blue-700', icon: PhoneForwarded },
  appointment_set: { label: 'Appointment', color: 'bg-green-100 text-green-700', icon: CalendarCheck },
  interested: { label: 'Interested', color: 'bg-emerald-100 text-emerald-700', icon: Phone },
  not_interested: { label: 'Not Interested', color: 'bg-gray-100 text-gray-600', icon: PhoneOff },
  no_answer: { label: 'No Answer', color: 'bg-yellow-100 text-yellow-700', icon: Phone },
  voicemail: { label: 'Voicemail', color: 'bg-orange-100 text-orange-700', icon: MessageSquare },
  callback: { label: 'Callback', color: 'bg-purple-100 text-purple-700', icon: RotateCcw },
  error: { label: 'Error', color: 'bg-red-100 text-red-700', icon: AlertCircle },
  lead_hangup: { label: 'Lead Hangup', color: 'bg-rose-100 text-rose-700', icon: PhoneOff },
  test_hangup: { label: 'Test Hangup', color: 'bg-gray-100 text-gray-500', icon: PhoneOff },
  did_not_call: { label: 'Not Called', color: 'bg-slate-100 text-slate-600', icon: Phone },
  timeout: { label: 'Timeout', color: 'bg-amber-100 text-amber-700', icon: Clock },
  unknown: { label: 'Unknown', color: 'bg-gray-100 text-gray-500', icon: Phone },
};

function OutcomeBadge({ outcome }) {
  const cfg = OUTCOME_CONFIG[outcome] || OUTCOME_CONFIG.unknown;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function formatDuration(s) {
  if (!s) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatDate(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function Calls() {
  const [data, setData] = useState({ calls: [], total: 0, page: 1, pages: 1, stats: {} });
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCall, setSelectedCall] = useState(null);

  // Filters
  const [filters, setFilters] = useState({
    campaign_id: '',
    outcome: '',
    date_from: '',
    date_to: '',
    search: '',
    sort: 'started_at',
    order: 'desc',
  });
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    api.getCampaigns().then(setCampaigns).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api.getCalls({ ...filters, page, limit: 50 })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filters, page]);

  useEffect(load, [load]);

  const setFilter = (key, val) => {
    setFilters(prev => ({ ...prev, [key]: val }));
    setPage(1);
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setFilter('search', searchInput);
  };

  const clearFilters = () => {
    setFilters({ campaign_id: '', outcome: '', date_from: '', date_to: '', search: '', sort: 'started_at', order: 'desc' });
    setSearchInput('');
    setPage(1);
  };

  const toggleSort = (col) => {
    setFilters(prev => ({
      ...prev,
      sort: col,
      order: prev.sort === col && prev.order === 'desc' ? 'asc' : 'desc',
    }));
  };

  const hasActiveFilters = filters.campaign_id || filters.outcome || filters.date_from || filters.date_to || filters.search;

  const stats = data.stats || {};
  const allOutcomes = Object.keys(OUTCOME_CONFIG);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Call Logs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data.total.toLocaleString()} calls
            {stats.avg_duration ? ` · Avg ${formatDuration(stats.avg_duration)}` : ''}
            {stats.total_duration ? ` · Total ${formatDuration(stats.total_duration)}` : ''}
            {stats.total_cost ? ` · Cost $${stats.total_cost.toFixed(2)}` : ''}
          </p>
        </div>
        <button
          onClick={() => api.exportCallsCsv(filters)}
          className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-green-700 transition"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-5">
        {[
          { label: 'Total', value: stats.total_calls, color: 'text-gray-900' },
          { label: 'Transfers', value: stats.transfers, color: 'text-blue-600' },
          { label: 'Appointments', value: stats.appointments, color: 'text-green-600' },
          { label: 'Interested', value: stats.interested, color: 'text-emerald-600' },
          { label: 'Not Interested', value: stats.not_interested, color: 'text-gray-500' },
          { label: 'No Answer', value: stats.no_answer, color: 'text-yellow-600' },
          { label: 'Callbacks', value: stats.callbacks, color: 'text-purple-600' },
          { label: 'Errors', value: stats.errors, color: 'text-red-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <p className={`text-lg font-bold ${s.color}`}>{s.value ?? 0}</p>
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-5">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-[200px]">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Search phone, name, notes..."
                className="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {searchInput && (
                <button type="button" onClick={() => { setSearchInput(''); setFilter('search', ''); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </form>

          {/* Campaign filter */}
          <select
            value={filters.campaign_id}
            onChange={e => setFilter('campaign_id', e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 min-w-[180px]"
          >
            <option value="">All Campaigns</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          {/* Outcome filter */}
          <select
            value={filters.outcome}
            onChange={e => setFilter('outcome', e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 min-w-[160px]"
          >
            <option value="">All Outcomes</option>
            {allOutcomes.map(o => <option key={o} value={o}>{OUTCOME_CONFIG[o].label}</option>)}
          </select>

          {/* Toggle more filters */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition ${showFilters ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
          >
            <Filter className="w-4 h-4" /> Filters
          </button>

          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-sm text-red-500 hover:text-red-600 font-medium">
              Clear all
            </button>
          )}
        </div>

        {/* Extended filters */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 font-medium">From</label>
              <input
                type="date"
                value={filters.date_from}
                onChange={e => setFilter('date_from', e.target.value)}
                className="px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 font-medium">To</label>
              <input
                type="date"
                value={filters.date_to}
                onChange={e => setFilter('date_to', e.target.value)}
                className="px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {[
                  { key: 'started_at', label: 'Date/Time' },
                  { key: 'phone', label: 'Phone' },
                  { key: 'lead_name', label: 'Lead' },
                  { key: null, label: 'Campaign' },
                  { key: 'outcome', label: 'Outcome' },
                  { key: 'duration', label: 'Duration' },
                  { key: null, label: 'Cost' },
                  { key: null, label: 'Summary' },
                  { key: null, label: '' },
                ].map((col, i) => (
                  <th
                    key={i}
                    className={`px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider ${col.key ? 'cursor-pointer hover:text-gray-700 select-none' : ''}`}
                    onClick={() => col.key && toggleSort(col.key)}
                  >
                    <span className="flex items-center gap-1">
                      {col.label}
                      {col.key && filters.sort === col.key && (
                        <ArrowUpDown className="w-3 h-3 text-indigo-500" />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-gray-400">
                    <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full mx-auto" />
                  </td>
                </tr>
              ) : data.calls.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-gray-400">
                    <Phone className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    <p>No calls found</p>
                    {hasActiveFilters && <p className="text-xs mt-1">Try adjusting your filters</p>}
                  </td>
                </tr>
              ) : data.calls.map(call => (
                <tr key={call.id} className="hover:bg-gray-50/50 transition">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <p className="font-medium text-gray-900">{formatDate(call.started_at)}</p>
                    <p className="text-xs text-gray-400">{formatTime(call.started_at)}</p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-gray-700 text-xs">{call.phone}</td>
                  <td className="px-4 py-3">
                    <p className="text-gray-900 font-medium truncate max-w-[160px]">{call.lead_name || '—'}</p>
                    {call.email && <p className="text-xs text-gray-400 truncate max-w-[160px]">{call.email}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-gray-600 text-xs truncate max-w-[140px]">{call.campaign_name || '—'}</p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <OutcomeBadge outcome={call.outcome} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">
                    {formatDuration(call.duration_seconds)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {call.call_cost > 0 ? (
                      <span className="text-xs font-medium text-gray-700">${call.call_cost.toFixed(3)}</span>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-gray-500 text-xs truncate max-w-[200px]">
                      {call.call_summary || call.notes || '—'}
                    </p>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <button
                      onClick={() => setSelectedCall(call)}
                      className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                      title="View details"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">
              Showing {((page - 1) * 50) + 1}–{Math.min(page * 50, data.total)} of {data.total.toLocaleString()}
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 transition"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {Array.from({ length: Math.min(data.pages, 7) }, (_, i) => {
                let p;
                if (data.pages <= 7) p = i + 1;
                else if (page <= 4) p = i + 1;
                else if (page >= data.pages - 3) p = data.pages - 6 + i;
                else p = page - 3 + i;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-8 h-8 rounded text-sm font-medium transition ${p === page ? 'bg-indigo-600 text-white' : 'hover:bg-gray-100 text-gray-600'}`}
                  >
                    {p}
                  </button>
                );
              })}
              <button
                onClick={() => setPage(p => Math.min(data.pages, p + 1))}
                disabled={page >= data.pages}
                className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30 transition"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Call Detail Modal */}
      {selectedCall && (
        <CallDetailModal call={selectedCall} onClose={() => setSelectedCall(null)} />
      )}
    </div>
  );
}

function CallDetailModal({ call, onClose }) {
  const [tab, setTab] = useState('info');
  const [detail, setDetail] = useState(call);
  const { isSuperAdmin } = useAuth();

  useEffect(() => {
    let cancelled = false;
    api.getCall(call.id).then(full => { if (!cancelled) setDetail(full); }).catch(() => {});
    return () => { cancelled = true; };
  }, [call.id]);

  const infoItems = [
    { label: 'Phone', value: detail.phone },
    { label: 'Lead', value: detail.lead_name || '—' },
    { label: 'Email', value: detail.email || '—' },
    { label: 'Campaign', value: detail.campaign_name || '—' },
    ...(isSuperAdmin ? [{ label: 'AI Agent', value: detail.agent_name || '—' }] : []),
    { label: 'Outcome', value: detail.outcome },
    { label: 'Started', value: detail.started_at ? `${formatDate(detail.started_at)} ${formatTime(detail.started_at)}` : '—' },
    { label: 'Ended', value: detail.ended_at ? `${formatDate(detail.ended_at)} ${formatTime(detail.ended_at)}` : '—' },
    ...(detail.call_cost > 0 ? (isSuperAdmin
      ? [{ label: 'Call Cost', value: `$${detail.call_cost.toFixed(4)} (VoIP: $${(detail.voip_cost||0).toFixed(4)}, AI: $${(detail.ai_cost||0).toFixed(4)})` }]
      : [{ label: 'Call Cost', value: `$${detail.call_cost.toFixed(4)}` }]
    ) : []),
    ...(isSuperAdmin && detail.ai_duration_seconds > 0 ? [{ label: 'AI Talk Time', value: `${(detail.ai_duration_seconds / 60).toFixed(1)} min` }] : []),
    ...(detail.transferred_to ? [{ label: 'Transferred To', value: detail.transferred_to }] : []),
    ...(detail.error_message ? [{ label: 'Error', value: detail.error_message }] : []),
  ];

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900 text-lg">Call Details</h2>
            <p className="text-sm text-gray-500">{call.phone} · {formatDate(call.started_at)} {formatTime(call.started_at)}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
          {[
            { id: 'info', label: 'Info' },
            { id: 'transcript', label: 'Transcript' },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              {t.id === 'transcript' && detail.transcript?.length > 0 && (
                <span className="ml-1.5 text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">{detail.transcript.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'info' && (
            <div className="space-y-5">
              {/* Top row */}
              <div className="flex items-center gap-3">
                <OutcomeBadge outcome={detail.outcome} />
                <span className="text-sm text-gray-500">{formatDuration(detail.duration_seconds)}</span>
              </div>

              {/* Details grid */}
              <div className="grid grid-cols-2 gap-4">
                {infoItems.map(item => (
                  <div key={item.label}>
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-0.5">{item.label}</p>
                    <p className="text-sm text-gray-900">{item.value}</p>
                  </div>
                ))}
              </div>

              {/* Summary */}
              {detail.call_summary && (
                <div>
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">Call Summary</p>
                  <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 leading-relaxed">{detail.call_summary}</p>
                </div>
              )}

              {/* Notes */}
              {detail.notes && (
                <div>
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">Notes</p>
                  <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 leading-relaxed">{detail.notes}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'transcript' && (
            <div className="space-y-3">
              {(!detail.transcript || detail.transcript.length === 0) ? (
                <div className="text-center py-12 text-gray-400">
                  <MessageSquare className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p>No transcript available</p>
                </div>
              ) : detail.transcript.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'agent' ? '' : 'flex-row-reverse'}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                    msg.role === 'agent' ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {msg.role === 'agent' ? <Bot className="w-3.5 h-3.5" /> : <Phone className="w-3.5 h-3.5" />}
                  </div>
                  <div className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    msg.role === 'agent'
                      ? 'bg-indigo-50 text-indigo-900 rounded-bl-md'
                      : 'bg-gray-100 text-gray-900 rounded-br-md'
                  }`}>
                    {msg.text}
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
