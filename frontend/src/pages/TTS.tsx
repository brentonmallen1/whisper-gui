import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Volume2, Download, RotateCcw, AlertTriangle, Loader } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { TTSVoiceMap } from '../types';
import './TTS.css';

type ViewState = 'idle' | 'loading' | 'done' | 'error';

export default function TTS() {
  const [text, setText]           = useState('');
  const [voice, setVoice]         = useState('af_bella');
  const [voices, setVoices]       = useState<TTSVoiceMap>({});
  const [view, setView]           = useState<ViewState>('idle');
  const [errorMsg, setErrorMsg]   = useState('');
  const [ttsReady, setTtsReady]   = useState(true);

  const audioRef    = useRef<HTMLAudioElement>(null);
  const blobUrlRef  = useRef<string | null>(null);

  useEffect(() => {
    // Load voices and check model status
    Promise.all([
      api.getTTSVoices(),
      api.getTTSStatus(),
      api.getSettings(),
    ]).then(([{ voices: v }, status, settings]) => {
      setVoices(v);
      setTtsReady(status.package && status.weights);
      if (settings.tts_voice) setVoice(settings.tts_voice);
    }).catch(() => {});

    // Cleanup blob URL on unmount
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const handleGenerate = async () => {
    if (!text.trim()) return;
    setView('loading');
    setErrorMsg('');

    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    try {
      const blob = await api.synthesizeSpeech(text.trim(), voice);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;

      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.load();
      }
      setView('done');
    } catch (err) {
      setErrorMsg((err as Error).message);
      setView('error');
    }
  };

  const handleDownload = () => {
    if (!blobUrlRef.current) return;
    const voiceLabel = voices[voice]?.name ?? voice;
    const a = document.createElement('a');
    a.href = blobUrlRef.current;
    a.download = `tts-${voiceLabel.toLowerCase()}.wav`;
    a.click();
  };

  const handleReset = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setView('idle');
    setErrorMsg('');
  };

  const voicesByGroup: Record<string, [string, TTSVoiceMap[string]][]> = {
    'American Female': [],
    'American Male': [],
    'British Female': [],
    'British Male': [],
  };
  for (const [k, v] of Object.entries(voices)) {
    if (k.startsWith('af_'))      voicesByGroup['American Female'].push([k, v]);
    else if (k.startsWith('am_')) voicesByGroup['American Male'].push([k, v]);
    else if (k.startsWith('bf_')) voicesByGroup['British Female'].push([k, v]);
    else if (k.startsWith('bm_')) voicesByGroup['British Male'].push([k, v]);
  }

  return (
    <div className="tts-page">
      <div className="tts-inner">

        {/* Back */}
        <Link to="/" className="tts-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        {/* Header */}
        <div className="tts-header">
          <div className="tts-header-icon">
            <Volume2 size={22} aria-hidden="true" />
          </div>
          <div>
            <h1 className="tts-title">Text-to-Speech</h1>
            <p className="tts-subtitle">Convert text to natural-sounding speech with Kokoro TTS.</p>
          </div>
        </div>

        {/* Model not ready warning */}
        {!ttsReady && (
          <div className="tts-warn">
            <AlertTriangle size={15} aria-hidden="true" />
            Kokoro TTS model is not ready.{' '}
            <Link to="/settings" className="tts-warn-link">Download it in Settings → Text-to-Speech.</Link>
          </div>
        )}

        {/* Input card */}
        <div className="tts-card">
          <div className="tts-controls">
            <div className="tts-field tts-field--grow">
              <label className="tts-label" htmlFor="tts-text">Text</label>
              <textarea
                id="tts-text"
                className="tts-textarea"
                placeholder="Enter text to convert to speech…"
                value={text}
                onChange={e => setText(e.target.value)}
                rows={6}
                disabled={view === 'loading'}
              />
              <p className="tts-char-count">{text.length} characters</p>
            </div>

            <div className="tts-field">
              <label className="tts-label" htmlFor="tts-voice">Voice</label>
              <select
                id="tts-voice"
                className="tts-select"
                value={voice}
                onChange={e => setVoice(e.target.value)}
                disabled={view === 'loading'}
              >
                {Object.entries(voicesByGroup).map(([group, opts]) =>
                  opts.length > 0 && (
                    <optgroup key={group} label={group}>
                      {opts.map(([k, v]) => (
                        <option key={k} value={k}>{v.name}</option>
                      ))}
                    </optgroup>
                  )
                )}
                {/* Fallback if voices haven't loaded yet */}
                {Object.keys(voices).length === 0 && (
                  <option value={voice}>{voice}</option>
                )}
              </select>
            </div>
          </div>

          <div className="tts-actions">
            <button
              className="tts-generate-btn"
              onClick={handleGenerate}
              disabled={!text.trim() || view === 'loading' || !ttsReady}
            >
              {view === 'loading' ? (
                <><Loader size={15} className="tts-spin" aria-hidden="true" /> Generating…</>
              ) : (
                <><Volume2 size={15} aria-hidden="true" /> Generate</>
              )}
            </button>
          </div>
        </div>

        {/* Error */}
        {view === 'error' && (
          <div className="tts-error-banner" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{errorMsg}</span>
            <button className="tts-reset-btn" onClick={handleReset}>Try again</button>
          </div>
        )}

        {/* Result */}
        {view === 'done' && (
          <div className="tts-result">
            <div className="tts-result-header">
              <span className="tts-result-label">
                {voices[voice]?.name ?? voice}
                {voices[voice]?.accent && (
                  <span className="tts-result-accent"> · {voices[voice].accent}</span>
                )}
              </span>
              <div className="tts-result-actions">
                <button className="tts-action-btn" onClick={handleDownload}>
                  <Download size={14} aria-hidden="true" />
                  Download .wav
                </button>
                <button className="tts-action-btn tts-action-btn--ghost" onClick={handleReset}>
                  <RotateCcw size={14} aria-hidden="true" />
                  New
                </button>
              </div>
            </div>
            <audio
              ref={audioRef}
              className="tts-audio-player"
              controls
              autoPlay
            />
          </div>
        )}

      </div>
    </div>
  );
}
