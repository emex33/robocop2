import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { DollarSign, Phone, Clock, Bot, TrendingDown, ChevronLeft, ChevronRight } from 'lucide-react';

function fmt$(v) { return '$' + (v || 0).toFixed(2); }
function fmtMin(s) { return ((s || 0) / 60).toFixed(1); }

export default function Billing() {
  const [usage, setUsage] = useState(null);
  const [txData, setTxData] = useState({ transactions: [], total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [txPage, setTxPage] = useState(1);
  const [txFilter, setTxFilter] = useState('');

  useEffect(() => {
    api.getBillingUsage().then(setUsage).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.getBillingTransactions({ page: txPage, limit: 30, type: txFilter }).then(setTxData).catch(() => {});
  }, [txPage, txFilter]);

  if (loading) return (
    <div className="p-6 flex justify-center py-20">
      <div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" />
    </div>
  );

  const totals = usage?.totals || {};
  const balance = usage?.balance || 0;

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Billing & Usage</h1>
        <p className="text-sm text-gray-500 mt-0.5">Your credit balance and call usage</p>
      </div>

      {/* Balance highlight */}
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 rounded-2xl p-6 mb-6 text-white">
        <p className="text-sm font-medium text-indigo-200 mb-1">Current Balance</p>
        <p className="text-4xl font-bold">{fmt$(balance)}</p>
        <p className="text-sm text-indigo-200 mt-2">
          Total spent: {fmt$(totals.total_cost)} across {totals.total_calls || 0} calls
        </p>
      </div>

      {/* Usage stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {[
          { label: 'Total Calls', value: totals.total_calls || 0, icon: Phone, color: 'text-gray-700' },
          { label: 'Call Minutes', value: fmtMin(totals.total_duration), icon: Clock, color: 'text-blue-600' },
          { label: 'AI Minutes', value: fmtMin(totals.total_ai_duration), icon: Bot, color: 'text-purple-600' },
          { label: 'Total Cost', value: fmt$(totals.total_cost), icon: TrendingDown, color: 'text-red-500' },
          { label: 'VoIP Cost', value: fmt$(totals.total_voip_cost), icon: DollarSign, color: 'text-orange-500' },
          { label: 'AI Cost', value: fmt$(totals.total_ai_cost), icon: DollarSign, color: 'text-indigo-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <s.icon className={`w-3.5 h-3.5 ${s.color}`} />
              <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">{s.label}</p>
            </div>
            <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Usage by campaign */}
      {usage?.byCampaign?.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 mb-6 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900 text-sm">Usage by Campaign</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['Campaign', 'Calls', 'Duration', 'AI Minutes', 'Cost'].map((h, i) => (
                    <th key={i} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {usage.byCampaign.map((c, i) => (
                  <tr key={i} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2.5 font-medium text-gray-900">{c.campaign_name || 'Unknown'}</td>
                    <td className="px-4 py-2.5 text-gray-600">{c.calls}</td>
                    <td className="px-4 py-2.5 text-gray-500">{fmtMin(c.duration)} min</td>
                    <td className="px-4 py-2.5 text-gray-500">{fmtMin(c.ai_duration)} min</td>
                    <td className="px-4 py-2.5 font-medium text-gray-700">{fmt$(c.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Transaction history */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900 text-sm">Transaction History</h2>
          <select value={txFilter} onChange={e => { setTxFilter(e.target.value); setTxPage(1); }}
            className="px-2.5 py-1.5 border border-gray-300 rounded-lg text-xs outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">All</option>
            <option value="topup">Top-ups</option>
            <option value="call_charge">Charges</option>
          </select>
        </div>
        <div className="divide-y divide-gray-100">
          {txData.transactions.length === 0 ? (
            <div className="py-12 text-center text-gray-400">
              <DollarSign className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No transactions yet</p>
            </div>
          ) : txData.transactions.map(t => (
            <div key={t.id} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50/50 transition">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {t.type === 'topup' ? 'Credit Top-up' : 'Call Charge'}
                </p>
                <p className="text-xs text-gray-400">{t.description || '—'}</p>
                <p className="text-xs text-gray-300 mt-0.5">{t.created_at?.replace('T', ' ').slice(0, 19)}</p>
              </div>
              <div className="text-right">
                <p className={`text-sm font-bold ${t.amount >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {t.amount >= 0 ? '+' : ''}{fmt$(t.amount)}
                </p>
                <p className="text-xs text-gray-400">Balance: {fmt$(t.balance_after)}</p>
              </div>
            </div>
          ))}
        </div>

        {txData.pages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
            <p className="text-xs text-gray-400">{txData.total} transactions</p>
            <div className="flex items-center gap-1">
              <button onClick={() => setTxPage(p => Math.max(1, p - 1))} disabled={txPage <= 1}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
              <span className="text-xs text-gray-500 px-2">{txPage} / {txData.pages}</span>
              <button onClick={() => setTxPage(p => Math.min(txData.pages, p + 1))} disabled={txPage >= txData.pages}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
