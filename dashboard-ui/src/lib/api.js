/**
 * API Client - handles auth tokens and requests
 */

const BASE = '/api';

export function getToken() {
  return localStorage.getItem('robocop_token');
}

export function setToken(token) {
  localStorage.setItem('robocop_token', token);
}

export function clearToken() {
  localStorage.removeItem('robocop_token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email, password, name, company) => request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name, company }) }),
  getProfile: () => request('/auth/profile'),

  // Agents
  getAgents: () => request('/agents'),
  getAgent: (id) => request(`/agents/${id}`),
  createAgent: (data) => request('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id, data) => request(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id) => request(`/agents/${id}`, { method: 'DELETE' }),
  duplicateAgent: (id) => request(`/agents/${id}/duplicate`, { method: 'POST' }),
  testAgent: (data) => request('/agents/test', { method: 'POST', body: JSON.stringify(data) }),

  // Campaigns
  getCampaigns: () => request('/campaigns'),
  getCampaign: (id) => request(`/campaigns/${id}`),
  createCampaign: (data) => request('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
  updateCampaign: (id, data) => request(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCampaign: (id) => request(`/campaigns/${id}`, { method: 'DELETE' }),
  startCampaign: (id) => request(`/campaigns/${id}/start`, { method: 'POST' }),
  stopCampaign: (id, { force = false } = {}) => request(`/campaigns/${id}/stop?force=${force}`, { method: 'POST' }),
  getCampaignLeads: (id, page) => request(`/campaigns/${id}/leads?page=${page || 1}`),
  getCampaignCalls: (id, page) => request(`/campaigns/${id}/calls?page=${page || 1}`),
  getCampaignAnalytics: (id) => request(`/campaigns/${id}/analytics`),
  getCampaignLogs: (id) => request(`/campaigns/${id}/logs`),
  getCampaignStatus: (id) => request(`/campaigns/${id}/status`),

  // Extensions
  getExtensions: (campaignId) => request(`/campaigns/${campaignId}/extensions`),
  addExtension: (campaignId, data) => request(`/campaigns/${campaignId}/extensions`, { method: 'POST', body: JSON.stringify(data) }),
  addExtensionsBulk: (campaignId, extensions) => request(`/campaigns/${campaignId}/extensions/bulk`, { method: 'POST', body: JSON.stringify({ extensions }) }),
  deleteExtension: (campaignId, extId) => request(`/campaigns/${campaignId}/extensions/${extId}`, { method: 'DELETE' }),
  toggleExtension: (campaignId, extId, active) => request(`/campaigns/${campaignId}/extensions/${extId}`, { method: 'PATCH', body: JSON.stringify({ active }) }),

  // Campaign lists
  assignList: (campaignId, listId) => request(`/campaigns/${campaignId}/lists`, { method: 'POST', body: JSON.stringify({ list_id: listId }) }),
  removeList: (campaignId, listId) => request(`/campaigns/${campaignId}/lists/${listId}`, { method: 'DELETE' }),

  // Lists
  getLists: () => request('/lists'),
  getList: (id, page) => request(`/lists/${id}?page=${page || 1}`),
  createList: (data) => request('/lists', { method: 'POST', body: JSON.stringify(data) }),
  updateList: (id, data) => request(`/lists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteList: (id) => request(`/lists/${id}`, { method: 'DELETE' }),
  addLead: (listId, data) => request(`/lists/${listId}/leads`, { method: 'POST', body: JSON.stringify(data) }),
  deleteLead: (listId, leadId) => request(`/lists/${listId}/leads/${leadId}`, { method: 'DELETE' }),

  // Upload CSV (special - uses FormData)
  uploadCsv: async (listId, file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${BASE}/lists/${listId}/upload`, {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  },
  importLeads: (listId, mapping) => request(`/lists/${listId}/import`, { method: 'POST', body: JSON.stringify({ mapping }) }),

  // SIP Trunks
  getSipTrunks: () => request('/settings/sip'),
  getSipTrunk: (id) => request(`/settings/sip/${id}`),
  createSipTrunk: (data) => request('/settings/sip', { method: 'POST', body: JSON.stringify(data) }),
  updateSipTrunk: (id, data) => request(`/settings/sip/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSipTrunk: (id) => request(`/settings/sip/${id}`, { method: 'DELETE' }),
  setDefaultSipTrunk: (id) => request(`/settings/sip/${id}/default`, { method: 'POST' }),
  testSipTrunk: (id) => request(`/settings/sip/${id}/test`, { method: 'POST' }),

  // Legacy aliases
  getSipSettings: () => request('/settings/sip'),
  updateSipSettings: (data) => request('/settings/sip', { method: 'PUT', body: JSON.stringify(data) }),
  testSipSettings: () => request('/settings/sip/test', { method: 'POST' }),

  // Deepgram Settings (multi-key pool)
  getDeepgramSettings: () => request('/settings/deepgram'),
  addDeepgramKey: (api_key, label) => request('/settings/deepgram/keys', { method: 'POST', body: JSON.stringify({ api_key, label }) }),
  updateDeepgramKey: (keyId, data) => request(`/settings/deepgram/keys/${keyId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDeepgramKey: (keyId) => request(`/settings/deepgram/keys/${keyId}`, { method: 'DELETE' }),
  reactivateDeepgramKey: (keyId) => request(`/settings/deepgram/keys/${keyId}/activate`, { method: 'POST' }),
  setCurrentDeepgramKey: (keyId) => request(`/settings/deepgram/keys/${keyId}/set-current`, { method: 'POST' }),
  testDeepgramKey: (keyId) => request(`/settings/deepgram/keys/${keyId}/test`, { method: 'POST' }),

  // Google Sheets
  getGoogleSheetsStatus: () => request('/settings/google-sheets'),
  saveGoogleSheetsCredentials: (credentials) => request('/settings/google-sheets', { method: 'PUT', body: JSON.stringify({ credentials }) }),
  deleteGoogleSheetsCredentials: () => request('/settings/google-sheets', { method: 'DELETE' }),
  testGoogleSheet: (spreadsheet_id) => request('/settings/google-sheets/test', { method: 'POST', body: JSON.stringify({ spreadsheet_id }) }),

  // Analytics
  getDashboard: () => request('/analytics/dashboard'),

  // Call Logs
  getCalls: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
    return request(`/calls?${q.toString()}`);
  },
  getCall: (id) => request(`/calls/${id}`),
  exportCallsCsv: (params = {}) => {
    const token = localStorage.getItem('robocop_token');
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
    q.set('token', token);
    window.open(`/api/calls/export/csv?${q.toString()}`, '_blank');
  },

  // Reports
  getTransfers: (params = {}) => {
    const q = new URLSearchParams();
    if (params.campaign_id) q.set('campaign_id', params.campaign_id);
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', params.page);
    if (params.limit) q.set('limit', params.limit);
    return request(`/reports/transfers?${q.toString()}`);
  },
  exportTransfersCsv: (campaignId) => {
    const token = localStorage.getItem('robocop_token');
    const params = new URLSearchParams();
    if (campaignId) params.set('campaign_id', campaignId);
    params.set('token', token);
    window.open(`/api/reports/transfers/export?${params.toString()}`, '_blank');
  },

  // Callbacks
  getCallbacks: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
    return request(`/callbacks?${q.toString()}`);
  },
  updateCallback: (id, data) => request(`/callbacks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  exportCallbacksCsv: (params = {}) => {
    const token = localStorage.getItem('robocop_token');
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
    q.set('token', token);
    window.open(`/api/callbacks/export/csv?${q.toString()}`, '_blank');
  },

  // Appointments
  getAppointments: (params = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.campaign_id) q.set('campaign_id', params.campaign_id);
    return request(`/appointments?${q.toString()}`);
  },
  getAppointment: (id) => request(`/appointments/${id}`),
  createAppointment: (data) => request('/appointments', { method: 'POST', body: JSON.stringify(data) }),
  updateAppointment: (id, data) => request(`/appointments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAppointment: (id) => request(`/appointments/${id}`, { method: 'DELETE' }),
  getAppointmentStats: () => request('/appointments/stats/summary'),

  // SIP Agents (Human Agents with Softphone)
  getSipAgents: () => request('/sip-agents'),
  getSipAgent: (id) => request(`/sip-agents/${id}`),
  createSipAgent: (data) => request('/sip-agents', { method: 'POST', body: JSON.stringify(data) }),
  updateSipAgent: (id, data) => request(`/sip-agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSipAgent: (id) => request(`/sip-agents/${id}`, { method: 'DELETE' }),
  registerSipAgent: (id) => request(`/sip-agents/${id}/register`, { method: 'POST' }),
  unregisterSipAgent: (id) => request(`/sip-agents/${id}/unregister`, { method: 'POST' }),
  sipAgentCall: (id, destination) => request(`/sip-agents/${id}/call`, { method: 'POST', body: JSON.stringify({ destination }) }),
  sipAgentAnswerCall: (callId) => request(`/sip-agents/calls/${callId}/answer`, { method: 'POST' }),
  sipAgentRejectCall: (callId) => request(`/sip-agents/calls/${callId}/reject`, { method: 'POST' }),
  sipAgentHangupCall: (callId) => request(`/sip-agents/calls/${callId}/hangup`, { method: 'POST' }),
  getAvailableSipAgents: () => request('/sip-agents/available/transfer'),
  getSipAgentCalls: (id) => request(`/sip-agents/${id}/calls`),

  // Agent Users (Softphone login credentials)
  getAgentUsers: () => request('/agent-users'),
  getAgentUser: (id) => request(`/agent-users/${id}`),
  createAgentUser: (data) => request('/agent-users', { method: 'POST', body: JSON.stringify(data) }),
  updateAgentUser: (id, data) => request(`/agent-users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgentUser: (id) => request(`/agent-users/${id}`, { method: 'DELETE' }),
  
  // Billing
  getBillingBalance: () => request('/billing/balance'),
  getBillingTransactions: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
    return request(`/billing/transactions?${q.toString()}`);
  },
  getBillingUsage: () => request('/billing/usage'),

  // Admin (super admin only)
  adminGetUsers: () => request('/admin/users'),
  adminGetUser: (id) => request(`/admin/users/${id}`),
  adminAddCredits: (userId, amount, description) => request(`/admin/users/${userId}/credits`, { method: 'POST', body: JSON.stringify({ amount, description }) }),
  adminGetBilling: () => request('/admin/billing'),
  adminGetUserSip: (userId) => request(`/admin/users/${userId}/sip`),
  adminUpdateUserSip: (userId, data) => request(`/admin/users/${userId}/sip`, { method: 'PUT', body: JSON.stringify(data) }),
  adminTestUserSip: (userId) => request(`/admin/users/${userId}/sip/test`, { method: 'POST' }),
  adminGetUserAgents: (userId) => request(`/admin/users/${userId}/agents`),
  adminGetTransactions: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, v); });
    return request(`/admin/billing/transactions?${q.toString()}`);
  },

  // Agent login (public endpoint)
  agentLogin: (username, password, adminCode) => fetch(`${BASE}/agent-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, admin_code: adminCode }),
  }).then(async res => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    return data;
  }),
};
