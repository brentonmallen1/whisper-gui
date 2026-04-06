import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, Upload, Copy, Download, Edit3, RotateCcw, Mic } from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { AudioModelMap, EnhancementOptions, FileMeta } from '../types';
import EnhancementPanel, { DEFAULT_ENHANCEMENT } from '../components/EnhancementPanel';
import './Transcribe.css';

const ACCEPTED_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm', '.opus', '.aac', '.wma',
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v',
];
const ACCEPTED_MIME = ACCEPTED_EXTENSIONS.join(',');
const POLL_INTERVAL_MS = 1200;

type View = 'upload' | 'progress' | 'result' | 'error';
type ActiveTab = 'transcribe' | 'files';

export default function Transcribe() {
  const [view, setView]           = useState<View>('upload');
  const [activeTab, setActiveTab] = useState<ActiveTab>('transcribe');
  const [filename, setFilename]   = useState('');
  const [progressLabel, setProgressLabel] = useState('');
  const [transcript, setTranscript]       = useState('');
  const [errorMsg, setErrorMsg]           = useState('');
  const [wordCount, setWordCount]         = useState(0);
  const [isEditing, setIsEditing]         = useState(false);
  const [isCopied, setIsCopied]           = useState(false);
  const [isDragging, setIsDragging]       = useState(false);
  const [files, setFiles]                 = useState<FileMeta[]>([]);
  const [filesLoading, setFilesLoading]   = useState(false);
  const [enhancement, setEnhancement]     = useState<EnhancementOptions>(DEFAULT_ENHANCEMENT);
  const [audioModels, setAudioModels]     = useState<AudioModelMap | undefined>(undefined);

  const jobIdRef   = useRef<string | null>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef   = useRef<HTMLAudioElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

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

  // ── File handling ──────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    const ext = '.' + file.name.split('.').pop()!.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setErrorMsg(`Unsupported file type: ${ext}. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`);
      setView('error');
      return;
    }
    uploadFile(file);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadFile = async (file: File) => {
    setFilename(file.name);
    setProgressLabel('Uploading…');
    setView('progress');

    try {
      const { job_id } = await api.uploadFile(file, enhancement);
      jobIdRef.current = job_id;
      setProgressLabel('Transcribing…');
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
          showResult(job.result ?? '');
        } else if (job.status === 'error') {
          stopPolling();
          showError(job.error ?? 'Transcription failed.');
        } else if (job.status === 'enhancing') {
          setProgressLabel(job.status_detail || 'Enhancing audio…');
        } else if (job.status === 'processing') {
          setProgressLabel('Transcribing… (this may take a moment)');
        }
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_INTERVAL_MS);
  };

  const showResult = (text: string) => {
    setTranscript(text);
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    setWordCount(words);
    if (audioRef.current && jobIdRef.current) {
      audioRef.current.src = api.getAudioUrl(jobIdRef.current);
    }
    setView('result');
  };

  const showError = (msg: string) => {
    stopPolling();
    setErrorMsg(msg);
    setView('error');
  };

  const reset = () => {
    stopPolling();
    jobIdRef.current = null;
    setView('upload');
    setTranscript('');
    setIsEditing(false);
    setIsCopied(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
  };

  // ── Drag & drop ────────────────────────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // ── Copy ───────────────────────────────────────────────────────────────
  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // clipboard denied
    }
  };

  // ── Export ─────────────────────────────────────────────────────────────
  const exportTxt = () => {
    if (jobIdRef.current) {
      window.location.href = api.getExportUrl(jobIdRef.current);
    }
  };

  // ── File browser ───────────────────────────────────────────────────────
  const loadFiles = async () => {
    setFilesLoading(true);
    try {
      setFiles(await api.getFiles());
    } catch {
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const handleTabChange = (tab: ActiveTab) => {
    setActiveTab(tab);
    if (tab === 'files') loadFiles();
  };

  const retranscribeFile = async (jobId: string, name: string) => {
    setActiveTab('transcribe');
    setFilename(name);
    setProgressLabel('Starting transcription…');
    setView('progress');
    try {
      const { job_id } = await api.retranscribe(jobId, enhancement);
      jobIdRef.current = job_id;
      setProgressLabel('Transcribing…');
      startPolling(job_id);
    } catch (err) {
      showError((err as Error).message);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  const fmtSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

  return (
    <div className="transcribe-page">
      <div className="transcribe-inner">

        {/* Back link */}
        <Link to="/" className="transcribe-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        {/* Page header */}
        <div className="transcribe-header">
          <div className="transcribe-header-icon">
            <Mic size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="transcribe-title">Transcribe</h1>
            <p className="transcribe-subtitle">Audio &amp; video to text using Whisper</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="transcribe-tabs" role="tablist">
          <button
            className={`transcribe-tab ${activeTab === 'transcribe' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'transcribe'}
            onClick={() => handleTabChange('transcribe')}
          >
            Transcribe
          </button>
          <button
            className={`transcribe-tab ${activeTab === 'files' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'files'}
            onClick={() => handleTabChange('files')}
          >
            File history
          </button>
        </div>

        {/* ── Transcribe panel ──────────────────────────────────────────── */}
        {activeTab === 'transcribe' && (
          <div role="tabpanel">

            {/* Upload */}
            {view === 'upload' && (
              <>
                <div
                  className={`transcribe-dropzone ${isDragging ? 'dragging' : ''}`}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  aria-label="Drop audio or video file or click to browse"
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                >
                  <Upload size={32} className="transcribe-dropzone-icon" aria-hidden="true" />
                  <p className="transcribe-dropzone-title">Drag &amp; drop audio or video here</p>
                  <p className="transcribe-dropzone-sub">or click to browse</p>
                  <p className="transcribe-dropzone-formats">
                    MP3 · WAV · M4A · FLAC · OGG · WEBM · OPUS · AAC · MP4 · MKV · MOV
                  </p>
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
                </div>
                <EnhancementPanel
                  value={enhancement}
                  onChange={setEnhancement}
                  models={audioModels}
                />
              </>
            )}

            {/* Progress */}
            {view === 'progress' && (
              <div className="transcribe-progress" aria-live="polite">
                <div className="transcribe-progress-file">
                  <Mic size={16} aria-hidden="true" />
                  <span>{filename}</span>
                </div>
                <div className="transcribe-progress-track" role="progressbar" aria-label="Transcription progress">
                  <div className="transcribe-progress-bar" />
                </div>
                <p className="transcribe-progress-label">{progressLabel}</p>
              </div>
            )}

            {/* Result */}
            {view === 'result' && (
              <div className="transcribe-result">
                <div className="transcribe-result-header">
                  <div className="transcribe-result-meta">
                    <h2 className="transcribe-result-heading">Transcription</h2>
                    <span className="transcribe-result-words">
                      {wordCount.toLocaleString()} word{wordCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="transcribe-result-actions">
                    <button
                      className={`transcribe-btn transcribe-btn--secondary ${isEditing ? 'active' : ''}`}
                      onClick={() => {
                        setIsEditing(e => !e);
                        if (!isEditing) setTimeout(() => textareaRef.current?.focus(), 0);
                      }}
                      aria-pressed={isEditing}
                    >
                      <Edit3 size={15} aria-hidden="true" />
                      {isEditing ? 'Done' : 'Edit'}
                    </button>
                    <button
                      className={`transcribe-btn transcribe-btn--secondary ${isCopied ? 'copied' : ''}`}
                      onClick={copyTranscript}
                    >
                      <Copy size={15} aria-hidden="true" />
                      {isCopied ? 'Copied!' : 'Copy'}
                    </button>
                    <button className="transcribe-btn transcribe-btn--secondary" onClick={exportTxt}>
                      <Download size={15} aria-hidden="true" />
                      Download
                    </button>
                    <button className="transcribe-btn transcribe-btn--ghost" onClick={reset}>
                      <RotateCcw size={15} aria-hidden="true" />
                      New file
                    </button>
                  </div>
                </div>

                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio ref={audioRef} className="transcribe-audio" controls />

                <textarea
                  ref={textareaRef}
                  className={`transcribe-textarea ${isEditing ? 'editable' : ''}`}
                  value={transcript}
                  readOnly={!isEditing}
                  onChange={e => setTranscript(e.target.value)}
                  spellCheck={false}
                  aria-label="Transcription text"
                />
              </div>
            )}

            {/* Error */}
            {view === 'error' && (
              <div className="transcribe-error" role="alert" aria-live="assertive">
                <div className="transcribe-error-icon" aria-hidden="true">!</div>
                <p className="transcribe-error-msg">{errorMsg}</p>
                <button className="transcribe-btn transcribe-btn--primary" onClick={reset}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Files panel ───────────────────────────────────────────────── */}
        {activeTab === 'files' && (
          <div role="tabpanel">
            {filesLoading && (
              <p className="transcribe-files-empty">Loading…</p>
            )}
            {!filesLoading && files.length === 0 && (
              <div className="transcribe-files-empty">
                <Mic size={32} className="transcribe-files-empty-icon" aria-hidden="true" />
                <p>No files uploaded yet.</p>
                <p className="transcribe-files-empty-sub">Files you transcribe will appear here.</p>
              </div>
            )}
            {!filesLoading && files.length > 0 && (
              <ul className="transcribe-files-list" aria-label="Uploaded files">
                {files.map(meta => (
                  <li key={meta.job_id} className="transcribe-file-item">
                    <Mic size={16} className="transcribe-file-icon" aria-hidden="true" />
                    <div className="transcribe-file-info">
                      <span className="transcribe-file-name">
                        {meta.filename ?? meta.audio_file}
                      </span>
                      <span className="transcribe-file-meta">
                        {fmtSize(meta.size)} · {fmtDate(meta.uploaded_at)}
                      </span>
                    </div>
                    <button
                      className="transcribe-btn transcribe-btn--primary transcribe-btn--sm"
                      onClick={() => retranscribeFile(meta.job_id, meta.filename ?? meta.audio_file)}
                    >
                      Transcribe
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
