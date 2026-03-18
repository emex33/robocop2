import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import {
  Search, Download, Filter, PhoneForwarded, ChevronLeft, ChevronRight, X, Eye
} from 'lucide-react';

export default function Transfers() {
  const [data, setData] = useState({ transfers: [], total: 0, page: 1, pages: 1, stats: {} });
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [campaignFilter, setCampaignFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [selectedCall, setSelectedCall] = useState(null);

  useEffect(() => {
    api.getCampaigns().then(setCampaigns).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api.getTransfers({ campaign_id: campaignFilter, search, page })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [campaignFilter, search, page]);

  useEffect(load, [load]);

  const handleSearch = (e) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  const stats = data.stats || {};

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Transferred Leads Report</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data.total} transferred leads
            {stats.avg_duration ? ` · Avg ${Math.round(stats.avg_duration)}s call duration` : ''}
          </p>
        </div>
        <button
          onClick={() => api.exportTransfersCsv(campaignFilter)}
          className="flex items-center gap-2 bg-green-600 text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-green-700 transition"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 mb-5">
        {/* Campaign filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={campaignFilter}
            onChange={e => { setCampaignFilter(e.target.value); setPage(1); }}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 min-w-[200px]"
          >
            <option value="">All Campaigns</option>
            {campaigns.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex-1 flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search by phone, name, or email..."
              className="w-full pl-10 pr-8 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {searchInput && (
              <button type="button" onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button type="submit"
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition">
            Search
          </button>
        </form>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Time</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">LastName</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Phone</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Age</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Job</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Income</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Goal</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Interested</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Transferred</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">CallSummary</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center">
                    <div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full mx-auto" />
                  </td>
                </tr>
              ) : data.transfers.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-gray-400">
                    <PhoneForwarded className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                    No transferred leads found
                  </td>
                </tr>
              ) : data.transfers.map(t => (
                <tr key={t.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{t.date}</td>
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{t.time}</td>
                  <td className="px-4 py-2.5 text-gray-900 font-medium">{t.first_name}</td>
                  <td className="px-4 py-2.5 text-gray-700">{t.last_name}</td>
                  <td className="px-4 py-2.5 font-mono text-gray-700">{t.phone}</td>
                  <td className="px-4 py-2.5 text-gray-600">{t.age || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-600 max-w-28 truncate" title={t.job}>{t.job || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-600">{t.income || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-600 max-w-32 truncate" title={t.goal}>{t.goal || '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">TRUE</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">TRUE</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs max-w-56 truncate" title={t.call_summary}>
                    {t.call_summary || '—'}
                  </td>
                  <td className="px-2">
                    <button onClick={() => setSelectedCall(t)}
                      className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition" title="View details">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
            <p className="text-xs text-gray-500">
              Page {data.page} of {data.pages} · {data.total} results
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1}
                className="p-1.5 text-gray-500 hover:text-gray-700 disabled:opacity-30 rounded-lg hover:bg-gray-100 transition">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setPage(Math.min(data.pages, page + 1))} disabled={page >= data.pages}
                className="p-1.5 text-gray-500 hover:text-gray-700 disabled:opacity-30 rounded-lg hover:bg-gray-100 transition">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selectedCall && (
        <CallDetailModal call={selectedCall} onClose={() => setSelectedCall(null)} />
      )}
    </div>
  );
}

function CallDetailModal({ call, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              {call.first_name} {call.last_name}
            </h2>
            <p className="text-sm text-gray-500">{call.phone} · {call.date} {call.time}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-5">
          {/* KYC Info */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Lead Information</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Name</p>
                <p className="text-gray-700 font-medium">{call.first_name} {call.last_name}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Phone</p>
                <p className="text-gray-700 font-mono">{call.phone}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Email</p>
                <p className="text-gray-700">{call.email || '—'}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Age</p>
                <p className="text-gray-700">{call.age || '—'}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Job</p>
                <p className="text-gray-700">{call.job || '—'}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Income</p>
                <p className="text-gray-700">{call.income || '—'}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5 col-span-2">
                <p className="text-xs text-gray-400 mb-0.5">Goal</p>
                <p className="text-gray-700">{call.goal || '—'}</p>
              </div>
            </div>
          </div>

          {/* Transfer Info */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Transfer Details</h3>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="bg-green-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-green-600 mb-0.5">Transferred</p>
                <p className="text-green-700 font-semibold">YES</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Transferred To</p>
                <p className="text-gray-700 font-mono">{call.transferred_to || '—'}</p>
              </div>
              <div className="bg-gray-50 rounded-lg px-4 py-2.5">
                <p className="text-xs text-gray-400 mb-0.5">Duration</p>
                <p className="text-gray-700">{call.duration_seconds}s</p>
              </div>
            </div>
          </div>

          {/* Call Summary */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">AI Call Summary</h3>
            <div className="bg-indigo-50 rounded-xl px-5 py-4 text-sm text-indigo-900 leading-relaxed">
              {call.call_summary || 'No summary available.'}
            </div>
          </div>

          {/* Transcript */}
          {call.transcript && call.transcript.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Conversation Transcript</h3>
              <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-2 max-h-64 overflow-auto">
                {call.transcript.map((t, i) => (
                  <div key={i} className={`flex gap-2 text-sm ${t.role === 'agent' ? '' : 'flex-row-reverse'}`}>
                    <span className={`text-xs font-semibold shrink-0 px-2 py-0.5 rounded-full mt-0.5 ${
                      t.role === 'agent' ? 'bg-indigo-100 text-indigo-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {t.role === 'agent' ? 'AI' : 'Lead'}
                    </span>
                    <p className={`text-gray-700 ${t.role === 'agent' ? '' : 'text-right'}`}>{t.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Campaign */}
          {call.campaign_name && (
            <div className="text-xs text-gray-400">
              Campaign: <span className="text-gray-600">{call.campaign_name}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
