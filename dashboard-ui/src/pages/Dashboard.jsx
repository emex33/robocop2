import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import {
  Phone, PhoneForwarded, PhoneOff, PhoneMissed, Clock, Users, Bot, Megaphone,
  TrendingUp, DollarSign, CalendarCheck, AlertTriangle, VoicemailIcon, Ban,
  Timer, BarChart3, ArrowUpRight, ArrowDownRight
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b', '#f97316', '#14b8a6'];

const OUTCOME_COLORS = {
  lead_hangup: '#64748b',
  error: '#ef4444',
  voicemail: '#f59e0b',
  appointment_set: '#22c55e',
  not_interested: '#f97316',
  no_answer: '#94a3b8',
  callback: '#8b5cf6',
  timeout: '#dc2626',
  transferred: '#6366f1',
  do_not_call: '#991b1b',
  interested: '#06b6d4',
};

function StatCard({ icon: Icon, label, value, sub, color = 'indigo', trend }) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-600',
    green: 'bg-green-50 text-green-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
    purple: 'bg-purple-50 text-purple-600',
    cyan: 'bg-cyan-50 text-cyan-600',
    gray: 'bg-gray-50 text-gray-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    rose: 'bg-rose-50 text-rose-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors[color]}`}>
          <Icon className="w-4 h-4" />
        </div>
        {trend && (
          <span className={`text-xs font-medium flex items-center gap-0.5 ${trend > 0 ? 'text-green-600' : 'text-red-500'}`}>
            {trend > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(trend).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 font-medium">{label}</p>
      <p className="text-xl font-bold text-gray-900 mt-0.5">{value ?? '—'}</p>
      {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatCost(v) {
  if (!v) return '$0.00';
  return '$' + Number(v).toFixed(2);
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDashboard()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  const s = data?.stats || {};
  const cs = data?.callStats || {};
  const today = data?.todayStats || {};
  const apptStats = data?.appointmentStats || {};
  const durBuckets = data?.durationBuckets || {};

  const answerRate = cs.answer_rate || 0;
  const appointmentRate = cs.appointment_rate || 0;

  const durationData = Object.entries(durBuckets).map(([name, value]) => ({ name, value: value || 0 }));

  const outcomeData = (data?.outcomes || []).map(o => ({
    ...o,
    fill: OUTCOME_COLORS[o.outcome] || '#94a3b8',
  }));

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Overview of your AI calling operations</p>
        </div>
        <button onClick={() => { setLoading(true); api.getDashboard().then(setData).catch(() => {}).finally(() => setLoading(false)); }}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
          Refresh
        </button>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard icon={Phone} label="Total Calls" value={cs.total_calls || 0} color="indigo" />
        <StatCard icon={PhoneForwarded} label="Answered" value={cs.answered_calls || 0}
          sub={`${answerRate.toFixed(1)}% answer rate`} color="green" />
        <StatCard icon={CalendarCheck} label="Appointments" value={cs.total_appointments || 0}
          sub={`${appointmentRate.toFixed(1)}% conversion`} color="emerald" />
        <StatCard icon={PhoneOff} label="Voicemail" value={cs.total_voicemail || 0} color="amber" />
        <StatCard icon={AlertTriangle} label="Errors" value={cs.total_errors || 0} color="red" />
        <StatCard icon={Timer} label="Timeouts" value={cs.total_timeouts || 0}
          sub="Stuck calls auto-hung" color="rose" />
      </div>

      {/* Second Row - Duration & Cost */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard icon={Clock} label="Avg Duration" value={formatDuration(cs.avg_duration)} color="indigo" />
        <StatCard icon={Clock} label="Total Talk Time" value={formatDuration(cs.total_duration)} color="purple" />
        <StatCard icon={DollarSign} label="Total Cost" value={formatCost(cs.total_cost)} color="amber" />
        <StatCard icon={DollarSign} label="VoIP Cost" value={formatCost(cs.total_voip_cost)} color="gray" />
        <StatCard icon={DollarSign} label="AI Cost" value={formatCost(cs.total_ai_cost)} color="cyan" />
        <StatCard icon={DollarSign} label="Cost/Call"
          value={cs.total_calls ? formatCost(cs.total_cost / cs.total_calls) : '$0.00'} color="purple" />
      </div>

      {/* Today */}
      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-100 p-5">
        <h3 className="text-sm font-semibold text-indigo-800 mb-3">Today's Activity</h3>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div>
            <p className="text-xs text-indigo-500">Calls</p>
            <p className="text-2xl font-bold text-indigo-900">{today.calls_today || 0}</p>
          </div>
          <div>
            <p className="text-xs text-indigo-500">Answered</p>
            <p className="text-2xl font-bold text-indigo-900">{today.answered_today || 0}</p>
          </div>
          <div>
            <p className="text-xs text-indigo-500">Appointments</p>
            <p className="text-2xl font-bold text-green-700">{today.appointments_today || 0}</p>
          </div>
          <div>
            <p className="text-xs text-indigo-500">Callbacks</p>
            <p className="text-2xl font-bold text-purple-700">{today.callbacks_today || 0}</p>
          </div>
          <div>
            <p className="text-xs text-indigo-500">Avg Duration</p>
            <p className="text-2xl font-bold text-indigo-900">{formatDuration(today.avg_duration_today)}</p>
          </div>
          <div>
            <p className="text-xs text-indigo-500">Cost Today</p>
            <p className="text-2xl font-bold text-indigo-900">{formatCost(today.cost_today)}</p>
          </div>
        </div>
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Calls Over Time (30 days)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data?.callsByDay || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={d => d?.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="calls" stroke="#6366f1" fill="#eef2ff" strokeWidth={2} name="Total" />
              <Area type="monotone" dataKey="answered" stroke="#22c55e" fill="#f0fdf4" strokeWidth={2} name="Answered" />
              <Area type="monotone" dataKey="appointments" stroke="#10b981" fill="#d1fae5" strokeWidth={2} name="Appointments" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Call Outcomes</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={outcomeData} dataKey="count" nameKey="outcome"
                cx="50%" cy="50%" innerRadius={45} outerRadius={85} paddingAngle={2}>
                {outcomeData.map((entry, i) => (
                  <Cell key={i} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip formatter={(v, name) => [`${v} calls`, name.replace(/_/g, ' ')]} />
              <Legend wrapperStyle={{ fontSize: 10 }} formatter={v => v.replace(/_/g, ' ')} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Call Duration Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Call Duration Distribution</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={durationData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} name="Calls" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Calls by Hour Today */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Calls by Hour (Today)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data?.callsByHour || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="hour" tick={{ fontSize: 11 }} tickFormatter={h => `${h}:00`} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={h => `${h}:00`} />
              <Bar dataKey="calls" fill="#8b5cf6" radius={[4, 4, 0, 0]} name="Calls" />
              <Bar dataKey="answered" fill="#22c55e" radius={[4, 4, 0, 0]} name="Answered" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Error Breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">SIP Error Breakdown</h3>
          {(data?.errorBreakdown || []).length === 0 ? (
            <p className="text-sm text-gray-400">No errors</p>
          ) : (
            <div className="space-y-2">
              {(data?.errorBreakdown || []).map((e, i) => {
                const msg = e.error_message || 'Unknown';
                const code = msg.match(/(\d{3})/)?.[1];
                const labels = { '486': 'Busy', '480': 'Unavailable', '503': 'Service Down', '404': 'Not Found', '408': 'Timeout', '485': 'Ambiguous' };
                return (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-red-50 text-red-700 px-1.5 py-0.5 rounded">{code || '?'}</span>
                      <span className="text-sm text-gray-600">{labels[code] || msg.substring(0, 30)}</span>
                    </div>
                    <span className="text-sm font-semibold text-gray-900">{e.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Campaigns Performance */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Campaign Performance</h3>
          {(data?.topCampaigns || []).length === 0 ? (
            <p className="text-sm text-gray-400">No campaign data yet</p>
          ) : (
            <div className="space-y-3">
              {(data?.topCampaigns || []).map((c, i) => {
                const ansRate = c.total_calls > 0 ? ((c.answered / c.total_calls) * 100).toFixed(0) : 0;
                return (
                  <div key={i} className="border-b border-gray-50 pb-2 last:border-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-700 truncate">{c.name}</p>
                      <span className="text-xs text-gray-400">{formatCost(c.cost)}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      <span>{c.total_calls} calls</span>
                      <span>{c.answered} answered ({ansRate}%)</span>
                      <span className="text-green-600 font-medium">{c.appointments} appts</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Calls */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Recent Calls</h3>
          {(data?.recentCalls || []).length === 0 ? (
            <p className="text-sm text-gray-400">No calls yet</p>
          ) : (
            <div className="space-y-2">
              {(data?.recentCalls || []).slice(0, 8).map((c, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 bg-gray-100 rounded-full flex items-center justify-center shrink-0">
                      <Phone className="w-3 h-3 text-gray-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-gray-700 truncate">{c.lead_name || c.phone}</p>
                      <p className="text-[10px] text-gray-400">{c.duration_seconds}s</p>
                    </div>
                  </div>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                    c.outcome === 'appointment_set' ? 'bg-green-100 text-green-700' :
                    c.outcome === 'transferred' ? 'bg-indigo-100 text-indigo-700' :
                    c.outcome === 'error' ? 'bg-red-100 text-red-700' :
                    c.outcome === 'voicemail' ? 'bg-amber-100 text-amber-700' :
                    c.outcome === 'lead_hangup' ? 'bg-gray-100 text-gray-600' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {c.outcome?.replace(/_/g, ' ')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Appointment Stats */}
      {apptStats.total > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Appointment Overview</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">{apptStats.total}</p>
              <p className="text-xs text-gray-500">Total</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-600">{apptStats.scheduled}</p>
              <p className="text-xs text-gray-500">Scheduled</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">{apptStats.completed}</p>
              <p className="text-xs text-gray-500">Completed</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-red-600">{apptStats.no_show}</p>
              <p className="text-xs text-gray-500">No Show</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-500">{apptStats.cancelled}</p>
              <p className="text-xs text-gray-500">Cancelled</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
