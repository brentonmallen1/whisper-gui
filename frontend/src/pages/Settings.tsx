import { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, Save, RefreshCw, AlertTriangle, Check, Wifi, WifiOff, Loader, Download, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { AudioModelMap, Capabilities, OllamaModel, Settings as SettingsType, TTSStatus, TTSVoiceMap } from '../types';
import './Settings.css';

type Section = 'transcription' | 'application' | 'security' | 'ollama' | 'enhancement' | 'tts' | 'youtube';

const AUDIO_MODELS: { key: string; label: string; description: string }[] = [
  { key: 'deepfilternet', label: 'DeepFilterNet',  description: 'Noise reduction' },
  { key: 'demucs',        label: 'Demucs',         description: 'Vocal isolation (htdemucs)' },
  { key: 'lavasr',        label: 'LavaSR',         description: 'Audio super-resolution to 48kHz' },
];

const ENGINE_OPTIONS = [
  { value: 'faster-whisper', label: 'Faster Whisper (recommended)' },
  { value: 'whisper',        label: 'OpenAI Whisper' },
  { value: 'canary',         label: 'NVIDIA Canary (GPU only)' },
  { value: 'qwen-audio',     label: 'Qwen Audio (GPU only)' },
];

const MODEL_OPTIONS = [
  { value: 'tiny',           label: 'Tiny — fastest, lowest accuracy' },
  { value: 'base',           label: 'Base' },
  { value: 'small',          label: 'Small — good CPU option' },
  { value: 'medium',         label: 'Medium' },
  { value: 'large-v3',       label: 'Large v3 — best accuracy' },
  { value: 'large-v3-turbo', label: 'Large v3 Turbo — recommended for GPU' },
];

const COMPUTE_OPTIONS = [
  { value: 'int8',         label: 'int8 — fastest, good for CPU' },
  { value: 'int8_float16', label: 'int8_float16 — balanced (GPU)' },
  { value: 'float16',      label: 'float16 — best accuracy (GPU)' },
  { value: 'float32',      label: 'float32 — full precision' },
];

export default function Settings() {
  const [section, setSection]             = useState<Section>('transcription');
  const [settings, setSettings]           = useState<SettingsType | null>(null);
  const [draft, setDraft]                 = useState<Partial<SettingsType>>({});
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [saved, setSaved]                 = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [restarting, setRestarting]       = useState(false);
  const [error, setError]                 = useState('');

  // Capabilities
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  // Ollama
  const [ollamaModels, setOllamaModels]       = useState<OllamaModel[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [testingConn, setTestingConn]         = useState(false);
  const [connStatus, setConnStatus]           = useState<{ ok: boolean; message: string } | null>(null);

  // Audio enhancement models
  const [audioModels, setAudioModels]         = useState<AudioModelMap | null>(null);
  const [audioModelsLoading, setAudioModelsLoading] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg]         = useState<Record<string, string>>({});

  // TTS
  const [ttsStatus, setTtsStatus]             = useState<TTSStatus | null>(null);
  const [ttsVoices, setTtsVoices]             = useState<TTSVoiceMap>({});
  const [ttsStatusLoading, setTtsStatusLoading] = useState(false);
  const [downloadingTts, setDownloadingTts]   = useState(false);
  const [ttsDownloadMsg, setTtsDownloadMsg]   = useState('');
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const previewAudioRef                       = useRef<HTMLAudioElement | null>(null);
  const previewBlobUrlRef                     = useRef<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [data, caps] = await Promise.all([api.getSettings(), api.getCapabilities()]);
      setSettings(data);
      setDraft(data);
      setCapabilities(caps);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const loadOllamaModels = useCallback(async () => {
    setOllamaModelsLoading(true);
    try {
      const { models } = await api.getOllamaModels();
      setOllamaModels(models);
    } catch {
      setOllamaModels([]);
    } finally {
      setOllamaModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section === 'ollama') loadOllamaModels();
  }, [section, loadOllamaModels]);

  const loadAudioModels = useCallback(async () => {
    setAudioModelsLoading(true);
    try {
      setAudioModels(await api.getAudioModels());
    } catch {
      setAudioModels(null);
    } finally {
      setAudioModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section === 'enhancement') loadAudioModels();
  }, [section, loadAudioModels]);

  const loadTtsStatus = useCallback(async () => {
    setTtsStatusLoading(true);
    try {
      const [status, { voices }] = await Promise.all([
        api.getTTSStatus(),
        api.getTTSVoices(),
      ]);
      setTtsStatus(status);
      setTtsVoices(voices);
    } catch {
      setTtsStatus(null);
    } finally {
      setTtsStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section === 'tts') loadTtsStatus();
  }, [section, loadTtsStatus]);

  const handleDownloadTts = async () => {
    setDownloadingTts(true);
    setTtsDownloadMsg('Starting download…');
    await api.downloadTTSModel(
      (status, message) => {
        setTtsDownloadMsg(status === 'downloading' ? (message || 'Downloading…') : message);
      },
      async () => {
        setDownloadingTts(false);
        setTtsDownloadMsg('');
        await loadTtsStatus();
      },
      (err) => {
        setTtsDownloadMsg(`Error: ${err}`);
        setDownloadingTts(false);
      },
    );
  };

  const handleDownloadModel = async (modelKey: string) => {
    setDownloadingModel(modelKey);
    setDownloadMsg(prev => ({ ...prev, [modelKey]: 'Starting download…' }));
    await api.downloadAudioModels(
      [modelKey],
      (_model, _status, message) => {
        setDownloadMsg(prev => ({ ...prev, [modelKey]: message }));
      },
      async () => {
        setDownloadingModel(null);
        await loadAudioModels();
      },
      (err) => {
        setDownloadMsg(prev => ({ ...prev, [modelKey]: `Error: ${err}` }));
        setDownloadingModel(null);
      },
    );
  };

  const handlePreviewVoice = async (voice: string) => {
    // Stop any currently playing preview
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    if (previewBlobUrlRef.current) {
      URL.revokeObjectURL(previewBlobUrlRef.current);
      previewBlobUrlRef.current = null;
    }

    setPreviewingVoice(true);
    try {
      const blob = await api.synthesizeSpeech(
        "The quick brown fox jumps over the lazy dog. How vexingly quick daft zebras jump.",
        voice,
      );
      const url = URL.createObjectURL(blob);
      previewBlobUrlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => setPreviewingVoice(false);
      audio.onerror = () => setPreviewingVoice(false);
      previewAudioRef.current = audio;
      await audio.play();
    } catch {
      setPreviewingVoice(false);
    }
  };

  const set = (key: keyof SettingsType, value: string) => {
    setDraft(d => ({ ...d, [key]: value }));
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setConnStatus(null);
    try {
      const result = await api.testOllamaConnection();
      setConnStatus(result);
    } catch {
      setConnStatus({ ok: false, message: 'Request failed' });
    } finally {
      setTestingConn(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.updateSettings(draft as Partial<SettingsType>);
      setSettings(res.settings);
      setDraft(res.settings);
      setRestartRequired(res.restart_required);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.reloadEngine();
      setRestartRequired(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-inner">
          <p className="settings-loading">Loading settings…</p>
        </div>
      </div>
    );
  }

  const d = draft as SettingsType;

  return (
    <div className="settings-page">
      <div className="settings-inner">

        {/* Back link */}
        <Link to="/" className="settings-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        <h1 className="settings-title">Settings</h1>

        {error && (
          <div className="settings-banner settings-banner--error">
            <AlertTriangle size={16} aria-hidden="true" />
            {error}
          </div>
        )}

        {restartRequired && (
          <div className="settings-banner settings-banner--warn">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>Engine settings changed — restart required for changes to take effect.</span>
            <button
              className="settings-restart-btn"
              onClick={handleRestart}
              disabled={restarting}
            >
              <RefreshCw size={14} className={restarting ? 'spinning' : ''} aria-hidden="true" />
              {restarting ? 'Restarting…' : 'Restart Engine'}
            </button>
          </div>
        )}

        <div className="settings-layout">
          {/* Sidebar */}
          <nav className="settings-sidebar" aria-label="Settings sections">
            {(
              [
                ['transcription', 'Transcription'],
                ['ollama',        'Ollama (AI)'],
                ['enhancement',  'Enhancement'],
                ['tts',           'Text-to-Speech'],
                ['youtube',       'YouTube'],
                ['application',  'Application'],
                ['security',     'Security'],
              ] as [Section, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={`settings-nav-item ${section === key ? 'active' : ''}`}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
            <Link to="/prompts" className="settings-nav-item settings-nav-link">
              Prompts ↗
            </Link>
          </nav>

          {/* Content */}
          <div className="settings-content">

            {/* ── Transcription ──────────────────────────────────────── */}
            {section === 'transcription' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Transcription Engine</h2>
                  <p className="settings-section-desc">
                    Changes to engine settings require a restart to take effect.
                  </p>
                </div>

                <div className="settings-fields">
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="engine">Engine</label>
                    <select
                      id="engine"
                      className="settings-select"
                      value={d.transcription_engine ?? ''}
                      onChange={e => set('transcription_engine', e.target.value)}
                    >
                      {ENGINE_OPTIONS.map(o => {
                        const cap = capabilities?.engines[o.value];
                        const unavailable = cap && !cap.available;
                        return (
                          <option key={o.value} value={o.value} disabled={!!unavailable}>
                            {o.label}{unavailable && cap?.reason ? ` — ${cap.reason}` : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {['faster-whisper', 'whisper'].includes(d.transcription_engine) && (
                    <div className="settings-field">
                      <label className="settings-label" htmlFor="model">Model Size</label>
                      <select
                        id="model"
                        className="settings-select"
                        value={d.whisper_model_size ?? ''}
                        onChange={e => set('whisper_model_size', e.target.value)}
                      >
                        {MODEL_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {d.transcription_engine === 'faster-whisper' && (
                    <div className="settings-field">
                      <label className="settings-label" htmlFor="compute">Compute Type</label>
                      <select
                        id="compute"
                        className="settings-select"
                        value={d.compute_type ?? ''}
                        onChange={e => set('compute_type', e.target.value)}
                      >
                        {COMPUTE_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="settings-field">
                    <label className="settings-label" htmlFor="language">
                      Language
                      <span className="settings-label-hint">ISO 639-1 code — leave blank for auto-detect</span>
                    </label>
                    <input
                      id="language"
                      type="text"
                      className="settings-input"
                      value={d.language ?? ''}
                      onChange={e => set('language', e.target.value)}
                      placeholder="e.g. en, es, fr — blank = auto"
                      maxLength={10}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ── Ollama ─────────────────────────────────────────────── */}
            {section === 'ollama' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Ollama</h2>
                  <p className="settings-section-desc">
                    AI summarization via a local Ollama instance. Optimized for gemma4.
                  </p>
                </div>
                <div className="settings-fields">

                  {/* URL + Test Connection */}
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="ollama-url">Server URL</label>
                    <div className="settings-test-row">
                      <input
                        id="ollama-url"
                        type="url"
                        className="settings-input"
                        value={d.ollama_url ?? ''}
                        onChange={e => { set('ollama_url', e.target.value); setConnStatus(null); }}
                        placeholder="http://localhost:11434"
                      />
                      <button
                        className="settings-test-btn"
                        onClick={handleTestConnection}
                        disabled={testingConn}
                        type="button"
                      >
                        {testingConn
                          ? <Loader size={14} className="spinning" aria-hidden="true" />
                          : <Wifi size={14} aria-hidden="true" />}
                        {testingConn ? 'Testing…' : 'Test'}
                      </button>
                    </div>
                    {connStatus && (
                      <div className={`settings-connection-status ${connStatus.ok ? 'ok' : 'err'}`}>
                        {connStatus.ok
                          ? <Check size={13} aria-hidden="true" />
                          : <WifiOff size={13} aria-hidden="true" />}
                        {connStatus.message}
                      </div>
                    )}
                  </div>

                  {/* Model dropdown */}
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="ollama-model">
                      Model
                      <span className="settings-label-hint">
                        {ollamaModelsLoading
                          ? 'Loading models…'
                          : ollamaModels.length === 0
                            ? 'No models found — run `ollama pull gemma4:27b` to install'
                            : `${ollamaModels.length} model${ollamaModels.length !== 1 ? 's' : ''} available`}
                      </span>
                    </label>
                    {ollamaModels.length > 0 ? (
                      <select
                        id="ollama-model"
                        className="settings-select"
                        value={d.ollama_model ?? ''}
                        onChange={e => set('ollama_model', e.target.value)}
                      >
                        <option value="">— select a model —</option>
                        {ollamaModels.map(m => (
                          <option key={m.name} value={m.name}>
                            {m.name}{m.parameter_size ? ` (${m.parameter_size})` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="ollama-model"
                        type="text"
                        className="settings-input"
                        value={d.ollama_model ?? ''}
                        onChange={e => set('ollama_model', e.target.value)}
                        placeholder="e.g. gemma4:27b"
                      />
                    )}
                  </div>

                  {/* Thinking Mode */}
                  <div className="settings-field">
                    <div className="settings-toggle-row">
                      <div>
                        <p className="settings-label" style={{ marginBottom: 2 }}>Enable Thinking Mode</p>
                        <p className="settings-label-hint" style={{ margin: 0 }}>
                          Model reasons step-by-step before answering (gemma4 <code>&lt;|think|&gt;</code> token)
                        </p>
                      </div>
                      <button
                        className={`settings-toggle ${d.ollama_thinking_enabled === 'true' ? 'on' : ''}`}
                        role="switch"
                        aria-checked={d.ollama_thinking_enabled === 'true'}
                        onClick={() => set('ollama_thinking_enabled', d.ollama_thinking_enabled === 'true' ? 'false' : 'true')}
                      >
                        <span className="settings-toggle-thumb" />
                      </button>
                    </div>
                  </div>

                  {/* Token Budget */}
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="ollama-budget">
                      Visual Token Budget
                      <span className="settings-label-hint">
                        Controls image/document processing detail. Higher = more accurate, slower.
                      </span>
                    </label>
                    <select
                      id="ollama-budget"
                      className="settings-select settings-input--narrow"
                      value={d.ollama_token_budget ?? '280'}
                      onChange={e => set('ollama_token_budget', e.target.value)}
                    >
                      <option value="70">70 — Fastest, basic classification</option>
                      <option value="140">140 — Quick captioning, video</option>
                      <option value="280">280 — Balanced (default)</option>
                      <option value="560">560 — Detailed OCR, documents</option>
                      <option value="1120">1120 — Maximum detail, small text</option>
                    </select>
                  </div>

                  {/* Timeout */}
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="ollama-timeout">Timeout (seconds)</label>
                    <input
                      id="ollama-timeout"
                      type="number"
                      className="settings-input settings-input--narrow"
                      value={d.ollama_timeout ?? '120'}
                      onChange={e => set('ollama_timeout', e.target.value)}
                      min="10"
                      max="600"
                    />
                  </div>

                </div>
              </div>
            )}

            {/* ── Enhancement ────────────────────────────────────────── */}
            {section === 'enhancement' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Audio Enhancement</h2>
                  <p className="settings-section-desc">
                    Default enhancement stages applied before transcription. Can be overridden per-job.
                  </p>
                </div>

                <div className="settings-fields">
                  {/* Default toggles */}
                  {[
                    { key: 'enhance_normalize' as keyof SettingsType, label: 'Normalize by default', hint: 'EBU R128 loudness normalization via ffmpeg' },
                    { key: 'enhance_denoise'   as keyof SettingsType, label: 'Denoise by default',   hint: 'DeepFilterNet noise reduction' },
                    { key: 'enhance_isolate'   as keyof SettingsType, label: 'Isolate vocals by default', hint: 'Demucs vocal isolation' },
                    { key: 'enhance_upsample'  as keyof SettingsType, label: 'Upsample by default',  hint: 'LavaSR audio super-resolution to 48kHz' },
                  ].map(({ key, label, hint }) => (
                    <div key={key} className="settings-field">
                      <div className="settings-toggle-row">
                        <div>
                          <p className="settings-label" style={{ marginBottom: 2 }}>{label}</p>
                          <p className="settings-label-hint" style={{ margin: 0 }}>{hint}</p>
                        </div>
                        <button
                          className={`settings-toggle ${d[key] === 'true' ? 'on' : ''}`}
                          role="switch"
                          aria-checked={d[key] === 'true'}
                          onClick={() => set(key, d[key] === 'true' ? 'false' : 'true')}
                        >
                          <span className="settings-toggle-thumb" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Model status cards */}
                  <div className="settings-field">
                    <p className="settings-label">Enhancement Models</p>
                    <p className="settings-label-hint" style={{ marginBottom: 8 }}>
                      Models are downloaded to the configured models directory on first use, or pre-download below.
                    </p>
                    {audioModelsLoading && <p className="settings-label-hint">Loading model status…</p>}
                    {!audioModelsLoading && audioModels && (
                      <div className="settings-model-cards">
                        {AUDIO_MODELS.map(m => {
                          const status = audioModels[m.key];
                          const isDownloading = downloadingModel === m.key;
                          const msg = downloadMsg[m.key];
                          return (
                            <div key={m.key} className="settings-model-card">
                              <div className="settings-model-info">
                                <span className="settings-model-name">{m.label}</span>
                                <span className="settings-model-desc">{m.description}</span>
                              </div>
                              <div className="settings-model-status">
                                {!status?.package ? (
                                  <span className="settings-model-badge settings-model-badge--missing">not installed</span>
                                ) : status.weights ? (
                                  <span className="settings-model-badge settings-model-badge--ok">
                                    <Check size={11} aria-hidden="true" /> ready
                                  </span>
                                ) : (
                                  <span className="settings-model-badge settings-model-badge--warn">weights missing</span>
                                )}
                              </div>
                              {status?.package && !status.weights && (
                                <button
                                  className="settings-download-btn"
                                  onClick={() => handleDownloadModel(m.key)}
                                  disabled={downloadingModel !== null}
                                  type="button"
                                >
                                  {isDownloading
                                    ? <Loader size={13} className="spinning" aria-hidden="true" />
                                    : <Download size={13} aria-hidden="true" />}
                                  {isDownloading ? (msg || 'Downloading…') : 'Download'}
                                </button>
                              )}
                              {isDownloading && msg && (
                                <p className="settings-model-msg">{msg}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Text-to-Speech ─────────────────────────────────────── */}
            {section === 'tts' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Text-to-Speech</h2>
                  <p className="settings-section-desc">
                    Read summarization results aloud using Kokoro TTS (82M parameters, English voices).
                  </p>
                </div>

                <div className="settings-fields">
                  {/* Enable toggle */}
                  <div className="settings-field">
                    <div className="settings-toggle-row">
                      <div>
                        <p className="settings-label" style={{ marginBottom: 2 }}>Enable Read Aloud</p>
                        <p className="settings-label-hint" style={{ margin: 0 }}>Show Read Aloud button on summarization results</p>
                      </div>
                      <button
                        className={`settings-toggle ${d.tts_enabled !== 'false' ? 'on' : ''}`}
                        role="switch"
                        aria-checked={d.tts_enabled !== 'false'}
                        onClick={() => set('tts_enabled', d.tts_enabled === 'false' ? 'true' : 'false')}
                      >
                        <span className="settings-toggle-thumb" />
                      </button>
                    </div>
                  </div>

                  {/* Voice selection */}
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="tts-voice">
                      Default Voice
                      <span className="settings-label-hint">Voice used when reading results aloud</span>
                    </label>
                    <div className="settings-voice-row">
                      <select
                        id="tts-voice"
                        className="settings-select"
                        value={d.tts_voice ?? 'af_bella'}
                        onChange={e => set('tts_voice', e.target.value)}
                      >
                        {Object.keys(ttsVoices).length > 0 ? (
                          <>
                            <optgroup label="American Female">
                              {Object.entries(ttsVoices).filter(([k]) => k.startsWith('af_')).map(([k, v]) => (
                                <option key={k} value={k}>{v.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="American Male">
                              {Object.entries(ttsVoices).filter(([k]) => k.startsWith('am_')).map(([k, v]) => (
                                <option key={k} value={k}>{v.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="British Female">
                              {Object.entries(ttsVoices).filter(([k]) => k.startsWith('bf_')).map(([k, v]) => (
                                <option key={k} value={k}>{v.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="British Male">
                              {Object.entries(ttsVoices).filter(([k]) => k.startsWith('bm_')).map(([k, v]) => (
                                <option key={k} value={k}>{v.name}</option>
                              ))}
                            </optgroup>
                          </>
                        ) : (
                          <option value={d.tts_voice ?? 'af_bella'}>{d.tts_voice ?? 'af_bella'}</option>
                        )}
                      </select>
                      <button
                        className="settings-voice-preview-btn"
                        title="Preview voice"
                        disabled={previewingVoice || !ttsStatus?.weights}
                        onClick={() => handlePreviewVoice(d.tts_voice ?? 'af_bella')}
                        type="button"
                      >
                        {previewingVoice
                          ? <Loader size={14} className="spinning" aria-hidden="true" />
                          : <Play size={14} aria-hidden="true" />}
                      </button>
                    </div>
                  </div>

                  {/* Model status */}
                  <div className="settings-field">
                    <p className="settings-label">TTS Model</p>
                    <p className="settings-label-hint" style={{ marginBottom: 8 }}>
                      Kokoro-82M is downloaded on first use, or pre-download below.
                    </p>
                    {ttsStatusLoading && <p className="settings-label-hint">Loading model status…</p>}
                    {!ttsStatusLoading && (
                      <div className="settings-model-cards">
                        <div className="settings-model-card">
                          <div className="settings-model-info">
                            <span className="settings-model-name">Kokoro-82M</span>
                            <span className="settings-model-desc">Neural TTS, 28 English voices</span>
                          </div>
                          <div className="settings-model-status">
                            {!ttsStatus?.package ? (
                              <span className="settings-model-badge settings-model-badge--missing">not installed</span>
                            ) : ttsStatus.weights ? (
                              <span className="settings-model-badge settings-model-badge--ok">
                                <Check size={11} aria-hidden="true" /> ready
                              </span>
                            ) : (
                              <span className="settings-model-badge settings-model-badge--warn">weights missing</span>
                            )}
                          </div>
                          {ttsStatus?.package && !ttsStatus.weights && (
                            <button
                              className="settings-download-btn"
                              onClick={handleDownloadTts}
                              disabled={downloadingTts}
                              type="button"
                            >
                              {downloadingTts
                                ? <Loader size={13} className="spinning" aria-hidden="true" />
                                : <Download size={13} aria-hidden="true" />}
                              {downloadingTts ? (ttsDownloadMsg || 'Downloading…') : 'Download'}
                            </button>
                          )}
                          {downloadingTts && ttsDownloadMsg && (
                            <p className="settings-model-msg">{ttsDownloadMsg}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── YouTube ────────────────────────────────────────────── */}
            {section === 'youtube' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">YouTube</h2>
                  <p className="settings-section-desc">
                    Provide your browser cookies to bypass rate limits, access age-restricted videos,
                    and avoid bot detection. Export using a browser extension such as
                    {' '}<a href="https://github.com/nicktantienern/cookies-txt" target="_blank" rel="noreferrer" className="settings-link">cookies.txt</a>{' '}
                    (Chrome/Firefox) and paste the file contents below.
                  </p>
                </div>

                <div className="settings-fields">
                  <div className="settings-field">
                    <div className="settings-cookies-header">
                      <label className="settings-label" htmlFor="yt-cookies">
                        Cookies (Netscape format)
                      </label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <label className="settings-upload-btn" title="Upload cookies.txt file">
                          <input
                            type="file"
                            accept=".txt"
                            style={{ display: 'none' }}
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const reader = new FileReader();
                              reader.onload = ev => set('youtube_cookies', ev.target?.result as string ?? '');
                              reader.readAsText(file);
                              e.target.value = '';
                            }}
                          />
                          <Download size={13} aria-hidden="true" />
                          Upload file
                        </label>
                        {d.youtube_cookies && (
                          <button
                            className="settings-clear-btn"
                            onClick={() => set('youtube_cookies', '')}
                            type="button"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                    <textarea
                      id="yt-cookies"
                      className="settings-cookies-textarea"
                      placeholder={"# Netscape HTTP Cookie File\n# Export from your browser using a cookies.txt extension\n.youtube.com\tTRUE\t/\tTRUE\t…"}
                      value={d.youtube_cookies ?? ''}
                      onChange={e => set('youtube_cookies', e.target.value)}
                      rows={8}
                      spellCheck={false}
                    />
                    {d.youtube_cookies && (
                      <p className="settings-label-hint">
                        {d.youtube_cookies.trim().split('\n').filter(l => l && !l.startsWith('#')).length} cookie entries saved.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Application ────────────────────────────────────────── */}
            {section === 'application' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Application</h2>
                  <p className="settings-section-desc">
                    Upload limits and cache behaviour. Changes take effect immediately.
                  </p>
                </div>

                <div className="settings-fields">
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="max-upload">
                      Max Upload Size (MB)
                      <span className="settings-label-hint">Set to 0 for unlimited</span>
                    </label>
                    <input
                      id="max-upload"
                      type="number"
                      className="settings-input settings-input--narrow"
                      value={d.max_upload_size_mb ?? '500'}
                      onChange={e => set('max_upload_size_mb', e.target.value)}
                      min="0"
                    />
                  </div>

                  <div className="settings-field">
                    <label className="settings-label" htmlFor="cache-ttl">
                      Audio Cache TTL (hours)
                      <span className="settings-label-hint">How long to keep uploaded files. 0 = never purge</span>
                    </label>
                    <input
                      id="cache-ttl"
                      type="number"
                      className="settings-input settings-input--narrow"
                      value={d.audio_cache_ttl_hours ?? '72'}
                      onChange={e => set('audio_cache_ttl_hours', e.target.value)}
                      min="0"
                    />
                  </div>

                  <div className="settings-field">
                    <label className="settings-label" htmlFor="app-name">App Name</label>
                    <input
                      id="app-name"
                      type="text"
                      className="settings-input"
                      value={d.app_name ?? ''}
                      onChange={e => set('app_name', e.target.value)}
                      placeholder="Lumina"
                      maxLength={40}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ── Security ───────────────────────────────────────────── */}
            {section === 'security' && (
              <div className="settings-section">
                <div className="settings-section-header">
                  <h2 className="settings-section-title">Security</h2>
                  <p className="settings-section-desc">
                    API key for programmatic access, and optional Basic Auth for the UI.
                  </p>
                </div>

                <div className="settings-fields">
                  <div className="settings-field">
                    <div className="settings-toggle-row">
                      <div>
                        <p className="settings-label" style={{ marginBottom: 2 }}>Enable Authentication</p>
                        <p className="settings-label-hint" style={{ margin: 0 }}>
                          Protects all API and UI endpoints with Basic Auth
                        </p>
                      </div>
                      <button
                        className={`settings-toggle ${d.auth_enabled === 'true' ? 'on' : ''}`}
                        role="switch"
                        aria-checked={d.auth_enabled === 'true'}
                        onClick={() => set('auth_enabled', d.auth_enabled === 'true' ? 'false' : 'true')}
                      >
                        <span className="settings-toggle-thumb" />
                      </button>
                    </div>
                  </div>

                  {d.auth_enabled === 'true' && (
                    <>
                      <div className="settings-field">
                        <label className="settings-label" htmlFor="auth-user">Username</label>
                        <input
                          id="auth-user"
                          type="text"
                          className="settings-input"
                          value={d.auth_username ?? ''}
                          onChange={e => set('auth_username', e.target.value)}
                          autoComplete="username"
                        />
                      </div>
                      <div className="settings-field">
                        <label className="settings-label" htmlFor="auth-pass">Password</label>
                        <input
                          id="auth-pass"
                          type="password"
                          className="settings-input"
                          value={d.auth_password ?? ''}
                          onChange={e => set('auth_password', e.target.value)}
                          autoComplete="new-password"
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* API Key */}
                <div className="settings-card">
                  <h3 className="settings-card-title">API Key</h3>
                  <p className="settings-card-desc">
                    Bearer token for programmatic access to all API endpoints. When set, requests
                    with <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-API-Key: &lt;key&gt;</code> bypass Basic Auth.
                    Generate with: <code>openssl rand -hex 32</code>
                  </p>
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="api-key">API Key</label>
                    <input
                      id="api-key"
                      type="password"
                      className="settings-input"
                      placeholder="Leave blank to disable API key auth"
                      value={d.api_key ?? ''}
                      onChange={e => set('api_key', e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </div>

                {/* HuggingFace token (for speaker diarization) */}
                <div className="settings-card">
                  <h3 className="settings-card-title">HuggingFace Token</h3>
                  <p className="settings-card-desc">Required for speaker diarization (pyannote.audio). <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="settings-link">Get a token →</a></p>
                  <div className="settings-field">
                    <label className="settings-label" htmlFor="hf-token">Access Token</label>
                    <input
                      id="hf-token"
                      type="password"
                      className="settings-input"
                      placeholder="hf_…"
                      value={d.hf_token ?? ''}
                      onChange={e => set('hf_token', e.target.value)}
                      autoComplete="off"
                    />
                    <p className="settings-label-hint">Used only for downloading pyannote diarization models.</p>
                  </div>
                </div>

              </div>
            )}

            {/* Save bar */}
            <div className="settings-save-bar">
              <button
                className="settings-save-btn"
                onClick={handleSave}
                disabled={saving || JSON.stringify(draft) === JSON.stringify(settings)}
              >
                {saving ? (
                  <><RefreshCw size={15} className="spinning" aria-hidden="true" /> Saving…</>
                ) : saved ? (
                  <><Check size={15} aria-hidden="true" /> Saved</>
                ) : (
                  <><Save size={15} aria-hidden="true" /> Save Changes</>
                )}
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
