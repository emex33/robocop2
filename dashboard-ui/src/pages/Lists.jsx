import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { Plus, List, Upload, Trash2, ChevronRight, X, FileSpreadsheet, AlertTriangle } from 'lucide-react';

function ConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm, onClose, loading }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm animate-in" onClick={e => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-6 h-6 text-red-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-1">{title}</h3>
          <p className="text-sm text-gray-500">{message}</p>
        </div>
        <div className="px-6 pb-6 flex gap-3">
          <button onClick={onClose} disabled={loading}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition disabled:opacity-50">
            {loading ? 'Deleting...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Lists() {
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedList, setSelectedList] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    api.getLists().then(setLists).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleDelete = async (id) => {
    setDeleting(true);
    try {
      await api.deleteList(id);
      if (selectedList?.id === id) setSelectedList(null);
      load();
    } catch (e) { /* ignore */ }
    setDeleting(false);
    setDeleteConfirm(null);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Lists</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your lead lists</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition">
          <Plus className="w-4 h-4" /> New List
        </button>
      </div>

      <div className="flex gap-6">
        {/* List sidebar */}
        <div className="w-72 space-y-2 shrink-0">
          {loading ? (
            <div className="py-10 text-center"><div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full mx-auto" /></div>
          ) : lists.length === 0 ? (
            <div className="text-center py-10 bg-white rounded-xl border border-gray-200">
              <List className="w-10 h-10 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-400">No lists yet</p>
            </div>
          ) : lists.map(l => (
            <button key={l.id}
              onClick={() => setSelectedList(l)}
              className={`w-full text-left px-4 py-3 rounded-xl border transition flex items-center justify-between ${
                selectedList?.id === l.id
                  ? 'border-indigo-300 bg-indigo-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}>
              <div>
                <p className="text-sm font-medium text-gray-700">{l.name}</p>
                <p className="text-xs text-gray-400">{l.total_leads} leads</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm(l); }}
                  className="p-1 text-gray-400 hover:text-red-500 rounded transition">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
              </div>
            </button>
          ))}
        </div>

        {/* List detail */}
        <div className="flex-1">
          {selectedList ? (
            <ListDetail listId={selectedList.id} onUpdate={load} />
          ) : (
            <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
              <FileSpreadsheet className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-400">Select a list to view its leads</p>
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateListModal onClose={() => setShowCreate(false)} onCreated={(l) => { setShowCreate(false); load(); setSelectedList(l); }} />
      )}

      {deleteConfirm && (
        <ConfirmModal
          title="Delete List"
          message={`Are you sure you want to delete "${deleteConfirm.name}" and all ${deleteConfirm.total_leads} leads in it? This cannot be undone.`}
          confirmLabel="Delete List"
          loading={deleting}
          onConfirm={() => handleDelete(deleteConfirm.id)}
          onClose={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

function ListDetail({ listId, onUpdate }) {
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [deleteLeadConfirm, setDeleteLeadConfirm] = useState(null);
  const [deletingLead, setDeletingLead] = useState(false);

  const load = () => {
    api.getList(listId).then(setList).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); load(); }, [listId]);

  const handleDeleteLead = async (leadId) => {
    setDeletingLead(true);
    try {
      await api.deleteLead(listId, leadId);
      load();
      onUpdate();
    } catch (e) { /* ignore */ }
    setDeletingLead(false);
    setDeleteLeadConfirm(null);
  };

  if (loading) return <div className="py-10 text-center"><div className="animate-spin w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full mx-auto" /></div>;
  if (!list) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-900">{list.name}</h2>
          <p className="text-xs text-gray-400">{list.total_leads} leads</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowAddLead(true)}
            className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-3 py-2 rounded-lg hover:bg-gray-50 transition">
            <Plus className="w-3.5 h-3.5" /> Add Lead
          </button>
          <button onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 text-sm bg-indigo-600 text-white px-3 py-2 rounded-lg hover:bg-indigo-700 transition">
            <Upload className="w-3.5 h-3.5" /> Upload CSV
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Phone</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">First Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Last Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Email</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(list.leads || []).map(l => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 font-mono text-gray-700">{l.phone}</td>
                <td className="px-4 py-2.5 text-gray-700">{l.first_name}</td>
                <td className="px-4 py-2.5 text-gray-700">{l.last_name}</td>
                <td className="px-4 py-2.5 text-gray-500">{l.email || '—'}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{l.status}</span>
                </td>
                <td className="px-2">
                  <button onClick={() => setDeleteLeadConfirm(l)}
                    className="p-1 text-gray-400 hover:text-red-500 rounded transition">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {(list.leads || []).length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No leads. Upload a CSV or add manually.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showUpload && (
        <CsvUploadModal listId={listId} onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); load(); onUpdate(); }} />
      )}

      {showAddLead && (
        <AddLeadModal listId={listId} onClose={() => setShowAddLead(false)} onDone={() => { setShowAddLead(false); load(); onUpdate(); }} />
      )}

      {deleteLeadConfirm && (
        <ConfirmModal
          title="Delete Lead"
          message={`Remove ${deleteLeadConfirm.first_name || deleteLeadConfirm.phone} from this list? This cannot be undone.`}
          confirmLabel="Delete Lead"
          loading={deletingLead}
          onConfirm={() => handleDeleteLead(deleteLeadConfirm.id)}
          onClose={() => setDeleteLeadConfirm(null)}
        />
      )}
    </div>
  );
}

function CsvUploadModal({ listId, onClose, onDone }) {
  const [step, setStep] = useState('upload'); // upload | map | importing | done
  const [file, setFile] = useState(null);
  const [columns, setColumns] = useState([]);
  const [preview, setPreview] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [headerless, setHeaderless] = useState(false);
  const [mapping, setMapping] = useState({});
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [error, setError] = useState('');
  const fileRef = useRef();
  const pollRef = useRef(null);

  const standardFields = ['phone', 'first_name', 'last_name', 'email', 'company', 'country', 'notes'];

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Detect field types from the actual sample values (works even without headers)
  const detectByContent = (cols, preview) => {
    const map = {};
    const used = new Set();
    const sample = (col) => (preview || []).map(r => String(r[col] ?? '').trim()).filter(Boolean);
    const ratio = (arr, test) => (arr.length ? arr.filter(test).length / arr.length : 0);

    // Phone = column with the most values that are 8-15 digits
    let bestPhone = null, bestPhoneScore = 0;
    for (const c of cols) {
      const s = sample(c);
      const r = ratio(s, v => { const d = v.replace(/\D/g, ''); return d.length >= 8 && d.length <= 15; });
      if (r > bestPhoneScore) { bestPhoneScore = r; bestPhone = c; }
    }
    if (bestPhone && bestPhoneScore >= 0.6) { map.phone = bestPhone; used.add(bestPhone); }

    // Email = column whose values contain "@"
    for (const c of cols) {
      if (used.has(c)) continue;
      if (ratio(sample(c), v => v.includes('@')) >= 0.6) { map.email = c; used.add(c); break; }
    }

    // Remaining text columns fill name/company/country/notes by position
    const order = ['first_name', 'last_name', 'company', 'country', 'notes'];
    let oi = 0;
    for (const c of cols) {
      if (used.has(c)) continue;
      const s = sample(c);
      if (ratio(s, v => /[A-Za-z]/.test(v)) < 0.4) continue; // skip empty/numeric leftovers
      while (oi < order.length && map[order[oi]]) oi++;
      if (oi >= order.length) break;
      map[order[oi]] = c;
      used.add(c);
      oi++;
    }
    return map;
  };

  const autoMapColumns = (cols, isHeaderless, preview) => {
    if (isHeaderless) return detectByContent(cols, preview);

    const autoMap = {};
    for (const sf of standardFields) {
      const match = cols.find(c => c.toLowerCase().replace(/[_ ]/g, '') === sf.replace(/_/g, ''));
      if (match) autoMap[sf] = match;
    }
    // If a header file still didn't map the required phone, fall back to content detection
    if (!autoMap.phone) {
      const detected = detectByContent(cols, preview);
      if (detected.phone) autoMap.phone = detected.phone;
    }
    return autoMap;
  };

  const pollImportStatus = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await api.getImportStatus(listId);
        if (status.status === 'running') {
          setImportProgress(status);
        } else if (status.status === 'done') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setImportProgress(status);
          setStep('done');
          setImporting(false);
        } else if (status.status === 'error') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setError(status.error || 'Import failed');
          setImporting(false);
          setStep('map');
        }
      } catch {
        // keep polling
      }
    }, 3000);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const result = await api.uploadCsv(listId, file);
      setColumns(result.columns);
      setPreview(result.preview || []);
      setTotalRows(result.totalRows);
      setHeaderless(!!result.headerless);
      setMapping(autoMapColumns(result.columns, !!result.headerless, result.preview));
      setStep('map');
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleImport = async () => {
    if (!mapping.phone) return setError('You must map the "phone" field');
    setImporting(true);
    setError('');
    try {
      const result = await api.importLeads(listId, mapping);
      if (result.background) {
        setStep('importing');
        setImportProgress({ imported: 0, total: result.count, status: 'running' });
        pollImportStatus();
      } else {
        onDone();
      }
    } catch (err) {
      setError(err.message);
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex justify-between items-center">
          <h3 className="font-bold text-gray-900">Upload CSV</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 text-red-600 text-sm rounded-lg px-4 py-3">{error}</div>}

          {step === 'upload' && (
            <>
              <div
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-indigo-400 transition"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-600">{file ? file.name : 'Click to select a CSV file'}</p>
                <p className="text-xs text-gray-400 mt-1">Max 50MB</p>
                <input ref={fileRef} type="file" accept=".csv" className="hidden"
                  onChange={e => setFile(e.target.files[0])} />
              </div>
              <button onClick={handleUpload} disabled={!file || uploading}
                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition">
                {uploading ? 'Uploading...' : 'Upload & Preview'}
              </button>
            </>
          )}

          {step === 'map' && (
            <>
              <p className="text-sm text-gray-600">Found <b>{totalRows.toLocaleString()}</b> rows with {columns.length} columns. Map fields:</p>
              {headerless && (
                <div className="bg-amber-50 text-amber-800 text-sm rounded-lg px-4 py-3">
                  No header row detected — columns are labeled Column 1, 2, 3… We auto-detected the fields from the data. Each dropdown shows a sample value to help you verify.
                </div>
              )}
              <div className="space-y-2 max-h-72 overflow-auto">
                {standardFields.map(sf => {
                  const colLabel = (c) => {
                    const s = preview.find(r => String(r[c] ?? '').trim());
                    const val = s ? String(s[c]).slice(0, 22) : '';
                    return val ? `${c}  (e.g. ${val})` : c;
                  };
                  return (
                    <div key={sf} className="flex items-center gap-3">
                      <label className="text-sm text-gray-700 w-28 shrink-0 font-medium capitalize">
                        {sf.replace(/_/g, ' ')}{sf === 'phone' && <span className="text-red-500"> *</span>}
                      </label>
                      <select value={mapping[sf] || ''} onChange={e => setMapping({ ...mapping, [sf]: e.target.value })}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none">
                        <option value="">— Skip —</option>
                        {columns.map(c => <option key={c} value={c}>{colLabel(c)}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
              <button onClick={handleImport} disabled={importing}
                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition">
                {importing ? 'Starting import...' : `Import ${totalRows.toLocaleString()} Leads`}
              </button>
            </>
          )}

          {step === 'importing' && (
            <div className="text-center py-6 space-y-3">
              <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto" />
              <p className="text-sm font-medium text-gray-900">Importing leads in the background...</p>
              {importProgress && (
                <p className="text-sm text-gray-500">
                  {importProgress.imported?.toLocaleString() || 0} / {importProgress.total?.toLocaleString()} processed
                </p>
              )}
              <p className="text-xs text-gray-400">Large files can take several minutes. You can close this and refresh the list later.</p>
              <button onClick={onDone} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
                Close and refresh list
              </button>
            </div>
          )}

          {step === 'done' && (
            <div className="text-center py-6 space-y-3">
              <p className="text-sm font-medium text-green-700">
                Import complete — {importProgress?.imported?.toLocaleString()} leads added.
              </p>
              <button onClick={onDone}
                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition">
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AddLeadModal({ listId, onClose, onDone }) {
  const [form, setForm] = useState({ phone: '', first_name: '', last_name: '', email: '' });
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSave = async () => {
    if (!form.phone.trim()) return;
    setSaving(true);
    try {
      await api.addLead(listId, form);
      onDone();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b"><h3 className="font-bold text-gray-900">Add Lead</h3></div>
        <div className="p-6 space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone *</label>
            <input type="text" value={form.phone} onChange={set('phone')} autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" placeholder="447520656059" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
              <input type="text" value={form.first_name} onChange={set('first_name')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
              <input type="text" value={form.last_name} onChange={set('last_name')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={form.email} onChange={set('email')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" />
          </div>
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition">
            {saving ? 'Adding...' : 'Add Lead'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateListModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const list = await api.createList({ name, description: desc });
      onCreated(list);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b"><h3 className="font-bold text-gray-900">Create List</h3></div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">List Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500" placeholder="My Leads" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none" placeholder="Optional description" />
          </div>
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition">Cancel</button>
          <button onClick={handleCreate} disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition">
            {saving ? 'Creating...' : 'Create List'}
          </button>
        </div>
      </div>
    </div>
  );
}
