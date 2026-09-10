import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, Copy, Bot, ChevronRight, Play, CheckCircle2, XCircle, Loader2, Info, PhoneForwarded, CalendarCheck } from 'lucide-react';

export default function Agents() {
  const { isSuperAdmin } = useAuth();
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = () => {
    if (isSuperAdmin) api.getAgents().then(setAgents).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, [isSuperAdmin]);

  if (!isSuperAdmin) return <Navigate to="/" replace />;

  const handleDelete = async (id) => {
    if (!confirm('Delete this agent?')) return;
    await api.deleteAgent(id);
    load();
  };

  const handleDuplicate = async (id) => {
    await api.duplicateAgent(id);
    load();
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your AI calling agents</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowModal(true); }}
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition"
        >
          <Plus className="w-4 h-4" /> New Agent
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" />
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <Bot className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No agents yet. Create your first AI agent.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents.map(agent => (
            <div key={agent.id} className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
                    <Bot className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{agent.name}</h3>
                    <p className="text-xs text-gray-400">{agent.language} · {agent.tone}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                  <button onClick={() => handleDuplicate(agent.id)}
                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition" title="Duplicate">
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => { setEditing(agent); setShowModal(true); }}
                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition" title="Edit">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(agent.id)}
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition" title="Delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {agent.company && <p className="text-xs text-gray-500 mb-2">{agent.company}</p>}

              <div className="flex flex-wrap gap-1.5 mb-3">
                {(agent.mode || 'live_transfer') === 'live_transfer' ? (
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <PhoneForwarded className="w-3 h-3" /> Live Transfer
                  </span>
                ) : (
                  <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <CalendarCheck className="w-3 h-3" /> Appointment
                  </span>
                )}
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{agent.llm_model}</span>
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{agent.stt_model}</span>
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{agent.tts_model}</span>
              </div>

              <p className="text-xs text-gray-400 line-clamp-2">
                {agent.script?.slice(0, 120)}{agent.script?.length > 120 ? '...' : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <AgentModal
          agent={editing}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); load(); }}
        />
      )}
    </div>
  );
}

// ===== Provider → Model catalogs =====
const LLM_PROVIDERS = {
  open_ai: {
    label: 'OpenAI',
    models: [
      { id: 'gpt-5.2', name: 'GPT 5.2' },
      { id: 'gpt-5.2-instant', name: 'GPT 5.2 Instant' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
      { id: 'gpt-5-nano', name: 'GPT-5 nano' },
      { id: 'gpt-5.1-chat-latest', name: 'GPT-5.1 Instant' },
      { id: 'gpt-5.1', name: 'GPT-5.1 Thinking' },
    ],
  },
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'claude-4-5-haiku-latest', name: 'Claude Haiku 4.5' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude Haiku 3.5' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ],
  },
  google: {
    label: 'Google',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.0 Flash Lite' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3.0 Flash Preview' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3.0 Pro Preview' },
    ],
  },
  groq: {
    label: 'Groq',
    models: [
      { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B' },
    ],
    requiresEndpoint: true,
  },
};

const STT_PROVIDERS = {
  deepgram: {
    label: 'Default',
    models: [
      { id: 'flux-general-en', name: 'Flux (Voice Agent Optimized, ~260ms latency)', version: 'v2', recommended: true },
      { id: 'nova-3', name: 'Nova-3 (Multilingual)', version: 'v1' },
      { id: 'nova-2', name: 'Nova-2', version: 'v1' },
      { id: 'nova', name: 'Nova', version: 'v1' },
      { id: 'enhanced', name: 'Enhanced', version: 'v1' },
      { id: 'base', name: 'Base', version: 'v1' },
    ],
  },
};

// Voice models grouped by language
const DEEPGRAM_VOICES = {
  en: [
    { id: 'aura-2-thalia-en', name: 'Thalia (Female, US)' },
    { id: 'aura-2-andromeda-en', name: 'Andromeda (Female, US)' },
    { id: 'aura-2-athena-en', name: 'Athena (Female, US)' },
    { id: 'aura-2-luna-en', name: 'Luna (Female, US)' },
    { id: 'aura-2-hera-en', name: 'Hera (Female, US)' },
    { id: 'aura-2-aurora-en', name: 'Aurora (Female, US)' },
    { id: 'aura-2-callista-en', name: 'Callista (Female, US)' },
    { id: 'aura-2-cora-en', name: 'Cora (Female, US)' },
    { id: 'aura-2-cordelia-en', name: 'Cordelia (Female, US)' },
    { id: 'aura-2-delia-en', name: 'Delia (Female, US)' },
    { id: 'aura-2-electra-en', name: 'Electra (Female, US)' },
    { id: 'aura-2-harmonia-en', name: 'Harmonia (Female, US)' },
    { id: 'aura-2-helena-en', name: 'Helena (Female, US)' },
    { id: 'aura-2-iris-en', name: 'Iris (Female, US)' },
    { id: 'aura-2-juno-en', name: 'Juno (Female, US)' },
    { id: 'aura-2-minerva-en', name: 'Minerva (Female, US)' },
    { id: 'aura-2-ophelia-en', name: 'Ophelia (Female, US)' },
    { id: 'aura-2-phoebe-en', name: 'Phoebe (Female, US)' },
    { id: 'aura-2-selene-en', name: 'Selene (Female, US)' },
    { id: 'aura-2-vesta-en', name: 'Vesta (Female, US)' },
    { id: 'aura-2-amalthea-en', name: 'Amalthea (Female, PH)' },
    { id: 'aura-2-pandora-en', name: 'Pandora (Female, GB)' },
    { id: 'aura-2-theia-en', name: 'Theia (Female, AU)' },
    { id: 'aura-2-orion-en', name: 'Orion (Male, US)' },
    { id: 'aura-2-arcas-en', name: 'Arcas (Male, US)' },
    { id: 'aura-2-orpheus-en', name: 'Orpheus (Male, US)' },
    { id: 'aura-2-zeus-en', name: 'Zeus (Male, US)' },
    { id: 'aura-2-apollo-en', name: 'Apollo (Male, US)' },
    { id: 'aura-2-aries-en', name: 'Aries (Male, US)' },
    { id: 'aura-2-asteria-en', name: 'Asteria (Male, US)' },
    { id: 'aura-2-atlas-en', name: 'Atlas (Male, US)' },
    { id: 'aura-2-hermes-en', name: 'Hermes (Male, US)' },
    { id: 'aura-2-janus-en', name: 'Janus (Male, US)' },
    { id: 'aura-2-jupiter-en', name: 'Jupiter (Male, US)' },
    { id: 'aura-2-mars-en', name: 'Mars (Male, US)' },
    { id: 'aura-2-neptune-en', name: 'Neptune (Male, US)' },
    { id: 'aura-2-odysseus-en', name: 'Odysseus (Male, US)' },
    { id: 'aura-2-pluto-en', name: 'Pluto (Male, US)' },
    { id: 'aura-2-saturn-en', name: 'Saturn (Male, US)' },
    { id: 'aura-2-draco-en', name: 'Draco (Male, GB)' },
    { id: 'aura-2-hyperion-en', name: 'Hyperion (Male, AU)' },
  ],
  es: [
    { id: 'aura-2-celeste-es', name: 'Celeste (Female, CO)' },
    { id: 'aura-2-agustina-es', name: 'Agustina (Female, ES)' },
    { id: 'aura-2-antonia-es', name: 'Antonia (Female, AR)' },
    { id: 'aura-2-aquila-es', name: 'Aquila (Female, LATAM)' },
    { id: 'aura-2-carina-es', name: 'Carina (Female, ES)' },
    { id: 'aura-2-diana-es', name: 'Diana (Female, ES)' },
    { id: 'aura-2-estrella-es', name: 'Estrella (Female, MX)' },
    { id: 'aura-2-gloria-es', name: 'Gloria (Female, CO)' },
    { id: 'aura-2-olivia-es', name: 'Olivia (Female, MX)' },
    { id: 'aura-2-selena-es', name: 'Selena (Female, LATAM)' },
    { id: 'aura-2-silvia-es', name: 'Silvia (Female, ES)' },
    { id: 'aura-2-alvaro-es', name: 'Alvaro (Male, ES)' },
    { id: 'aura-2-javier-es', name: 'Javier (Male, MX)' },
    { id: 'aura-2-luciano-es', name: 'Luciano (Male, MX)' },
    { id: 'aura-2-nestor-es', name: 'Nestor (Male, ES)' },
    { id: 'aura-2-sirio-es', name: 'Sirio (Male, MX)' },
    { id: 'aura-2-valerio-es', name: 'Valerio (Male, MX)' },
  ],
  it: [
    { id: 'aura-2-livia-it', name: 'Livia (Female)' },
    { id: 'aura-2-cinzia-it', name: 'Cinzia (Female)' },
    { id: 'aura-2-demetra-it', name: 'Demetra (Female)' },
    { id: 'aura-2-maia-it', name: 'Maia (Female)' },
    { id: 'aura-2-melia-it', name: 'Melia (Female)' },
    { id: 'aura-2-cesare-it', name: 'Cesare (Male)' },
    { id: 'aura-2-dionisio-it', name: 'Dionisio (Male)' },
    { id: 'aura-2-elio-it', name: 'Elio (Male)' },
    { id: 'aura-2-flavio-it', name: 'Flavio (Male)' },
  ],
  de: [
    { id: 'aura-2-aurelia-de', name: 'Aurelia (Female)' },
    { id: 'aura-2-elara-de', name: 'Elara (Female)' },
    { id: 'aura-2-kara-de', name: 'Kara (Female)' },
    { id: 'aura-2-lara-de', name: 'Lara (Female)' },
    { id: 'aura-2-viktoria-de', name: 'Viktoria (Female)' },
    { id: 'aura-2-fabian-de', name: 'Fabian (Male)' },
    { id: 'aura-2-julius-de', name: 'Julius (Male)' },
  ],
  nl: [
    { id: 'aura-2-beatrix-nl', name: 'Beatrix (Female)' },
    { id: 'aura-2-cornelia-nl', name: 'Cornelia (Female)' },
    { id: 'aura-2-daphne-nl', name: 'Daphne (Female)' },
    { id: 'aura-2-hestia-nl', name: 'Hestia (Female)' },
    { id: 'aura-2-leda-nl', name: 'Leda (Female)' },
    { id: 'aura-2-rhea-nl', name: 'Rhea (Female)' },
    { id: 'aura-2-lars-nl', name: 'Lars (Male)' },
    { id: 'aura-2-roman-nl', name: 'Roman (Male)' },
    { id: 'aura-2-sander-nl', name: 'Sander (Male)' },
  ],
  fr: [
    { id: 'aura-2-agathe-fr', name: 'Agathe (Female)' },
    { id: 'aura-2-hector-fr', name: 'Hector (Male)' },
  ],
  ja: [
    { id: 'aura-2-izanami-ja', name: 'Izanami (Female)' },
    { id: 'aura-2-uzume-ja', name: 'Uzume (Female)' },
    { id: 'aura-2-ama-ja', name: 'Ama (Male)' },
    { id: 'aura-2-ebisu-ja', name: 'Ebisu (Male)' },
    { id: 'aura-2-fujin-ja', name: 'Fujin (Male)' },
  ],
};

// Get default voice for a language
function getDefaultVoice(lang) {
  const voices = DEEPGRAM_VOICES[lang] || DEEPGRAM_VOICES['en'];
  return voices[0]?.id || 'aura-2-thalia-en';
}

const TTS_PROVIDERS = {
  deepgram: {
    label: 'Default',
    fieldName: 'model',
    getModels: (lang) => DEEPGRAM_VOICES[lang] || DEEPGRAM_VOICES['en'],
  },
  cartesia: {
    label: 'Cartesia (Managed)',
    fieldName: 'model_id',
    getModels: () => [{ id: 'sonic-2', name: 'Sonic 2 (Multilingual)' }],
    voices: [
      { id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02', name: 'Katie (Female, Stable)' },
      { id: '2ee87190-8f84-4925-97da-e52547f9462c', name: 'Calm Lady (Female)' },
      { id: '79a125e8-cd45-4c13-8a67-188112f4dd22', name: 'British Lady (Female)' },
      { id: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b', name: 'Tessa (Female, Emotive)' },
      { id: '408daed0-c597-4c27-aae8-fa0497d644bf', name: 'Italian Lady (Female)' },
      { id: 'cefcb124-080b-4655-b31f-932f3ee743de', name: 'Spanish Voice (Female)' },
      { id: '228fca29-3a0a-435c-8728-5cb483251068', name: 'Kiefer (Male, Stable)' },
      { id: 'c961b81c-a935-4c17-bfb3-ba2239de8c2f', name: 'Kyle (Male, Emotive)' },
      { id: 'a0e99841-438c-4a64-b679-ae501e7d6091', name: 'Barbershop Man (Male)' },
      { id: 'bf991597-6c13-47e4-8411-91ec2de5c466', name: 'Newsman (Male)' },
      { id: '694f9389-aac1-45b6-b726-9d9369183238', name: 'Friendly Narrator (Male)' },
      { id: '41534e16-2966-4c6b-9670-111411def906', name: 'Storyteller (Male)' },
    ],
  },
  open_ai: {
    label: 'OpenAI TTS (BYO)',
    fieldName: 'model',
    getModels: () => [{ id: 'tts-1', name: 'TTS-1' }, { id: 'tts-1-hd', name: 'TTS-1 HD' }],
    requiresEndpoint: true,
  },
  eleven_labs: {
    label: 'ElevenLabs (Managed)',
    fieldName: 'model_id',
    getModels: () => [{ id: 'eleven_turbo_v2_5', name: 'Turbo v2.5' }, { id: 'eleven_multilingual_v2', name: 'Multilingual v2' }],
  },
};

function AgentModal({ agent, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: agent?.name || '',
    mode: agent?.mode || 'live_transfer',
    language: agent?.language || 'en',
    company: agent?.company || '',
    tone: agent?.tone || 'professional',
    greeting: agent?.greeting || 'Hi, am I speaking with {{first_name}}?',
    script: agent?.script || '',
    appointment_script: agent?.appointment_script || '',
    llm_provider: agent?.llm_provider || 'open_ai',
    llm_model: agent?.llm_model || 'gpt-4o-mini',
    llm_temperature: agent?.llm_temperature ?? 0.7,
    stt_provider: agent?.stt_provider || 'deepgram',
    stt_model: agent?.stt_model || 'nova-3',
    tts_provider: agent?.tts_provider || 'deepgram',
    tts_model: (() => {
      const prov = agent?.tts_provider || 'deepgram';
      const lang = agent?.language || 'en';
      const saved = agent?.tts_model || getDefaultVoice(lang);
      const valid = (TTS_PROVIDERS[prov]?.getModels(lang) || []).map(m => m.id);
      return valid.includes(saved) ? saved : (valid[0] || getDefaultVoice(lang));
    })(),
    tts_voice_id: agent?.tts_voice_id || '',
    tts_speed: agent?.tts_speed || 'normal',
    eot_threshold: agent?.eot_threshold ?? 0.85,
    eot_timeout_ms: agent?.eot_timeout_ms ?? 5000,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('general');
  const [testing, setTesting] = useState(false);
  const [testLogs, setTestLogs] = useState([]);
  const [testResult, setTestResult] = useState(null); // null | true | false

  const set = (key) => (e) => {
    const val = e.target.value;
    // When language changes, auto-switch TTS voice to match
    if (key === 'language' && form.tts_provider === 'deepgram') {
      const voices = DEEPGRAM_VOICES[val] || DEEPGRAM_VOICES['en'];
      setForm({ ...form, language: val, tts_model: voices[0]?.id || 'aura-2-thalia-en' });
      return;
    }
    setForm({ ...form, [key]: val });
  };

  // Auto-select first model when provider changes
  const setProvider = (providerKey, modelKey, catalog) => (e) => {
    const provider = e.target.value;
    if (catalog === TTS_PROVIDERS) {
      const models = catalog[provider]?.getModels(form.language) || [];
      const updates = { ...form, [providerKey]: provider, [modelKey]: models[0]?.id || '' };
      if (provider === 'cartesia') {
        updates.tts_voice_id = catalog[provider].voices[0]?.id || '';
      } else {
        updates.tts_voice_id = '';
      }
      setForm(updates);
    } else {
      const models = catalog[provider]?.models || [];
      setForm({ ...form, [providerKey]: provider, [modelKey]: models[0]?.id || '' });
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestLogs([]);
    setTestResult(null);
    try {
      const res = await api.testAgent(form);
      setTestLogs(res.logs || []);
      setTestResult(res.success);
    } catch (err) {
      setTestLogs([{ time: new Date().toISOString(), level: 'error', message: err.message }]);
      setTestResult(false);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      if (agent) {
        await api.updateAgent(agent.id, form);
      } else {
        await api.createAgent(form);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'script', label: 'Script' },
    { id: 'models', label: 'AI Models' },
  ];

  const llmModels = LLM_PROVIDERS[form.llm_provider]?.models || [];
  const sttModels = STT_PROVIDERS[form.stt_provider]?.models || [];
  const ttsModels = TTS_PROVIDERS[form.tts_provider]?.getModels(form.language) || [];

  const selectCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">{agent ? 'Edit Agent' : 'Create Agent'}</h2>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-gray-100 flex gap-4">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`py-2.5 text-sm font-medium border-b-2 transition ${
                tab === t.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-4">
          {error && <div className="bg-red-50 text-red-600 text-sm rounded-lg px-4 py-3">{error}</div>}

          {tab === 'general' && (
            <>
              {/* Agent Mode Toggle */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Agent Mode</label>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button"
                    onClick={() => setForm({ ...form, mode: 'live_transfer' })}
                    className={`px-4 py-3 rounded-lg border-2 text-left transition ${
                      form.mode === 'live_transfer'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <div className="flex items-center gap-2">
                      <PhoneForwarded className={`w-4 h-4 ${form.mode === 'live_transfer' ? 'text-blue-600' : 'text-gray-400'}`} />
                      <span className="text-sm font-semibold text-gray-800">Live Transfer</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Qualify lead → transfer to human agent</p>
                  </button>
                  <button type="button"
                    onClick={() => setForm({ ...form, mode: 'appointment' })}
                    className={`px-4 py-3 rounded-lg border-2 text-left transition ${
                      form.mode === 'appointment'
                        ? 'border-emerald-500 bg-emerald-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <div className="flex items-center gap-2">
                      <CalendarCheck className={`w-4 h-4 ${form.mode === 'appointment' ? 'text-emerald-600' : 'text-gray-400'}`} />
                      <span className="text-sm font-semibold text-gray-800">Appointment Setting</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Qualify lead → book date & time</p>
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {form.mode === 'live_transfer'
                    ? 'Agent will use transfer_call function to connect qualified leads to a human agent.'
                    : 'Agent will use book_appointment function to collect a date/time from qualified leads.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Agent Name *</label>
                  <input type="text" value={form.name} onChange={set('name')} required
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    placeholder="Sophie Hernandez" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Language</label>
                  <select value={form.language} onChange={set('language')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none">
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="nl">Dutch</option>
                    <option value="ja">Japanese</option>
                    <option value="multi">Multi (Auto-detect)</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Company</label>
                  <input type="text" value={form.company} onChange={set('company')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    placeholder="Acme Corp" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tone</label>
                  <select value={form.tone} onChange={set('tone')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none">
                    <option value="professional">Professional</option>
                    <option value="friendly">Friendly</option>
                    <option value="assertive">Assertive</option>
                    <option value="casual">Casual</option>
                    <option value="empathetic">Empathetic</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Greeting</label>
                <input type="text" value={form.greeting} onChange={set('greeting')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                  placeholder="Hi, am I speaking with {{first_name}}?" />
                <p className="text-xs text-gray-400 mt-1">Use {'{{first_name}}'}, {'{{last_name}}'}, etc. for lead data</p>
              </div>
            </>
          )}

          {tab === 'script' && (
            <div className="space-y-6">
              {/* Transfer Script */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <PhoneForwarded className="w-4 h-4 text-blue-600" />
                  <label className="text-sm font-medium text-gray-700">Transfer Script</label>
                  {form.mode === 'live_transfer' && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Active</span>
                  )}
                </div>
                <textarea value={form.script} onChange={set('script')} rows={12}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-y"
                  placeholder="You are an AI sales agent. Your goal is to qualify leads and transfer them to a human advisor..." />
                <p className="text-xs text-gray-400 mt-1">Used when agent mode is "Live Transfer". AI will use transfer_call function.</p>
              </div>

              {/* Appointment Script */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <CalendarCheck className="w-4 h-4 text-emerald-600" />
                  <label className="text-sm font-medium text-gray-700">Appointment Script</label>
                  {form.mode === 'appointment' && (
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">Active</span>
                  )}
                </div>
                <textarea value={form.appointment_script || ''} onChange={set('appointment_script')} rows={12}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-y"
                  placeholder="You are an AI appointment setter. Your goal is to qualify leads and book a meeting date and time..." />
                <p className="text-xs text-gray-400 mt-1">Used when agent mode is "Appointment Setting". AI will use book_appointment function.</p>
              </div>

              <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
                <strong>Tip:</strong> You can switch between modes per-campaign. The agent will automatically use the appropriate script and functions based on the selected mode.
              </div>
            </div>
          )}

          {tab === 'models' && (
            <>
              {/* LLM (Think) */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-gray-700">LLM (Think)</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Provider</label>
                    <select value={form.llm_provider} onChange={setProvider('llm_provider', 'llm_model', LLM_PROVIDERS)} className={selectCls}>
                      {Object.entries(LLM_PROVIDERS).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
                    <select value={form.llm_model} onChange={set('llm_model')} className={selectCls}>
                      {llmModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {LLM_PROVIDERS[form.llm_provider]?.requiresEndpoint && (
                  <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
                    This provider requires a custom endpoint. Configure it in agent settings or .env
                  </p>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Temperature: {form.llm_temperature}
                    <span className="text-gray-400 ml-1">
                      (0-{form.llm_provider === 'anthropic' ? '1' : '2'})
                    </span>
                  </label>
                  <input type="range" min="0" max={form.llm_provider === 'anthropic' ? '1' : '2'} step="0.1"
                    value={form.llm_temperature}
                    onChange={e => setForm({ ...form, llm_temperature: parseFloat(e.target.value) })}
                    className="w-full accent-indigo-600" />
                </div>
              </div>

              {/* STT (Listen) */}
              <div className="space-y-3 pt-4 border-t border-gray-100">
                <h4 className="text-sm font-semibold text-gray-700">STT (Listen)</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Provider</label>
                    <select value={form.stt_provider} onChange={setProvider('stt_provider', 'stt_model', STT_PROVIDERS)} className={selectCls}>
                      {Object.entries(STT_PROVIDERS).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
                    <select value={form.stt_model} onChange={set('stt_model')} className={selectCls}>
                      {sttModels.map(m => (
                        <option key={m.id} value={m.id}>{m.recommended ? '⭐ ' : ''}{m.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {form.stt_model === 'flux-general-en' && (
                  <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-xs">
                    <p className="font-semibold text-indigo-700 mb-1">🚀 Flux - Optimized for Voice Agents</p>
                    <ul className="text-indigo-600 space-y-0.5">
                      <li>• Smart turn detection (~260ms latency)</li>
                      <li>• Built-in barge-in handling</li>
                      <li>• Nova-3 level accuracy</li>
                      <li>• <span className="text-amber-600 font-medium">English only</span> (use Nova-3 for other languages)</li>
                    </ul>
                  </div>
                )}
                {form.stt_model.startsWith('flux-') && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Turn-taking patience</label>
                      <select value={String(Number(form.eot_threshold))} onChange={e => setForm({ ...form, eot_threshold: Number(e.target.value) })} className={selectCls}>
                        <option value="0.6">Quick — answers as soon as the client pauses</option>
                        <option value="0.7">Deepgram default (0.7)</option>
                        <option value="0.8">Natural (0.8)</option>
                        <option value="0.85">⭐ Patient (0.85) — waits for a real end of sentence</option>
                        <option value="0.9">Very patient (0.9)</option>
                        <option value="0.95">Extra patient (0.95) — for slow / hesitant speakers</option>
                      </select>
                      <p className="text-[11px] text-gray-500 mt-1">Higher = fewer interruptions, a little more silence before Emma replies.</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Max pause before replying</label>
                      <select value={String(Number(form.eot_timeout_ms))} onChange={e => setForm({ ...form, eot_timeout_ms: Number(e.target.value) })} className={selectCls}>
                        <option value="2000">2 s</option>
                        <option value="3000">3 s</option>
                        <option value="4000">4 s</option>
                        <option value="5000">5 s (default)</option>
                        <option value="7000">7 s</option>
                      </select>
                      <p className="text-[11px] text-gray-500 mt-1">Safety cap: after this much silence the agent replies regardless.</p>
                    </div>
                  </div>
                )}
              </div>

              {/* TTS (Speak) */}
              <div className="space-y-3 pt-4 border-t border-gray-100">
                <h4 className="text-sm font-semibold text-gray-700">TTS (Speak)</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Provider</label>
                    <select value={form.tts_provider} onChange={setProvider('tts_provider', 'tts_model', TTS_PROVIDERS)} className={selectCls}>
                      {Object.entries(TTS_PROVIDERS).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Model / Voice</label>
                    <select value={form.tts_model} onChange={set('tts_model')} className={selectCls}>
                      {ttsModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {form.tts_provider === 'cartesia' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Voice</label>
                      <select value={form.tts_voice_id} onChange={set('tts_voice_id')} className={selectCls}>
                        <option value="">— Custom (paste ID below) —</option>
                        {TTS_PROVIDERS.cartesia.voices.map(v => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </select>
                    </div>
                    {!form.tts_voice_id && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Custom Voice ID</label>
                        <input type="text" placeholder="Paste Cartesia voice UUID here..."
                          value={form.tts_voice_id} onChange={set('tts_voice_id')}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                      </div>
                    )}
                    <p className="text-xs text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg">
                      Cartesia Sonic-2 is multilingual — any voice works with any language. Fully managed (no API key needed).
                    </p>
                  </>
                )}
                {form.tts_provider === 'eleven_labs' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Voice ID</label>
                      <input type="text" placeholder="ElevenLabs voice ID..."
                        value={form.tts_voice_id} onChange={set('tts_voice_id')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500 font-mono" />
                    </div>
                    <p className="text-xs text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg">
                      ElevenLabs is fully managed (no API key needed). Paste an ElevenLabs voice ID above. Multilingual v2 supports all languages.
                    </p>
                  </>
                )}
                {form.tts_provider === 'open_ai' && (
                  <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
                    OpenAI TTS is BYO — requires your own API key and endpoint. Set OPENAI_TTS_API_KEY in .env
                  </p>
                )}
                {(form.tts_provider === 'cartesia' || form.tts_provider === 'deepgram') && (
                  <div className="w-1/2 pr-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Speaking speed</label>
                    <select value={form.tts_speed} onChange={set('tts_speed')} className={selectCls}>
                      <option value="slowest">Slowest</option>
                      <option value="slow">Slow — calm, unhurried</option>
                      <option value="normal">Normal</option>
                      <option value="fast">Fast</option>
                      <option value="fastest">Fastest</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Test Configuration */}
              <div className="pt-4 border-t border-gray-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-700">Test Configuration</h4>
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition ${
                      testing
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : testResult === true
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : testResult === false
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : 'bg-gray-900 text-white hover:bg-gray-800'
                    }`}
                  >
                    {testing ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Testing...</>
                    ) : testResult === true ? (
                      <><CheckCircle2 className="w-4 h-4" /> All Checks Passed</>
                    ) : testResult === false ? (
                      <><XCircle className="w-4 h-4" /> Test Failed — Retry</>
                    ) : (
                      <><Play className="w-4 h-4" /> Test Configuration</>
                    )}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-3">
                  Verifies LLM, STT, TTS models, and greeting generation.
                </p>

                {testLogs.length > 0 && (
                  <div className="bg-gray-950 rounded-lg p-3 max-h-52 overflow-y-auto font-mono text-xs space-y-1">
                    {testLogs.map((log, i) => (
                      <div key={i} className="flex items-start gap-2">
                        {log.level === 'success' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                        ) : log.level === 'error' ? (
                          <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                        ) : (
                          <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
                        )}
                        <span className={
                          log.level === 'success' ? 'text-emerald-400'
                            : log.level === 'error' ? 'text-red-400'
                            : 'text-gray-400'
                        }>
                          {log.message}
                        </span>
                      </div>
                    ))}
                    {testing && (
                      <div className="flex items-center gap-2 text-gray-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Waiting for response...</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition">
            {saving ? 'Saving...' : agent ? 'Save Changes' : 'Create Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
