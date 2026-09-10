import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  Activity, Phone, PhoneOff, Users, CalendarCheck, DollarSign, Zap, ShieldAlert, ShieldCheck,
  Play, Square, RefreshCw, Pause, AlertTriangle, Info, Flame, Radio, Clock, Gauge,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
const HOUSE_TZ = 'Europe/Amsterdam';
const MARKET_TZ = 'America/Toronto';

const n0 = (v) => (v ?? 0).toLocaleString();
const pct = (v) => `${(v ?? 0).toFixed(1)}%`;
const usd = (v, d = 2) => (v == null ? '—' : `$${Number(v).toFixed(d)}`);
const secs = (s) => (!s ? '0s' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
const ago = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 60 ? `${Math.round(d)}s ago` : d < 3600 ? `${Math.round(d / 60)}m ago` : `${Math.round(d / 3600)}h ago`;
};
const fmtTime = (iso, tz = HOUSE_TZ) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso, tz = HOUSE_TZ) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: 'short' });

/** Hour offset between two zones right now (e.g. Amsterdam → Toronto = -6). */
function hourDiff(fromTz, toTz) {
  const now = new Date();
  const a = new Date(now.toLocaleString('en-US', { timeZone: fromTz }));
  const b = new Date(now.toLocaleString('en-US', { timeZone: toTz }));
  return Math.round((b - a) / 36e5);
}

const OUTCOME_STYLE = {
  appointment_set: 'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40',
  transferred: 'bg-indigo-500/20 text-indigo-300 ring-indigo-500/40',
  callback: 'bg-violet-500/20 text-violet-300 ring-violet-500/40',
  interested: 'bg-cyan-500/20 text-cyan-300 ring-cyan-500/40',
  voicemail: 'bg-amber-500/20 text-amber-300 ring-amber-500/40',
  error: 'bg-rose-500/20 text-rose-300 ring-rose-500/40',
  no_answer: 'bg-slate-500/20 text-slate-300 ring-slate-500/40',
  not_interested: 'bg-orange-500/20 text-orange-300 ring-orange-500/40',
  lead_hangup: 'bg-slate-500/20 text-slate-300 ring-slate-500/40',
  do_not_call: 'bg-red-700/30 text-red-300 ring-red-700/40',
};

// ---------------------------------------------------------------------------
// small building blocks
// ---------------------------------------------------------------------------
function Panel({ title, right, children, className = '' }) {
  return (
    <section className={`bg-slate-900/70 border border-slate-800 rounded-lg ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
          {right}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

function Kpi({ label, value, sub, tone = 'slate', icon: Icon }) {
  const tones = {
    slate: 'text-slate-100', green: 'text-emerald-400', amber: 'text-amber-400',
    red: 'text-rose-400', blue: 'text-sky-400', violet: 'text-violet-400',
  };
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2.5 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 truncate">{label}</span>
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
      </div>
      <div className={`text-xl font-semibold tabular-nums mt-0.5 ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 tabular-nums truncate">{sub}</div>}
    </div>
  );
}

function Pill({ ok, label, detail }) {
  const cls = ok === null ? 'bg-slate-700/50 text-slate-300 ring-slate-600'
    : ok ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
      : 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
  return (
    <span title={detail} className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded ring-1 ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok === null ? 'bg-slate-400' : ok ? 'bg-emerald-400' : 'bg-rose-400 animate-pulse'}`} />
      {label}
    </span>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded-md bg-slate-800/80 p-0.5 ring-1 ring-slate-700">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded ${value === o.value ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Sortable dense table. columns: [{ key, label, fmt, align, tone(fn) }] */
function DataTable({ rows, columns, defaultSort, rowKey = 'id', maxRows = 12, onRowClick }) {
  const [sort, setSort] = useState({ key: defaultSort, dir: -1 });
  const sorted = useMemo(() => {
    const r = [...rows];
    if (sort.key) r.sort((a, b) => ((a[sort.key] ?? -Infinity) > (b[sort.key] ?? -Infinity) ? 1 : -1) * sort.dir);
    return r.slice(0, maxRows);
  }, [rows, sort, maxRows]);
  if (!rows.length) return <p className="text-xs text-slate-500 py-2">No data in this range.</p>;
  return (
    <div className="overflow-x-auto -mx-3 -mb-3">
      <table className="w-full text-[11.5px] tabular-nums">
        <thead>
          <tr className="text-slate-500">
            {columns.map((c) => (
              <th key={c.key} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : -1 }))}
                className={`px-3 py-1.5 font-medium cursor-pointer select-none whitespace-nowrap hover:text-slate-300 ${c.align === 'left' ? 'text-left' : 'text-right'}`}>
                {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r[rowKey] ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-t border-slate-800/70 ${onRowClick ? 'cursor-pointer hover:bg-slate-800/40' : ''}`}>
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-1.5 whitespace-nowrap ${c.align === 'left' ? 'text-left text-slate-200' : 'text-right text-slate-300'} ${c.tone ? c.tone(r) : ''}`}>
                  {c.fmt ? c.fmt(r[c.key], r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const rateTone = (good, bad) => (r, v) => (v >= good ? 'text-emerald-300' : v <= bad ? 'text-rose-300' : '');

// Standard KPI columns shared by the campaign / agent / region tables.
const perfColumns = (first) => [
  first,
  { key: 'dials', label: 'Dials', fmt: n0 },
  { key: 'connect_rate', label: 'Conn%', fmt: pct },
  { key: 'human_rate', label: 'Human%', fmt: pct, tone: (r) => rateTone(45, 30)(r, r.human_rate) },
  { key: 'voicemail_rate', label: 'VM%', fmt: pct, tone: (r) => (r.voicemail_rate >= 50 ? 'text-amber-300' : '') },
  { key: 'appointments', label: 'Appts', fmt: n0, tone: (r) => (r.appointments > 0 ? 'text-emerald-300 font-semibold' : '') },
  { key: 'appt_per_human', label: 'Close%', fmt: pct },
  { key: 'callbacks', label: 'CB', fmt: n0 },
  { key: 'cost', label: 'Spend', fmt: (v) => usd(v) },
  { key: 'cost_per_human', label: '$/Human', fmt: (v) => usd(v) },
  { key: 'cost_per_appt', label: '$/Appt', fmt: (v) => usd(v, 0) },
];

// ---------------------------------------------------------------------------
// heatmap
// ---------------------------------------------------------------------------
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function Heatmap({ cells, metric }) {
  const grid = useMemo(() => {
    const m = new Map(cells.map((c) => [`${c.weekday}|${c.hour}`, c]));
    const vals = cells.filter((c) => c.dials >= 10).map((c) => c[metric] ?? 0);
    const max = Math.max(1, ...vals);
    return { m, max };
  }, [cells, metric]);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const diff = hourDiff(HOUSE_TZ, MARKET_TZ);
  return (
    <div className="overflow-x-auto">
      <div className="grid gap-px" style={{ gridTemplateColumns: `36px repeat(24, minmax(22px, 1fr))` }}>
        <div />
        {hours.map((h) => (
          <div key={h} className="text-[9px] text-slate-500 text-center leading-3">
            {String(h).padStart(2, '0')}<br />
            <span className="text-slate-600">{String(((h + diff) % 24 + 24) % 24).padStart(2, '0')}</span>
          </div>
        ))}
        {order.map((wd) => (
          <FragmentRow key={wd} wd={wd} hours={hours} grid={grid} metric={metric} />
        ))}
      </div>
      <p className="text-[10px] text-slate-500 mt-1.5">Top row: {HOUSE_TZ.split('/')[1]} hour · bottom: Toronto hour. Cells with under 10 dials are muted.</p>
    </div>
  );
}
function FragmentRow({ wd, hours, grid, metric }) {
  return (
    <>
      <div className="text-[10px] text-slate-500 flex items-center">{WEEKDAYS[wd]}</div>
      {hours.map((h) => {
        const c = grid.m.get(`${wd}|${h}`);
        const v = c?.[metric] ?? 0;
        const thin = !c || c.dials < 10;
        const alpha = thin ? 0.08 : 0.15 + 0.85 * (v / grid.max);
        const title = c ? `${WEEKDAYS[wd]} ${String(h).padStart(2, '0')}:00 — ${n0(c.dials)} dials, ${pct(c.human_rate)} human, ${c.appointments} appts, ${usd(c.cost)}` : 'no data';
        return (
          <div key={h} title={title} className="h-6 rounded-[2px] flex items-center justify-center text-[9px] text-slate-100/80"
            style={{ background: `rgba(16, 185, 129, ${alpha})` }}>
            {!thin && metric !== 'dials' ? Math.round(v) : (!thin && c.dials >= 1000 ? `${Math.round(c.dials / 1000)}k` : '')}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------
export default function CommandCenter() {
  const [range, setRange] = useState('today');
  const [campaignId, setCampaignId] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [data, setData] = useState(null);
  const [live, setLive] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [auto, setAuto] = useState(true);
  const [heatMetric, setHeatMetric] = useState('human_rate');
  const [seriesMode, setSeriesMode] = useState('volume');
  const [busy, setBusy] = useState({});
  const [updatedAt, setUpdatedAt] = useState(null);
  const tape = useRef([]);
  const { connected, on } = useWebSocket();

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const d = await api.getCommandOverview(range, campaignId);
      setData(d); setErr(''); setUpdatedAt(Date.now());
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [range, campaignId]);

  const loadLive = useCallback(async () => {
    try {
      const l = await api.getCommandLive();
      setLive(l);
      if (l.recent) tape.current = l.recent;
    } catch { /* keep last */ }
  }, []);

  useEffect(() => { api.getCampaigns().then((c) => setCampaigns(Array.isArray(c) ? c : c.campaigns || [])).catch(() => {}); }, []);
  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { loadLive(); }, [loadLive]);
  useEffect(() => {
    if (!campaignId) { setInventory(null); return; }
    api.getCommandInventory(campaignId).then(setInventory).catch(() => setInventory(null));
  }, [campaignId, updatedAt]);

  // polling
  useEffect(() => {
    if (!auto) return;
    const a = setInterval(loadLive, 5000);
    const b = setInterval(() => loadOverview(true), data?.warming ? 15000 : 30000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [auto, loadLive, loadOverview, data?.warming]);

  // live tape from websocket
  useEffect(() => {
    const off = on('call_ended', (d) => {
      tape.current = [{ call_id: d.callId || Math.random(), phone: d.phone, lead_name: d.name, outcome: d.outcome, duration_seconds: d.duration, started_at: new Date().toISOString(), campaign: campaigns.find((c) => c.id === d.campaignId)?.name }, ...tape.current].slice(0, 25);
      setLive((l) => (l ? { ...l, recent: tape.current } : l));
    });
    return off;
  }, [on, campaigns]);

  const act = async (id, action) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      if (action === 'start') await api.startCampaign(id);
      else if (action === 'stop') await api.stopCampaign(id);
      else if (action === 'kill') { if (window.confirm('Force-stop: every live call is cut immediately. Continue?')) await api.stopCampaign(id, { force: true }); }
      await loadLive();
    } catch (e) { setErr(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const t = data?.totals || {};
  const lh = data?.last_hour || {};
  const g = data?.guard;
  const diff = hourDiff(HOUSE_TZ, MARKET_TZ);

  const seriesData = useMemo(() => (data?.series || []).map((s) => ({
    ...s,
    label: data.bucket === 'day' ? fmtDay(s.t) : fmtTime(s.t),
    machines: s.voicemail,
    failed: s.errors + s.no_answer,
  })), [data]);

  const funnel = [
    { label: 'Dials', v: t.dials },
    { label: 'Connected', v: t.connected },
    { label: 'Human', v: t.human },
    { label: 'Engaged ≥20s', v: t.engaged },
    { label: 'Positive', v: t.positive },
    { label: 'Appointments', v: t.appointments },
  ];

  const runningCount = (live?.runners || []).filter((r) => r.running).length;

  return (
    <div className="min-h-full bg-slate-950 text-slate-200 p-4 space-y-3 font-[ui-sans-serif,system-ui] [font-variant-numeric:tabular-nums]">
      {/* ---------------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 mr-2">
          <Activity className="w-5 h-5 text-emerald-400" />
          <h1 className="text-lg font-semibold text-slate-100">Command Center</h1>
        </div>
        <Seg value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: '7d', label: '7D' }, { value: '30d', label: '30D' }]} />
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}
          className="bg-slate-800/80 ring-1 ring-slate-700 text-[11px] rounded-md px-2 py-1.5 text-slate-200 max-w-[220px]">
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'running' ? ' ●' : ''}</option>)}
        </select>
        <button onClick={() => setAuto((a) => !a)} className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md ring-1 ${auto ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' : 'bg-slate-800 text-slate-400 ring-slate-700'}`}>
          <Radio className={`w-3.5 h-3.5 ${auto ? 'animate-pulse' : ''}`} /> {auto ? 'LIVE' : 'Paused'}
        </button>
        <button onClick={() => { loadOverview(true); loadLive(); }} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1.5 rounded-md ring-1 bg-slate-800 text-slate-300 ring-slate-700 hover:text-white">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        <span className="text-[11px] text-slate-500">{updatedAt ? `updated ${ago(new Date(updatedAt).toISOString())}` : ''}</span>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Pill ok={connected} label={connected ? 'WS live' : 'WS reconnecting'} />
          <Pill ok={g ? g.ok : null} label={g?.ok === false ? 'DIALING BLOCKED' : g?.ok ? 'Guard OK' : 'Guard…'} detail={(g?.reasons || []).join('\n')} />
          <Pill ok={g?.trunk ? !g.trunk.tripped : null}
            label={g?.trunk?.tripped ? `Trunk tripped · ${g.trunk.retryInMinutes}m` : g?.trunk?.disabled ? 'Trunk breaker OFF' : 'Trunk OK'}
            detail={g?.trunk?.disabled ? 'Carrier rejections never pause campaigns (voip_trunk_breaker = off)' : g?.trunk?.reason} />
          <Pill ok={g?.deepgram ? g.deepgram.ok : null}
            label={g?.deepgram?.total != null ? `Deepgram ${usd(g.deepgram.total, 0)} · ${g.deepgram.usableKeys} keys` : g?.deepgram?.unreachable ? 'Deepgram unreachable' : 'Deepgram…'} />
          <Pill ok={(data?.credit ?? 0) > 0} label={`Credit ${usd(data?.credit)}`} />
          {live?.offline_gap && (Date.now() - new Date(live.offline_gap.to).getTime()) < 36 * 3600e3 && (
            <Pill ok={false}
              label={`Was OFFLINE ${live.offline_gap.minutes >= 60 ? `${Math.floor(live.offline_gap.minutes / 60)}h${String(live.offline_gap.minutes % 60).padStart(2, '0')}` : `${live.offline_gap.minutes}m`} · back ${ago(live.offline_gap.to)}`}
              detail={`Robocop process was not running ${new Date(live.offline_gap.from).toLocaleString()} → ${new Date(live.offline_gap.to).toLocaleString()} (host reboot / Docker stopped). No calls were possible in that period.`} />
          )}
          {live?.uptime_seconds != null && (
            <Pill ok={null} label={`Up ${live.uptime_seconds >= 3600 ? `${Math.floor(live.uptime_seconds / 3600)}h ${Math.floor((live.uptime_seconds % 3600) / 60)}m` : `${Math.floor(live.uptime_seconds / 60)}m`}`} detail="Time since the Robocop process started" />
          )}
        </div>
      </div>

      {err && <div className="text-xs text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded px-3 py-2">{err}</div>}
      {data?.warming && (
        <div className="text-xs text-amber-200 bg-amber-500/10 ring-1 ring-amber-500/30 rounded px-3 py-2 flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" /> Building history: {data.warming.missing_days} day(s) still aggregating in the background. Older figures fill in automatically.
        </div>
      )}
      {g?.ok === false && (
        <div className="text-xs text-rose-200 bg-rose-500/10 ring-1 ring-rose-500/30 rounded px-3 py-2 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <div><b>Dialing is blocked by the balance guard.</b> {g.reasons.join(' · ')}</div>
        </div>
      )}

      {/* ---------------------------------------------------------------- live strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <Kpi label="Active calls" value={n0(live?.active?.length)} sub={`${runningCount} campaign${runningCount === 1 ? '' : 's'} running`} tone={live?.active?.length ? 'green' : 'slate'} icon={Phone} />
        <Kpi label="Dials / min" value={n0(live?.dials_per_min)} sub={`${n0(live?.last5?.dials)} in last 5 min`} icon={Gauge} />
        <Kpi label="Connect (5m)" value={pct(live?.last5?.connect_rate)} sub={`${live?.last5?.sip503 || 0} × SIP 503`} tone={live?.last5?.dials ? (live.last5.connect_rate < 40 ? 'red' : 'slate') : 'slate'} />
        <Kpi label="Human (5m)" value={pct(live?.last5?.human_rate)} sub={`${n0(live?.last5?.voicemail)} machines`} tone={live?.last5?.human_rate >= 45 ? 'green' : 'slate'} icon={Users} />
        <Kpi label="Last hour" value={n0(lh.dials)} sub={`${n0(lh.human)} human · ${n0(lh.appointments)} appts`} icon={Clock} />
        <Kpi label="Spend / hour" value={usd(data?.spend_per_hour)} sub={`${usd(lh.cost)} last hour`} icon={DollarSign} />
        <Kpi label="Trunk connect" value={live?.trunk?.connectRate != null ? pct(live.trunk.connectRate) : '—'} sub={live?.trunk?.lastStatus ? `last SIP ${live.trunk.lastStatus}` : 'rolling window'} tone={live?.trunk?.tripped ? 'red' : 'slate'} icon={Zap} />
        <Kpi label="Remaining leads" value={data?.remaining != null ? n0(data.remaining) : (live?.runners?.[0]?.remaining != null ? n0(live.runners[0].remaining) : '—')} sub={campaignId ? 'selected campaign' : (live?.runners?.[0]?.name || 'select a campaign')} />
      </div>

      {/* ---------------------------------------------------------------- runners */}
      {(live?.runners?.length > 0 || campaigns.some((c) => c.status === 'running')) && (
        <Panel title="Campaign control">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {(live?.runners || []).map((r) => (
              <div key={r.campaignId} className="flex items-center justify-between gap-3 bg-slate-800/50 rounded-md px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-slate-100 truncate">{r.name}</div>
                  <div className="text-[11px] text-slate-400">
                    {r.pausedFor ? <span className="text-amber-300">paused ({r.pausedFor})</span> : r.running ? <span className="text-emerald-300">dialing</span> : 'stopped'}
                    {' · '}{r.activeCalls}/{r.concurrency} lines · {n0(r.completedCalls)} done{r.remaining != null ? ` · ${n0(r.remaining)} left` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button disabled={busy[r.campaignId]} onClick={() => act(r.campaignId, 'stop')} title="Stop after live calls finish" className="p-1.5 rounded bg-slate-700/70 hover:bg-slate-600 text-slate-200"><Pause className="w-3.5 h-3.5" /></button>
                  <button disabled={busy[r.campaignId]} onClick={() => act(r.campaignId, 'kill')} title="Force-stop (cuts live calls)" className="p-1.5 rounded bg-rose-600/70 hover:bg-rose-500 text-white"><Square className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
            {campaigns.filter((c) => !(live?.runners || []).some((r) => r.campaignId === c.id) && (c.status === 'running' || c.id === campaignId)).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 bg-slate-800/30 rounded-md px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-slate-200 truncate">{c.name}</div>
                  <div className="text-[11px] text-slate-500">{c.status === 'running' ? 'marked running — waiting for schedule window' : c.status}</div>
                </div>
                <button disabled={busy[c.id]} onClick={() => act(c.id, 'start')} className="p-1.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white shrink-0" title="Start"><Play className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ---------------------------------------------------------------- range KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Kpi label="Dials" value={n0(t.dials)} sub={`${pct(t.connect_rate)} connected`} icon={Phone} />
        <Kpi label="SIP 503 rate" value={pct(t.sip503_rate)} sub={`${n0(t.sip503)} rejected · ${pct(t.error_rate)} all errors`} tone={t.sip503_rate >= 15 ? 'red' : t.sip503_rate >= 5 ? 'amber' : 'slate'} icon={ShieldAlert} />
        <Kpi label="Human reached" value={n0(t.human)} sub={`${pct(t.human_rate)} of connected`} tone="blue" icon={Users} />
        <Kpi label="Voicemail" value={n0(t.voicemail)} sub={`${pct(t.voicemail_rate)} · ${usd(t.vm_cost)} wasted (${pct(t.vm_cost_share)})`} tone={t.voicemail_rate >= 50 ? 'amber' : 'slate'} icon={PhoneOff} />
        <Kpi label="Appointments" value={n0(t.appointments)} sub={`${pct(t.appt_per_human)} of humans · ${n0(t.callbacks)} callbacks`} tone="green" icon={CalendarCheck} />
        <Kpi label="Cost / appt" value={usd(t.cost_per_appt, 0)} sub={`${usd(t.cost_per_human)} per human · ${usd(t.cost_per_dial)} per dial`} tone="violet" icon={DollarSign} />
        <Kpi label="Spend" value={usd(t.cost)} sub={`VoIP ${usd(t.voip_cost)} · AI ${usd(t.ai_cost)} · ${n0(t.minutes)} min`} icon={Flame} />
      </div>

      {/* ---------------------------------------------------------------- funnel + recommendations */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <Panel title="Funnel" className="xl:col-span-1">
          <div className="space-y-1.5">
            {funnel.map((f, i) => {
              const prev = i ? funnel[i - 1].v : f.v;
              const w = t.dials ? Math.max(2, 100 * (f.v || 0) / t.dials) : 0;
              return (
                <div key={f.label} className="flex items-center gap-2 text-[11.5px]">
                  <span className="w-24 text-slate-400 shrink-0">{f.label}</span>
                  <div className="flex-1 h-5 bg-slate-800/60 rounded-sm overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-600/70 to-emerald-400/70" style={{ width: `${w}%` }} />
                  </div>
                  <span className="w-16 text-right text-slate-100">{n0(f.v)}</span>
                  <span className="w-12 text-right text-slate-500">{i ? pct(prev ? 100 * (f.v || 0) / prev : 0) : ''}</span>
                </div>
              );
            })}
            <div className="grid grid-cols-3 gap-2 pt-2 text-[11px] text-slate-400">
              <div>Avg human talk <span className="text-slate-100 block text-sm">{secs(t.avg_human_seconds)}</span></div>
              <div>Avg VM before hang-up <span className="text-slate-100 block text-sm">{secs(t.avg_vm_seconds)}</span></div>
              <div>Engaged of humans <span className="text-slate-100 block text-sm">{pct(t.engaged_rate)}</span></div>
            </div>
          </div>
        </Panel>

        <Panel title="Signals & recommendations" className="xl:col-span-2">
          {!(data?.recommendations || []).length ? (
            <p className="text-xs text-slate-500">Nothing to flag in this range.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {data.recommendations.map((r, i) => {
                const st = r.level === 'critical' ? 'ring-rose-500/40 bg-rose-500/10' : r.level === 'warning' ? 'ring-amber-500/40 bg-amber-500/10' : 'ring-sky-500/30 bg-sky-500/5';
                const Icon = r.level === 'critical' ? ShieldAlert : r.level === 'warning' ? AlertTriangle : Info;
                const ic = r.level === 'critical' ? 'text-rose-300' : r.level === 'warning' ? 'text-amber-300' : 'text-sky-300';
                return (
                  <div key={i} className={`rounded-md ring-1 px-3 py-2 ${st}`}>
                    <div className="flex items-start gap-2">
                      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${ic}`} />
                      <div className="min-w-0">
                        <div className="text-[12.5px] text-slate-100 font-medium">{r.title}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{r.detail}</div>
                        {r.metric && <div className="text-[10px] text-slate-500 mt-1">{r.metric}</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* ---------------------------------------------------------------- time series */}
      <Panel title={`Activity · ${range === 'today' ? '15-minute' : range === '7d' ? 'hourly' : 'daily'} buckets (${HOUSE_TZ.split('/')[1]} time)`}
        right={<Seg value={seriesMode} onChange={setSeriesMode} options={[{ value: 'volume', label: 'Volume' }, { value: 'rates', label: 'Rates' }, { value: 'money', label: 'Money' }]} />}>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={seriesData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} interval="preserveStartEnd" minTickGap={24} />
            <YAxis yAxisId="l" tick={{ fontSize: 10, fill: '#64748b' }} />
            <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: '#64748b' }} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }} labelStyle={{ color: '#cbd5e1' }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {seriesMode === 'volume' && (<>
              <Bar yAxisId="l" dataKey="human" stackId="a" fill="#38bdf8" name="Human" />
              <Bar yAxisId="l" dataKey="machines" stackId="a" fill="#f59e0b" name="Voicemail" />
              <Bar yAxisId="l" dataKey="failed" stackId="a" fill="#475569" name="No answer / error" />
              <Line yAxisId="r" type="monotone" dataKey="appointments" stroke="#34d399" strokeWidth={2} dot={false} name="Appointments" />
            </>)}
            {seriesMode === 'rates' && (<>
              <Area yAxisId="l" type="monotone" dataKey="connect_rate" stroke="#a78bfa" fill="#a78bfa22" name="Connect %" />
              <Line yAxisId="l" type="monotone" dataKey="human_rate" stroke="#38bdf8" strokeWidth={2} dot={false} name="Human %" />
              <Line yAxisId="l" type="monotone" dataKey="voicemail_rate" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="Voicemail %" />
              <Line yAxisId="r" type="monotone" dataKey="sip503_rate" stroke="#f43f5e" strokeWidth={1.5} dot={false} name="SIP 503 %" />
            </>)}
            {seriesMode === 'money' && (<>
              <Bar yAxisId="l" dataKey="cost" fill="#6366f1" name="Spend $" />
              <Bar yAxisId="l" dataKey="vm_cost" fill="#f59e0b" name="Voicemail $" />
              <Line yAxisId="r" type="monotone" dataKey="cost_per_human" stroke="#e2e8f0" strokeWidth={1.5} dot={false} name="$ / human" />
            </>)}
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>

      {/* ---------------------------------------------------------------- hour of day + heatmap */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Panel title={`Hour of day · human rate vs volume (${HOUSE_TZ.split('/')[1]}; Toronto = ${diff >= 0 ? '+' : ''}${diff}h)`}>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={(data?.hours || []).filter((h) => h.dials > 0)} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: '#64748b' }} />
              <YAxis yAxisId="r" orientation="right" domain={[0, 100]} tick={{ fontSize: 10, fill: '#64748b' }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="l" dataKey="dials" fill="#334155" name="Dials" />
              <Bar yAxisId="l" dataKey="appointments" fill="#34d399" name="Appts" />
              <Line yAxisId="r" type="monotone" dataKey="human_rate" stroke="#38bdf8" strokeWidth={2} name="Human %" />
              <Line yAxisId="r" type="monotone" dataKey="voicemail_rate" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="VM %" />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Weekday × hour" right={<Seg value={heatMetric} onChange={setHeatMetric} options={[{ value: 'human_rate', label: 'Human %' }, { value: 'appt_per_dial', label: 'Appt / 100 dials' }, { value: 'dials', label: 'Dials' }]} />}>
          <Heatmap cells={data?.heatmap || []} metric={heatMetric} />
        </Panel>
      </div>

      {/* ---------------------------------------------------------------- tables */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Panel title="Campaigns">
          <DataTable rows={data?.campaigns || []} defaultSort="dials" onRowClick={(r) => r.id && r.id !== '(none)' && setCampaignId(r.id)}
            columns={perfColumns({ key: 'name', label: 'Campaign', align: 'left', fmt: (v, r) => <span>{v}{r.status === 'running' && <span className="ml-1.5 text-emerald-400">●</span>}</span> })} />
        </Panel>
        <Panel title="AI agents (persona / model)">
          <DataTable rows={data?.agents || []} defaultSort="dials"
            columns={perfColumns({ key: 'name', label: 'Agent', align: 'left', fmt: (v, r) => <span>{v} <span className="text-slate-500">{r.llm_model || ''}</span></span> })} />
        </Panel>
        <Panel title="Regions (area code → province)">
          <DataTable rows={data?.regions || []} defaultSort="dials" rowKey="region"
            columns={perfColumns({ key: 'region', label: 'Region', align: 'left' })} />
        </Panel>
        <Panel title="Carrier responses (failed dials)">
          <DataTable rows={data?.sip || []} defaultSort="count" rowKey="code" maxRows={12}
            columns={[
              { key: 'code', label: 'Code', align: 'left', fmt: (v) => <span className="font-mono">{v}</span> },
              { key: 'label', label: 'Meaning', align: 'left' },
              { key: 'count', label: 'Count', fmt: n0 },
              { key: 'share', label: '% of dials', fmt: pct, tone: (r) => (r.code === '503' && r.share >= 15 ? 'text-rose-300' : '') },
            ]} />
          {inventory && (
            <div className="mt-4 pt-3 border-t border-slate-800">
              <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Lead inventory · {inventory.campaign.name}</div>
              <div className="flex items-center gap-3 text-[11.5px] mb-2">
                <span className="text-slate-100">{n0(inventory.callable)} callable</span>
                <span className="text-slate-500">of {n0(inventory.total)} · {n0(inventory.dnc)} DNC</span>
              </div>
              <div className="flex h-3 rounded overflow-hidden bg-slate-800">
                {inventory.by_status.map((s) => {
                  const col = { new: '#38bdf8', voicemail: '#f59e0b', no_answer: '#64748b', contacted: '#a78bfa', failed: '#f43f5e', completed: '#34d399', callback: '#c084fc', appointment_set: '#10b981', do_not_call: '#7f1d1d' }[s.status] || '#475569';
                  return <div key={s.status} title={`${s.status}: ${n0(s.n)}`} style={{ width: `${100 * s.n / inventory.total}%`, background: col }} />;
                })}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[10.5px] text-slate-400">
                {inventory.by_status.map((s) => <span key={s.status}>{s.status.replace(/_/g, ' ')} <span className="text-slate-200">{n0(s.n)}</span></span>)}
              </div>
              <div className="flex flex-wrap gap-x-3 mt-1.5 text-[10.5px] text-slate-500">
                attempts: {inventory.by_attempts.map((a) => <span key={a.attempts}>{a.attempts}× <span className="text-slate-300">{n0(a.n)}</span></span>)}
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* ---------------------------------------------------------------- tape */}
      <Panel title="Live tape · last 25 calls" right={<span className="text-[10px] text-slate-500">{live?.now ? `server ${fmtTime(live.now)} ${HOUSE_TZ.split('/')[1]}` : ''}</span>}>
        <div className="overflow-x-auto -mx-3 -mb-3">
          <table className="w-full text-[11.5px]">
            <tbody>
              {(live?.recent || []).map((c) => (
                <tr key={c.id || c.call_id} className="border-t border-slate-800/70">
                  <td className="px-3 py-1 text-slate-500 whitespace-nowrap w-20">{c.started_at ? fmtTime(c.started_at) : ''}</td>
                  <td className="px-3 py-1 text-slate-200 whitespace-nowrap">{c.lead_name || <span className="text-slate-500">unknown</span>}</td>
                  <td className="px-3 py-1 text-slate-400 font-mono whitespace-nowrap">{c.phone}</td>
                  <td className="px-3 py-1 text-slate-500 truncate max-w-[180px]">{c.campaign}</td>
                  <td className="px-3 py-1 whitespace-nowrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ring-1 ${OUTCOME_STYLE[c.outcome] || 'bg-slate-500/20 text-slate-300 ring-slate-500/40'}`}>{(c.outcome || '').replace(/_/g, ' ')}</span>
                    {c.outcome === 'error' && c.error_message && <span className="ml-2 text-[10px] text-rose-400/80">{c.error_message.match(/\b[4-6]\d{2}\b/)?.[0] || c.error_message.slice(0, 24)}</span>}
                  </td>
                  <td className="px-3 py-1 text-right text-slate-400 whitespace-nowrap">{secs(c.duration_seconds)}</td>
                  <td className="px-3 py-1 text-right text-slate-400 whitespace-nowrap">{usd(c.call_cost)}</td>
                </tr>
              ))}
              {!(live?.recent || []).length && <tr><td className="px-3 py-2 text-slate-500 text-xs">No calls yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="text-[10px] text-slate-600 pb-2 flex items-center gap-1.5"><ShieldCheck className="w-3 h-3" /> Human = connected and not voicemail. Connected = dial minus carrier errors and no-answer. Times are {HOUSE_TZ}; the market runs {Math.abs(diff)}h behind.</p>
    </div>
  );
}
