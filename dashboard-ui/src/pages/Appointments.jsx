import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { 
  CalendarCheck, Clock, Phone, User, Search, Filter,
  Check, X, Calendar, Pencil, Trash2, Building2, Globe,
  FileText, ChevronDown, ChevronUp, Mail
} from 'lucide-react';

const STATUS_COLORS = {
  scheduled: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-600',
  no_show: 'bg-red-100 text-red-700',
  rescheduled: 'bg-amber-100 text-amber-700',
};

const LEAD_STATUS_COLORS = {
  new: 'bg-gray-100 text-gray-600',
  contacted: 'bg-blue-100 text-blue-700',
  interested: 'bg-green-100 text-green-700',
  not_interested: 'bg-red-100 text-red-700',
  appointment_set: 'bg-indigo-100 text-indigo-700',
  transferred: 'bg-purple-100 text-purple-700',
  callback: 'bg-amber-100 text-amber-700',
  do_not_call: 'bg-red-200 text-red-800',
};

export default function Appointments() {
  const [appointments, setAppointments] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', from: '', to: '' });
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [expandedId, setExpandedId] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.getAppointments(filter),
      api.getAppointmentStats(),
    ]).then(([appts, s]) => {
      setAppointments(appts);
      setStats(s);
    }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(load, [filter.status, filter.from, filter.to]);

  const filteredAppointments = appointments.filter(a => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      a.lead_name?.toLowerCase().includes(s) ||
      a.first_name?.toLowerCase().includes(s) ||
      a.last_name?.toLowerCase().includes(s) ||
      a.phone?.includes(s) ||
      a.email?.toLowerCase().includes(s) ||
      a.lead_company?.toLowerCase().includes(s) ||
      a.campaign_name?.toLowerCase().includes(s)
    );
  });

  const handleStatusChange = async (id, status) => {
    await api.updateAppointment(id, { status });
    load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this appointment?')) return;
    await api.deleteAppointment(id);
    load();
  };

  const startEdit = (appt) => {
    setEditingId(appt.id);
    setEditForm({
      appointment_date: appt.appointment_date,
      appointment_time: appt.appointment_time,
      notes: appt.notes || '',
    });
  };

  const saveEdit = async () => {
    await api.updateAppointment(editingId, editForm);
    setEditingId(null);
    load();
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  const isToday = (dateStr) => {
    const today = new Date().toISOString().slice(0, 10);
    return dateStr === today;
  };

  const isPast = (dateStr) => {
    const today = new Date().toISOString().slice(0, 10);
    return dateStr < today;
  };

  const getLeadName = (appt) => {
    if (appt.lead_name) return appt.lead_name;
    const parts = [appt.first_name, appt.last_name].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : '—';
  };

  const parseExtra = (json) => {
    if (!json || json === '{}') return null;
    try { return JSON.parse(json); } catch { return null; }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Appointments</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage scheduled appointments from AI calls</p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Total</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Today</p>
          <p className="text-2xl font-bold text-indigo-600">{stats.today || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">This Week</p>
          <p className="text-2xl font-bold text-blue-600">{stats.this_week || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Scheduled</p>
          <p className="text-2xl font-bold text-blue-600">{stats.scheduled || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Completed</p>
          <p className="text-2xl font-bold text-green-600">{stats.completed || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">No Shows</p>
          <p className="text-2xl font-bold text-red-600">{stats.no_show || 0}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, phone, email, company, campaign..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-400" />
            <select
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            >
              <option value="">All Statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="no_show">No Show</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={filter.from}
              onChange={(e) => setFilter({ ...filter, from: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
            <span className="text-gray-400">—</span>
            <input
              type="date"
              value={filter.to}
              onChange={(e) => setFilter({ ...filter, to: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>
        </div>
      </div>

      {/* Appointments List */}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" />
        </div>
      ) : filteredAppointments.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <CalendarCheck className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No appointments found</p>
          <p className="text-sm text-gray-400 mt-1">Appointments will appear here when leads book through AI calls</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredAppointments.map(appt => {
            const extra = parseExtra(appt.lead_extra);
            const isExpanded = expandedId === appt.id;

            return (
              <div key={appt.id} className={`bg-white rounded-xl border border-gray-200 overflow-hidden ${isToday(appt.appointment_date) ? 'ring-2 ring-indigo-200' : ''}`}>
                {/* Main Row */}
                <div className="flex items-center gap-4 px-5 py-4">
                  {/* Date & Time */}
                  <div className="w-44 shrink-0">
                    {editingId === appt.id ? (
                      <div className="flex flex-col gap-1">
                        <input type="date" value={editForm.appointment_date} onChange={(e) => setEditForm({ ...editForm, appointment_date: e.target.value })} className="px-2 py-1 border border-gray-300 rounded text-xs" />
                        <input type="time" value={editForm.appointment_time} onChange={(e) => setEditForm({ ...editForm, appointment_time: e.target.value })} className="px-2 py-1 border border-gray-300 rounded text-xs" />
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2">
                          <Calendar className="w-3.5 h-3.5 text-gray-400" />
                          <span className={`font-medium text-sm ${isToday(appt.appointment_date) ? 'text-indigo-600' : isPast(appt.appointment_date) ? 'text-gray-400' : 'text-gray-900'}`}>
                            {formatDate(appt.appointment_date)}
                          </span>
                          {isToday(appt.appointment_date) && (
                            <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">TODAY</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-gray-500 text-sm">
                          <Clock className="w-3.5 h-3.5" />
                          <span>{appt.appointment_time}</span>
                          {appt.timezone && <span className="text-xs text-gray-400">({appt.timezone})</span>}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Lead Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="font-semibold text-gray-900 truncate">{getLeadName(appt)}</span>
                      {appt.lead_status && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${LEAD_STATUS_COLORS[appt.lead_status] || 'bg-gray-100 text-gray-600'}`}>
                          {appt.lead_status.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Phone className="w-3 h-3" />
                        <span className="font-mono">{appt.phone}</span>
                      </span>
                      {(appt.email || appt.lead_email) && (
                        <span className="flex items-center gap-1">
                          <Mail className="w-3 h-3" />
                          <span>{appt.email || appt.lead_email}</span>
                        </span>
                      )}
                      {appt.lead_company && (
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          <span>{appt.lead_company}</span>
                        </span>
                      )}
                      {appt.lead_country && (
                        <span className="flex items-center gap-1">
                          <Globe className="w-3 h-3" />
                          <span>{appt.lead_country}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Campaign */}
                  <div className="w-32 text-xs text-gray-500 truncate">
                    {appt.campaign_name || '—'}
                  </div>

                  {/* Status */}
                  <div className="w-32">
                    <select
                      value={appt.status}
                      onChange={(e) => handleStatusChange(appt.id, e.target.value)}
                      className={`text-xs font-medium px-2 py-1 rounded-full border-0 cursor-pointer ${STATUS_COLORS[appt.status] || 'bg-gray-100 text-gray-600'}`}
                    >
                      <option value="scheduled">Scheduled</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="no_show">No Show</option>
                      <option value="rescheduled">Rescheduled</option>
                    </select>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {editingId === appt.id ? (
                      <>
                        <button onClick={saveEdit} className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg transition"><Check className="w-4 h-4" /></button>
                        <button onClick={() => setEditingId(null)} className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg transition"><X className="w-4 h-4" /></button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setExpandedId(isExpanded ? null : appt.id)} className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition" title="Show details">
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        <button onClick={() => startEdit(appt)} className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition" title="Edit"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => handleDelete(appt.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition" title="Delete"><Trash2 className="w-4 h-4" /></button>
                      </>
                    )}
                  </div>
                </div>

                {/* Expanded Detail Panel */}
                {isExpanded && (
                  <div className="border-t border-gray-100 bg-gray-50/50 px-5 py-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Full Name</p>
                        <p className="text-gray-900">{getLeadName(appt)}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Phone</p>
                        <p className="text-gray-900 font-mono">{appt.phone}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Email</p>
                        <p className="text-gray-900">{appt.email || appt.lead_email || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Company</p>
                        <p className="text-gray-900">{appt.lead_company || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Country</p>
                        <p className="text-gray-900">{appt.lead_country || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Campaign</p>
                        <p className="text-gray-900">{appt.campaign_name || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Lead Status</p>
                        <p>{appt.lead_status ? (
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${LEAD_STATUS_COLORS[appt.lead_status] || 'bg-gray-100 text-gray-600'}`}>
                            {appt.lead_status.replace(/_/g, ' ')}
                          </span>
                        ) : '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Call ID</p>
                        <p className="text-gray-500 font-mono text-xs">{appt.call_id || '—'}</p>
                      </div>
                    </div>

                    {/* Notes */}
                    {(appt.notes || appt.lead_notes) && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-400 uppercase mb-1">Notes</p>
                        <p className="text-sm text-gray-700 bg-white rounded-lg border border-gray-200 p-3">
                          {appt.notes || appt.lead_notes}
                        </p>
                      </div>
                    )}

                    {/* Extra Lead Data */}
                    {extra && Object.keys(extra).length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-400 uppercase mb-2">Additional Lead Data</p>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {Object.entries(extra).map(([key, val]) => (
                            <div key={key} className="bg-white rounded-lg border border-gray-200 p-2.5">
                              <p className="text-[10px] font-medium text-gray-400 uppercase">{key.replace(/_/g, ' ')}</p>
                              <p className="text-sm text-gray-900 mt-0.5">{String(val)}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-3 text-xs text-gray-400">
                      Created: {appt.created_at ? new Date(appt.created_at).toLocaleString() : '—'}
                      {appt.updated_at && appt.updated_at !== appt.created_at && (
                        <span className="ml-4">Updated: {new Date(appt.updated_at).toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
