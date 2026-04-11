import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Download, Loader2, AlertTriangle, Clock, User, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { YouTubeVideoInfo } from '../types';
import './Download.css';

const POLL_INTERVAL_MS = 1200;

// ── Option definitions ─────────────────────────────────────────────────────

const VIDEO_QUALITIES = [
  { value: 'best', label: 'Best available' },
  { value: '2160', label: '4K (2160p)' },
  { value: '1080', label: '1080p' },
  { value: '720',  label: '720p' },
  { value: '480',  label: '480p' },
  { value: '360',  label: '360p' },
];

const VIDEO_FORMATS = [
  { value: 'mp4',  label: 'MP4 (H.264)' },
  { value: 'webm', label: 'WebM (VP9)' },
  { value: 'mkv',  label: 'MKV (original)' },
];

const AUDIO_FORMATS = [
  { value: 'mp3',  label: 'MP3' },
  { value: 'm4a',  label: 'M4A / AAC' },
  { value: 'flac', label: 'FLAC (lossless)' },
  { value: 'wav',  label: 'WAV (uncompressed)' },
  { value: 'ogg',  label: 'OGG Vorbis' },
  { value: 'opus', label: 'Opus' },
];

const AUDIO_QUALITIES = [
  { value: '320', label: '320 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '128', label: '128 kbps' },
];

const LOSSLESS_AUDIO = new Set(['flac', 'wav']);

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Component ──────────────────────────────────────────────────────────────

type Mode = 'video' | 'audio';
type Phase = 'idle' | 'fetching' | 'ready' | 'downloading' | 'done' | 'error';

export default function DownloadPage() {
  const [url, setUrl]                     = useState('');
  const [phase, setPhase]                 = useState<Phase>('idle');
  const [info, setInfo]                   = useState<YouTubeVideoInfo | null>(null);
  const [mode, setMode]                   = useState<Mode>('audio');
  const [videoQuality, setVideoQuality]   = useState('best');
  const [videoFormat, setVideoFormat]     = useState('mp4');
  const [audioFormat, setAudioFormat]     = useState('mp3');
  const [audioQuality, setAudioQuality]   = useState('192');
  const [statusDetail, setStatusDetail]   = useState('');
  const [errorMsg, setErrorMsg]           = useState('');
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen]     = useState(false);

  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Fetch info ─────────────────────────────────────────────────────────────

  const fetchInfo = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setPhase('fetching');
    setInfo(null);
    setErrorMsg('');
    try {
      const data = await api.getYouTubeInfo(trimmed);
      setInfo(data);
      setPhase('ready');
      setOptionsOpen(true);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setPhase('error');
    }
  };

  // ── Start download ─────────────────────────────────────────────────────────

  const startDownload = async () => {
    if (!url.trim()) return;
    setPhase('downloading');
    setStatusDetail('Starting…');
    setErrorMsg('');
    setDownloadedFile(null);

    try {
      const { job_id } = await api.startYouTubeDownload({
        url:           url.trim(),
        mode,
        video_quality: videoQuality,
        video_format:  videoFormat,
        audio_format:  audioFormat,
        audio_quality: LOSSLESS_AUDIO.has(audioFormat) ? 'best' : audioQuality,
      });
      jobIdRef.current = job_id;

      pollRef.current = setInterval(async () => {
        try {
          const job = await api.getYouTubeJobStatus(job_id);
          setStatusDetail(job.status_detail || 'Downloading…');
          if (job.status === 'done') {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setDownloadedFile(api.getYouTubeFileUrl(job_id));
            setPhase('done');
          } else if (job.status === 'error') {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setErrorMsg(job.error ?? 'Download failed.');
            setPhase('error');
          }
        } catch { /* keep polling */ }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setPhase('error');
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────

  const reset = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    jobIdRef.current = null;
    setPhase('idle');
    setInfo(null);
    setErrorMsg('');
    setDownloadedFile(null);
    setStatusDetail('');
    setOptionsOpen(false);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  const canFetch    = url.trim().length > 0 && phase !== 'fetching' && phase !== 'downloading';
  const canDownload = phase === 'ready' || phase === 'done';
  const isLossless  = LOSSLESS_AUDIO.has(audioFormat);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="dl-page">
      <div className="dl-inner">

        <Link to="/" className="dl-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        <div className="dl-header">
          <div className="dl-header-icon">
            <Download size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="dl-title">YouTube Download</h1>
            <p className="dl-subtitle">Download video or audio in your preferred format and quality</p>
          </div>
        </div>

        {/* URL input */}
        <div className="dl-url-row">
          <input
            className="dl-url-input"
            type="url"
            placeholder="Paste YouTube URL…"
            value={url}
            onChange={e => { setUrl(e.target.value); if (phase !== 'idle') reset(); }}
            onKeyDown={e => { if (e.key === 'Enter' && canFetch) fetchInfo(); }}
            aria-label="YouTube URL"
          />
          <button
            className="dl-btn dl-btn--secondary"
            onClick={fetchInfo}
            disabled={!canFetch}
          >
            {phase === 'fetching' ? <Loader2 size={15} className="dl-spinner" aria-hidden="true" /> : null}
            Fetch info
          </button>
        </div>

        {/* Video info card */}
        {info && (
          <div className="dl-info-card">
            {info.thumbnail && (
              <img src={info.thumbnail} alt="" className="dl-thumbnail" />
            )}
            <div className="dl-info-meta">
              <p className="dl-info-title">{info.title}</p>
              <div className="dl-info-details">
                {info.duration_seconds != null && (
                  <span className="dl-info-detail">
                    <Clock size={12} aria-hidden="true" />
                    {formatDuration(info.duration_seconds)}
                  </span>
                )}
                {info.uploader && (
                  <span className="dl-info-detail">
                    <User size={12} aria-hidden="true" />
                    {info.uploader}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Mode + Options */}
        {(phase === 'ready' || phase === 'done') && (
          <div className="dl-options-card">

            {/* Mode toggle */}
            <div className="dl-mode-row">
              <button
                className={`dl-mode-tab${mode === 'audio' ? ' active' : ''}`}
                onClick={() => setMode('audio')}
              >
                Audio only
              </button>
              <button
                className={`dl-mode-tab${mode === 'video' ? ' active' : ''}`}
                onClick={() => setMode('video')}
              >
                Video + Audio
              </button>
            </div>

            {/* Options toggle */}
            <button
              className="dl-options-toggle"
              onClick={() => setOptionsOpen(o => !o)}
              aria-expanded={optionsOpen}
            >
              {optionsOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              {optionsOpen ? 'Hide options' : 'Format & quality options'}
            </button>

            {optionsOpen && (
              <div className="dl-options-grid">
                {mode === 'video' ? (
                  <>
                    <div className="dl-option-group">
                      <label className="dl-option-label">Quality</label>
                      <select
                        className="dl-select"
                        value={videoQuality}
                        onChange={e => setVideoQuality(e.target.value)}
                      >
                        {VIDEO_QUALITIES.map(q => (
                          <option key={q.value} value={q.value}>{q.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="dl-option-group">
                      <label className="dl-option-label">Format</label>
                      <select
                        className="dl-select"
                        value={videoFormat}
                        onChange={e => setVideoFormat(e.target.value)}
                      >
                        {VIDEO_FORMATS.map(f => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="dl-option-group">
                      <label className="dl-option-label">Format</label>
                      <select
                        className="dl-select"
                        value={audioFormat}
                        onChange={e => setAudioFormat(e.target.value)}
                      >
                        {AUDIO_FORMATS.map(f => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                    {!isLossless && (
                      <div className="dl-option-group">
                        <label className="dl-option-label">Bitrate</label>
                        <select
                          className="dl-select"
                          value={audioQuality}
                          onChange={e => setAudioQuality(e.target.value)}
                        >
                          {AUDIO_QUALITIES.map(q => (
                            <option key={q.value} value={q.value}>{q.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Download button */}
            <button
              className="dl-btn dl-btn--primary dl-download-btn"
              onClick={startDownload}
              disabled={!canDownload}
            >
              <Download size={15} aria-hidden="true" />
              Download
            </button>
          </div>
        )}

        {/* Progress */}
        {phase === 'downloading' && (
          <div className="dl-progress" aria-live="polite">
            <div className="dl-progress-track" role="progressbar" aria-label="Download progress">
              <div className="dl-progress-bar" />
            </div>
            <p className="dl-progress-label">
              <Loader2 size={13} className="dl-spinner" aria-hidden="true" />
              {statusDetail || 'Downloading…'}
            </p>
          </div>
        )}

        {/* Done */}
        {phase === 'done' && downloadedFile && (
          <div className="dl-result">
            <a
              href={downloadedFile}
              className="dl-btn dl-btn--primary"
              download
            >
              <Download size={15} aria-hidden="true" />
              Save file
            </a>
            <button className="dl-btn dl-btn--ghost" onClick={reset}>
              Download another
            </button>
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="dl-error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{errorMsg}</span>
            <button className="dl-btn dl-btn--ghost dl-error-retry" onClick={() => setPhase(info ? 'ready' : 'idle')}>
              Try again
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
