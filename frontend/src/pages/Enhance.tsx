import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, Upload, Download, RotateCcw, AudioWaveform, AlertTriangle, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { AudioModelMap, EnhancementOptions } from '../types';
import EnhancementPanel, { DEFAULT_ENHANCEMENT } from '../components/EnhancementPanel';
import './Enhance.css';

const ACCEPTED_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm', '.opus', '.aac', '.wma',
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v',
];
const ACCEPTED_MIME = ACCEPTED_EXTENSIONS.join(',');
const POLL_INTERVAL_MS = 1200;

type View = 'upload' | 'configure' | 'progress' | 'result' | 'error';

export default function Enhance() {
  const [view, setView]                     = useState<View>('upload');
  const [filename, setFilename]             = useState('');
  const [progressLabel, setProgressLabel]   = useState('');
  const [errorMsg, setErrorMsg]             = useState('');
  const [isDragging, setIsDragging]         = useState(false);
  const [enhancement, setEnhancement]       = useState<EnhancementOptions>(DEFAULT_ENHANCEMENT);
  const [audioModels, setAudioModels]       = useState<AudioModelMap | undefined>(undefined);
  const [activePlayer, setActivePlayer]     = useState<'original' | 'enhanced'>('enhanced');
  const [pendingFile, setPendingFile]       = useState<File | null>(null);

  const jobIdRef         = useRef<string | null>(null);
  const pollRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const originalAudioRef = useRef<HTMLAudioElement>(null);
  const enhancedAudioRef = useRef<HTMLAudioElement>(null);

  // Load audio model status and settings defaults on mount
  useEffect(() => {
    api.getAudioModels().then(setAudioModels).catch(() => {});
    api.getSettings().then(s => {
      setEnhancement({
        normalize: s.enhance_normalize === 'true',
        denoise:   s.enhance_denoise   === 'true',
        isolate:   s.enhance_isolate   === 'true',
        upsample:  s.enhance_upsample  === 'true',
      });
    }).catch(() => {});
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Set audio sources after result view renders
  useEffect(() => {
    if (view === 'result' && jobIdRef.current) {
      if (originalAudioRef.current) {
        originalAudioRef.current.src = api.getOriginalAudioUrl(jobIdRef.current);
      }
      if (enhancedAudioRef.current) {
        enhancedAudioRef.current.src = api.getEnhancedAudioUrl(jobIdRef.current);
      }
    }
  }, [view]);

  // ── File handling ────────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    const ext = '.' + file.name.split('.').pop()!.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setErrorMsg(`Unsupported file type: ${ext}. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`);
      setView('error');
      return;
    }
    setPendingFile(file);
    setFilename(file.name);
    setView('configure');
  }, []);

  const startEnhancement = () => {
    if (!pendingFile || !Object.values(enhancement).some(Boolean)) return;
    uploadFile(pendingFile);
  };

  const uploadFile = async (file: File) => {
    setFilename(file.name);
    setProgressLabel('Uploading…');
    setView('progress');

    try {
      const { job_id } = await api.enhanceFile(file, enhancement);
      jobIdRef.current = job_id;
      setProgressLabel('Enhancing…');
      startPolling(job_id);
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const startPolling = (jobId: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const job = await api.getStatus(jobId);
        if (job.status === 'done') {
          stopPolling();
          setView('result');
          setActivePlayer('enhanced');
        } else if (job.status === 'error') {
          stopPolling();
          showError(job.error ?? 'Enhancement failed.');
        } else if (job.status === 'enhancing') {
          setProgressLabel(job.status_detail || 'Enhancing…');
        }
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_INTERVAL_MS);
  };

  const showError = (msg: string) => {
    stopPolling();
    setErrorMsg(msg);
    setView('error');
  };

  const reset = () => {
    stopPolling();
    jobIdRef.current = null;
    setPendingFile(null);
    setView('upload');
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (originalAudioRef.current) { originalAudioRef.current.pause(); originalAudioRef.current.src = ''; }
    if (enhancedAudioRef.current) { enhancedAudioRef.current.pause(); enhancedAudioRef.current.src = ''; }
  };

  // ── Re-enhance ───────────────────────────────────────────────────────────

  const handleReenhance = async () => {
    if (!jobIdRef.current) return;
    const prevJobId = jobIdRef.current;
    setFilename(filename);
    setProgressLabel('Enhancing…');
    setView('progress');
    if (originalAudioRef.current) { originalAudioRef.current.pause(); originalAudioRef.current.src = ''; }
    if (enhancedAudioRef.current) { enhancedAudioRef.current.pause(); enhancedAudioRef.current.src = ''; }
    try {
      const { job_id } = await api.reenhance(prevJobId, enhancement);
      jobIdRef.current = job_id;
      startPolling(job_id);
    } catch (err) {
      showError((err as Error).message);
    }
  };

  // ── Download ─────────────────────────────────────────────────────────────

  const downloadEnhanced = () => {
    if (jobIdRef.current) {
      window.location.href = api.getEnhancedAudioUrl(jobIdRef.current);
    }
  };

  // ── Drag & drop ──────────────────────────────────────────────────────────

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // ── Player tab switch ────────────────────────────────────────────────────

  const switchPlayer = (which: 'original' | 'enhanced') => {
    // Pause the currently playing one before switching
    if (which === 'original' && enhancedAudioRef.current) enhancedAudioRef.current.pause();
    if (which === 'enhanced' && originalAudioRef.current) originalAudioRef.current.pause();
    setActivePlayer(which);
  };

  const anyActive = Object.values(enhancement).some(Boolean);


  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="enhance-page">
      <div className="enhance-inner">

        <Link to="/" className="enhance-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        <div className="enhance-header">
          <div className="enhance-header-icon">
            <AudioWaveform size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="enhance-title">Audio Enhance</h1>
            <p className="enhance-subtitle">Upload audio, choose enhancements, then run</p>
          </div>
        </div>

        {/* Upload view */}
        {view === 'upload' && (
          <div
            className={`enhance-dropzone${isDragging ? ' dragging' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Drop audio or video file, or click to browse"
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_MIME}
              aria-hidden="true"
              hidden
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <Upload size={32} className="enhance-dropzone-icon" aria-hidden="true" />
            <p className="enhance-dropzone-title">Drag &amp; drop audio or video here</p>
            <p className="enhance-dropzone-sub">or click to browse</p>
            <p className="enhance-dropzone-formats">
              MP3 · WAV · M4A · FLAC · OGG · WEBM · OPUS · AAC · MP4 · MKV · MOV
            </p>
          </div>
        )}

        {/* Configure view */}
        {view === 'configure' && (
          <div className="enhance-configure">
            <div className="enhance-file-row">
              <span className="enhance-filename">{filename}</span>
              <button className="enhance-btn enhance-btn--ghost" onClick={reset}>
                <RotateCcw size={13} aria-hidden="true" />
                Change file
              </button>
            </div>

            <EnhancementPanel
              value={enhancement}
              onChange={setEnhancement}
              models={audioModels}
            />

            {!anyActive && (
              <div className="enhance-warn" role="alert">
                <AlertTriangle size={15} aria-hidden="true" />
                Select at least one enhancement stage above.
              </div>
            )}

            <div className="enhance-start-row">
              <button
                className="enhance-btn enhance-btn--primary"
                onClick={startEnhancement}
                disabled={!anyActive}
              >
                <Play size={14} aria-hidden="true" />
                Enhance
              </button>
            </div>
          </div>
        )}

        {/* Progress view */}
        {view === 'progress' && (
          <div className="enhance-progress" aria-live="polite">
            <div className="enhance-progress-file">
              <AudioWaveform size={16} aria-hidden="true" />
              <span>{filename}</span>
            </div>
            <div className="enhance-progress-track" role="progressbar" aria-label="Enhancement progress">
              <div className="enhance-progress-bar" />
            </div>
            <p className="enhance-progress-label">{progressLabel}</p>
          </div>
        )}

        {/* Result view */}
        {view === 'result' && (
          <div className="enhance-result">
            <div className="enhance-result-header">
              <h2 className="enhance-result-heading">
                {filename}
              </h2>
              <div className="enhance-result-actions">
                <button className="enhance-btn enhance-btn--secondary" onClick={downloadEnhanced}>
                  <Download size={15} aria-hidden="true" />
                  Download
                </button>
                <button className="enhance-btn enhance-btn--ghost" onClick={handleReenhance}>
                  <AudioWaveform size={15} aria-hidden="true" />
                  Re-enhance
                </button>
                <button className="enhance-btn enhance-btn--ghost" onClick={reset}>
                  <RotateCcw size={15} aria-hidden="true" />
                  New file
                </button>
              </div>
            </div>

            {/* A/B comparison */}
            <div className="enhance-comparison">
              <div className="enhance-player-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={activePlayer === 'original'}
                  className={`enhance-player-tab${activePlayer === 'original' ? ' active' : ''}`}
                  onClick={() => switchPlayer('original')}
                >
                  Original
                </button>
                <button
                  role="tab"
                  aria-selected={activePlayer === 'enhanced'}
                  className={`enhance-player-tab${activePlayer === 'enhanced' ? ' active' : ''}`}
                  onClick={() => switchPlayer('enhanced')}
                >
                  Enhanced
                </button>
              </div>

              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                ref={originalAudioRef}
                className={`enhance-audio${activePlayer === 'original' ? ' visible' : ''}`}
                controls
                aria-label="Original audio"
                aria-hidden={activePlayer !== 'original'}
              />
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                ref={enhancedAudioRef}
                className={`enhance-audio${activePlayer === 'enhanced' ? ' visible' : ''}`}
                controls
                aria-label="Enhanced audio"
                aria-hidden={activePlayer !== 'enhanced'}
              />
            </div>

            {/* Re-enhance with different settings */}
            <div className="enhance-reenhance-panel">
              <p className="enhance-reenhance-label">Change settings and re-enhance:</p>
              <EnhancementPanel
                value={enhancement}
                onChange={setEnhancement}
                models={audioModels}
              />
              <button
                className="enhance-btn enhance-btn--primary enhance-reenhance-btn"
                onClick={handleReenhance}
                disabled={!Object.values(enhancement).some(Boolean)}
              >
                <AudioWaveform size={15} aria-hidden="true" />
                Re-enhance with new settings
              </button>
            </div>
          </div>
        )}

        {/* Error view */}
        {view === 'error' && (
          <div className="enhance-error" role="alert" aria-live="assertive">
            <div className="enhance-error-icon" aria-hidden="true">!</div>
            <p className="enhance-error-msg">{errorMsg}</p>
            <button className="enhance-btn enhance-btn--primary" onClick={reset}>
              Try again
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
