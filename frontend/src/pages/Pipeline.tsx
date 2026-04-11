import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, Upload, Download, RotateCcw, Undo2, Mic, GitBranch, CheckCircle2, Loader2, AlertTriangle, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { AudioModelMap, PipelineSession } from '../types';
import './Pipeline.css';

const ACCEPTED_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm', '.opus', '.aac', '.wma',
];
const ACCEPTED_MIME = ACCEPTED_EXTENSIONS.join(',');
const POLL_INTERVAL_MS = 1000;

const STEPS: { key: string; label: string; hint: string; modelKey?: string }[] = [
  { key: 'normalize', label: 'Normalize',         hint: 'EBU R128 loudness normalization via ffmpeg' },
  { key: 'denoise',   label: 'Denoise',           hint: 'Speech enhancement via ClearVoice',              modelKey: 'clearvoice' },
  { key: 'isolate',   label: 'Isolate vocals',    hint: 'Vocal isolation from music via Demucs',          modelKey: 'demucs' },
  { key: 'separate',  label: 'Separate speakers', hint: 'Separate overlapping speakers via ClearVoice',   modelKey: 'clearvoice' },
  { key: 'upsample',  label: 'Upsample',          hint: 'Super-resolution to 48kHz via ClearVoice',       modelKey: 'clearvoice' },
];

const STEP_LABELS: Record<string, string> = Object.fromEntries(STEPS.map(s => [s.key, s.label]));

type View = 'upload' | 'builder' | 'error';

interface TranscriptResult {
  text: string;
  language: string;
}

export default function Pipeline() {
  const [view, setView]                   = useState<View>('upload');
  const [session, setSession]             = useState<PipelineSession | null>(null);
  const [filename, setFilename]           = useState('');
  const [isDragging, setIsDragging]       = useState(false);
  const [errorMsg, setErrorMsg]           = useState('');
  const [activeAudio, setActiveAudio]     = useState<'current' | 'original'>('current');
  const [transcript, setTranscript]       = useState<TranscriptResult | null>(null);
  const [transcribing, setTranscribing]   = useState(false);
  const [transcriptErr, setTranscriptErr] = useState('');
  const [audioModels, setAudioModels]     = useState<AudioModelMap | undefined>(undefined);
  const [pendingSteps, setPendingSteps]   = useState<string[]>([]);

  const sessionIdRef   = useRef<string | null>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const audioRef       = useRef<HTMLAudioElement>(null);
  const runQueueRef    = useRef<string[]>([]);

  useEffect(() => {
    api.getAudioModels().then(setAudioModels).catch(() => {});
  }, []);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => {
    stopPoll();
    if (transcriptPoll.current) clearInterval(transcriptPoll.current);
  }, [stopPoll]);

  // ── File handling ──────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    const ext = '.' + file.name.split('.').pop()!.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setErrorMsg(`Unsupported file type: ${ext}`);
      setView('error');
      return;
    }

    setFilename(file.name);
    setTranscript(null);
    setTranscriptErr('');
    setActiveAudio('current');

    try {
      const { session_id } = await api.createPipeline(file);
      sessionIdRef.current = session_id;
      const s = await api.getPipelineSession(session_id);
      setSession(s);
      setView('builder');
    } catch (err) {
      setErrorMsg((err as Error).message);
      setView('error');
    }
  }, []);

  // ── Poll session state while a step is processing ──────────────────────────

  const startPolling = useCallback((sessionId: string) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getPipelineSession(sessionId);
        setSession(prev => {
          if (
            prev?.status === s.status &&
            prev?.steps.length === s.steps.length &&
            prev?.status_detail === s.status_detail &&
            prev?.error === s.error
          ) return prev;
          return s;
        });
        if (s.status !== 'processing') {
          stopPoll();
          // Auto-continue queued steps
          if (s.status !== 'error' && runQueueRef.current.length > 0) {
            const next = runQueueRef.current.shift()!;
            try {
              await api.applyPipelineStep(sessionId, next);
              setSession(ss => ss ? { ...ss, status: 'processing', status_detail: `Applying ${STEP_LABELS[next] ?? next}…` } : ss);
              startPolling(sessionId);
            } catch (err) {
              setErrorMsg((err as Error).message);
            }
          }
        }
      } catch { /* network hiccup — keep polling */ }
    }, POLL_INTERVAL_MS);
  }, [stopPoll]);

  // ── Toggle / run steps ────────────────────────────────────────────────────

  const toggleStep = (step: string) => {
    if (processing) return;
    setPendingSteps(prev =>
      prev.includes(step) ? prev.filter(s => s !== step) : [...prev, step]
    );
  };

  const runPipeline = async () => {
    if (!pendingSteps.length || !sessionIdRef.current || processing) return;
    const [first, ...rest] = pendingSteps;
    runQueueRef.current = rest;
    setPendingSteps([]);
    setActiveAudio('current');
    try {
      await api.applyPipelineStep(sessionIdRef.current, first);
      setSession(s => s ? { ...s, status: 'processing', status_detail: `Applying ${STEP_LABELS[first] ?? first}…` } : s);
      startPolling(sessionIdRef.current);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  // ── Undo last step ─────────────────────────────────────────────────────────

  const undoStep = async () => {
    if (!sessionIdRef.current || !session?.steps.length || session.status === 'processing') return;
    try {
      await api.undoPipelineStep(sessionIdRef.current);
      // Derive new state locally — no need for a follow-up GET
      setSession(prev => prev ? { ...prev, steps: prev.steps.slice(0, -1), error: null } : prev);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  // ── Transcribe ─────────────────────────────────────────────────────────────

  const transcribe = async () => {
    if (!sessionIdRef.current || transcribing || session?.status === 'processing') return;
    setTranscribing(true);
    setTranscript(null);
    setTranscriptErr('');

    try {
      const { job_id } = await api.transcribePipeline(sessionIdRef.current);

      transcriptPoll.current = setInterval(async () => {
        try {
          const job = await api.getStatus(job_id);
          if (job.status === 'done') {
            clearInterval(transcriptPoll.current!);
            transcriptPoll.current = null;
            setTranscript({ text: job.result ?? '', language: job.language });
            setTranscribing(false);
          } else if (job.status === 'error') {
            clearInterval(transcriptPoll.current!);
            transcriptPoll.current = null;
            setTranscriptErr(job.error ?? 'Transcription failed.');
            setTranscribing(false);
          }
        } catch { /* keep polling */ }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setTranscriptErr((err as Error).message);
      setTranscribing(false);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────

  const reset = () => {
    stopPoll();
    if (transcriptPoll.current) { clearInterval(transcriptPoll.current); transcriptPoll.current = null; }
    if (sessionIdRef.current) {
      api.deletePipeline(sessionIdRef.current).catch(() => {});
      sessionIdRef.current = null;
    }
    runQueueRef.current = [];
    setSession(null);
    setPendingSteps([]);
    setTranscript(null);
    setTranscriptErr('');
    setTranscribing(false);
    setView('upload');
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Audio src — reloads when active tab or step count changes ──────────────

  const stepsLen = session?.steps.length ?? 0;

  useEffect(() => {
    if (view === 'builder' && sessionIdRef.current && audioRef.current) {
      audioRef.current.src = api.getPipelineAudioUrl(sessionIdRef.current, activeAudio);
      audioRef.current.load();
    }
  }, [view, activeAudio, stepsLen]);

  const switchAudio = (which: 'current' | 'original') => {
    if (audioRef.current) audioRef.current.pause();
    setActiveAudio(which);
  };

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const processing = session?.status === 'processing';

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="pipeline-page">
      <div className="pipeline-inner">

        <Link to="/" className="pipeline-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        <div className="pipeline-header">
          <div className="pipeline-header-icon">
            <GitBranch size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="pipeline-title">Audio Pipeline</h1>
            <p className="pipeline-subtitle">
              Upload audio, select enhancement steps, then run them and transcribe
            </p>
          </div>
        </div>

        {/* ── Upload view ─────────────────────────────────────────────────── */}
        {view === 'upload' && (
          <div
            className={`pipeline-dropzone${isDragging ? ' dragging' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Drop audio file, or click to browse"
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_MIME}
              aria-hidden="true"
              hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            <Upload size={32} className="pipeline-dropzone-icon" aria-hidden="true" />
            <p className="pipeline-dropzone-title">Drag &amp; drop audio here</p>
            <p className="pipeline-dropzone-sub">or click to browse</p>
            <p className="pipeline-dropzone-formats">MP3 · WAV · M4A · FLAC · OGG · WEBM · OPUS · AAC</p>
          </div>
        )}

        {/* ── Builder view ────────────────────────────────────────────────── */}
        {view === 'builder' && session && (
          <div className="pipeline-builder">

            {/* File + actions row */}
            <div className="pipeline-file-row">
              <span className="pipeline-filename">{filename}</span>
              <div className="pipeline-file-actions">
                <button
                  className="pipeline-btn pipeline-btn--secondary"
                  onClick={() => { window.location.href = api.getPipelineDownloadUrl(sessionIdRef.current!); }}
                  disabled={processing}
                  title="Download current audio"
                >
                  <Download size={14} aria-hidden="true" />
                  Download
                </button>
                <button className="pipeline-btn pipeline-btn--ghost" onClick={reset} title="Start over with a new file">
                  <RotateCcw size={14} aria-hidden="true" />
                  New file
                </button>
              </div>
            </div>

            {/* Audio player */}
            <div className="pipeline-player-card">
              <div className="pipeline-player-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={activeAudio === 'current'}
                  className={`pipeline-player-tab${activeAudio === 'current' ? ' active' : ''}`}
                  onClick={() => switchAudio('current')}
                  disabled={processing}
                >
                  {session.steps.length > 0 ? `Enhanced (${session.steps.length} step${session.steps.length !== 1 ? 's' : ''})` : 'Original'}
                </button>
                {session.steps.length > 0 && (
                  <button
                    role="tab"
                    aria-selected={activeAudio === 'original'}
                    className={`pipeline-player-tab${activeAudio === 'original' ? ' active' : ''}`}
                    onClick={() => switchAudio('original')}
                    disabled={processing}
                  >
                    Original
                  </button>
                )}
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio ref={audioRef} className="pipeline-audio" controls aria-label="Audio preview" />
            </div>

            {/* Step history */}
            {session.steps.length > 0 && (
              <div className="pipeline-history">
                <div className="pipeline-history-header">
                  <span className="pipeline-history-label">Applied steps</span>
                  <button
                    className="pipeline-btn pipeline-btn--ghost pipeline-undo-btn"
                    onClick={undoStep}
                    disabled={processing}
                    title="Remove last step"
                  >
                    <Undo2 size={13} aria-hidden="true" />
                    Undo
                  </button>
                </div>
                <ol className="pipeline-steps-list">
                  {session.steps.map((s, i) => (
                    <li key={i} className="pipeline-step-item">
                      <CheckCircle2 size={14} className="pipeline-step-check" aria-hidden="true" />
                      <span className="pipeline-step-name">{STEP_LABELS[s.step] ?? s.step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* Processing indicator */}
            {processing && (
              <div className="pipeline-processing" aria-live="polite">
                <Loader2 size={16} className="pipeline-spinner" aria-hidden="true" />
                <span>{session.status_detail || 'Processing…'}</span>
              </div>
            )}

            {/* Error from step */}
            {session.status === 'error' && session.error && (
              <div className="pipeline-step-error" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                {session.error}
              </div>
            )}

            {/* Enhancement steps */}
            <div className="pipeline-add-section">
              <p className="pipeline-add-label">Enhancement steps</p>
              <div className="pipeline-add-steps">
                {STEPS.map(step => {
                  const status   = step.modelKey ? audioModels?.[step.modelKey] : undefined;
                  const missing  = status !== undefined && !status.package;
                  const selected = pendingSteps.includes(step.key);
                  return (
                    <button
                      key={step.key}
                      className={`pipeline-btn pipeline-btn--step${selected ? ' selected' : ''}`}
                      onClick={() => toggleStep(step.key)}
                      disabled={processing || missing}
                      title={missing ? `${step.hint} — package not installed` : step.hint}
                    >
                      {step.label}
                      {missing && <AlertTriangle size={11} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
              {pendingSteps.length > 0 && (
                <div className="pipeline-run-row">
                  <span className="pipeline-pending-summary">
                    {pendingSteps.map(s => STEP_LABELS[s] ?? s).join(' → ')}
                  </span>
                  <button
                    className="pipeline-btn pipeline-btn--primary"
                    onClick={runPipeline}
                    disabled={processing}
                  >
                    <Play size={13} aria-hidden="true" />
                    Run
                  </button>
                </div>
              )}
            </div>

            {/* Transcribe */}
            <div className="pipeline-transcribe-section">
              <button
                className="pipeline-btn pipeline-btn--primary pipeline-transcribe-btn"
                onClick={transcribe}
                disabled={processing || transcribing}
              >
                {transcribing ? (
                  <>
                    <Loader2 size={15} className="pipeline-spinner" aria-hidden="true" />
                    Transcribing…
                  </>
                ) : (
                  <>
                    <Mic size={15} aria-hidden="true" />
                    Transcribe
                  </>
                )}
              </button>
              <p className="pipeline-transcribe-hint">
                Transcribes the current enhanced audio
              </p>
            </div>

            {/* Transcript result */}
            {transcriptErr && (
              <div className="pipeline-step-error" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                {transcriptErr}
              </div>
            )}

            {transcript && (
              <div className="pipeline-transcript">
                <div className="pipeline-transcript-header">
                  <span className="pipeline-transcript-label">
                    Transcript
                    {transcript.language && (
                      <span className="pipeline-transcript-lang">{transcript.language.toUpperCase()}</span>
                    )}
                  </span>
                  <button
                    className="pipeline-btn pipeline-btn--ghost"
                    onClick={() => navigator.clipboard.writeText(transcript.text)}
                    title="Copy to clipboard"
                  >
                    Copy
                  </button>
                </div>
                <p className="pipeline-transcript-text">{transcript.text}</p>
              </div>
            )}

          </div>
        )}

        {/* ── Error view ──────────────────────────────────────────────────── */}
        {view === 'error' && (
          <div className="pipeline-error" role="alert" aria-live="assertive">
            <div className="pipeline-error-icon" aria-hidden="true">!</div>
            <p className="pipeline-error-msg">{errorMsg}</p>
            <button className="pipeline-btn pipeline-btn--primary" onClick={reset}>
              Try again
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
