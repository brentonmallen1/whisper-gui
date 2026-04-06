import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Sparkles, Copy, Download, RotateCcw,
  Mic, Youtube, Globe, FileText, File as FileIcon,
  AlertTriangle, Upload, X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';
import type { AudioModelMap, EnhancementOptions } from '../types';
import EnhancementPanel, { DEFAULT_ENHANCEMENT } from '../components/EnhancementPanel';
import './Summarize.css';

// ── Types ──────────────────────────────────────────────────────────────────

type SourceTab = 'text' | 'audio' | 'youtube' | 'url' | 'pdf';
type Mode      = 'summary' | 'key_points' | 'mind_map';
type ViewState = 'idle' | 'extracting' | 'transcribing' | 'thinking' | 'streaming' | 'done' | 'error';

// gemma4 thinking block delimiters
const THINK_START = '<|channel>';
const THINK_END   = '<channel|>';

const SOURCE_TABS: { id: SourceTab; label: string; icon: React.ElementType }[] = [
  { id: 'text',    label: 'Text',    icon: FileText  },
  { id: 'audio',   label: 'Audio',   icon: Mic       },
  { id: 'youtube', label: 'YouTube', icon: Youtube   },
  { id: 'url',     label: 'URL',     icon: Globe     },
  { id: 'pdf',     label: 'PDF',     icon: FileIcon  },
];

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'summary',    label: 'Summary',    hint: 'Concise prose overview' },
  { id: 'key_points', label: 'Key Points', hint: 'Numbered list of main ideas' },
  { id: 'mind_map',   label: 'Mind Map',   hint: 'Hierarchical outline' },
];

// Audio/video extensions the Audio tab accepts
const AUDIO_ACCEPT = '.mp3,.wav,.m4a,.flac,.ogg,.webm,.opus,.aac,.wma,.mp4,.mkv,.avi,.mov,.wmv,.flv,.m4v';

// ── DropZone sub-component ─────────────────────────────────────────────────

interface DropZoneProps {
  accept: string;
  file: File | null;
  onFile: (f: File | null) => void;
  label: string;
  hint: string;
  icon: React.ElementType;
  disabled?: boolean;
}

function DropZone({ accept, file, onFile, label, hint, icon: Icon, disabled }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };

  const classes = [
    'summarize-dropzone',
    dragging  ? 'dragging'  : '',
    disabled  ? 'disabled'  : '',
    file      ? 'has-file'  : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => { if (!disabled && !file) inputRef.current?.click(); }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled && !file) inputRef.current?.click(); }}
      aria-label={file ? `Selected file: ${file.name}` : label}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
        disabled={disabled}
      />

      {file ? (
        <div className="summarize-dropzone-file">
          <Icon size={16} aria-hidden="true" />
          <span className="summarize-dropzone-name">{file.name}</span>
          <span className="summarize-dropzone-size">
            {(file.size / (1024 * 1024)).toFixed(1)} MB
          </span>
          {!disabled && (
            <button
              className="summarize-dropzone-remove"
              onClick={(e) => { e.stopPropagation(); onFile(null); }}
              aria-label="Remove file"
            >
              <X size={13} />
            </button>
          )}
        </div>
      ) : (
        <div className="summarize-dropzone-empty">
          <Upload size={22} className="summarize-dropzone-icon" aria-hidden="true" />
          <span className="summarize-dropzone-label">{label}</span>
          <span className="summarize-dropzone-hint">{hint}</span>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Summarize() {
  // ── Common state ──────────────────────────────────────────────────────────
  const [sourceTab, setSourceTab] = useState<SourceTab>('text');
  const [mode,      setMode]      = useState<Mode>('summary');
  const [view,      setView]      = useState<ViewState>('idle');
  const [result,    setResult]    = useState('');
  const [errorMsg,  setErrorMsg]  = useState('');
  const [statusDetail, setStatusDetail] = useState('');
  const [isCopied,  setIsCopied]  = useState(false);

  // ── Source-specific state ─────────────────────────────────────────────────
  const [content,        setContent]        = useState('');          // text tab
  const [audioFile,      setAudioFile]      = useState<File | null>(null);
  const [pdfFile,        setPdfFile]        = useState<File | null>(null);
  const [youtubeUrl,     setYoutubeUrl]     = useState('');
  const [urlInput,       setUrlInput]       = useState('');
  const [preferCaptions, setPreferCaptions] = useState(true);
  const [enhancement,    setEnhancement]    = useState<EnhancementOptions>(DEFAULT_ENHANCEMENT);
  const [audioModels,    setAudioModels]    = useState<AudioModelMap | undefined>(undefined);

  // ── Thinking-block parser refs ────────────────────────────────────────────
  const rawBufferRef  = useRef('');
  const thinkDoneRef  = useRef(false);

  // Load audio model status on mount
  useEffect(() => {
    api.getAudioModels().then(setAudioModels).catch(() => {});
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const reset = () => {
    setView('idle');
    setResult('');
    setErrorMsg('');
    setStatusDetail('');
    rawBufferRef.current  = '';
    thinkDoneRef.current  = false;
  };

  const isRunning = ['extracting', 'transcribing', 'thinking', 'streaming'].includes(view);

  const canSubmit = (() => {
    if (isRunning) return false;
    switch (sourceTab) {
      case 'text':    return content.trim().length > 0;
      case 'audio':   return audioFile !== null;
      case 'youtube': return youtubeUrl.trim().length > 0;
      case 'url':     return urlInput.trim().length > 0;
      case 'pdf':     return pdfFile !== null;
    }
  })();

  // ── Thinking-block parser ─────────────────────────────────────────────────
  // gemma4 wraps its chain-of-thought in <|channel>thought\n...<channel|>.
  // We show a "Thinking…" indicator while that block is active, then reveal
  // the answer text that follows.
  const processChunk = useCallback((chunk: string) => {
    rawBufferRef.current += chunk;
    const raw = rawBufferRef.current;

    if (thinkDoneRef.current) {
      setResult(prev => prev + chunk);
      return;
    }

    const startIdx = raw.indexOf(THINK_START);
    const endIdx   = raw.indexOf(THINK_END);

    if (startIdx === -1) {
      // No thinking block — show content directly
      thinkDoneRef.current = true;
      setView('streaming');
      setResult(prev => prev + chunk);
      return;
    }

    if (endIdx === -1) {
      // Inside thinking block — stay in "thinking" phase
      setView('thinking');
      return;
    }

    // Thinking block complete — extract the answer after it
    thinkDoneRef.current = true;
    const answer = raw.slice(endIdx + THINK_END.length).trimStart();
    setResult(answer);
    setView('streaming');
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!canSubmit) return;

    reset();
    setView('thinking');  // will be overridden by first phase event for non-text sources

    const onPhase = (phase: string, detail: string) => {
      setView(phase as ViewState);
      setStatusDetail(detail);
    };
    const onChunk = (chunk: string) => processChunk(chunk);
    const onError = (msg: string) => { setErrorMsg(msg); setView('error'); };
    const onDone  = () => setView(v => v === 'error' ? v : 'done');

    switch (sourceTab) {
      case 'text':
        await api.summarize(content.trim(), mode, null, onChunk, onError, onDone);
        break;
      case 'audio':
        await api.summarizeFile(audioFile!, 'audio', mode, onPhase, onChunk, onError, onDone, enhancement);
        break;
      case 'pdf':
        await api.summarizeFile(pdfFile!, 'pdf', mode, onPhase, onChunk, onError, onDone);
        break;
      case 'youtube':
        await api.summarizeUrl(youtubeUrl.trim(), 'youtube', mode, preferCaptions, onPhase, onChunk, onError, onDone);
        break;
      case 'url':
        await api.summarizeUrl(urlInput.trim(), 'url', mode, false, onPhase, onChunk, onError, onDone);
        break;
    }
  };

  // ── Copy / download ───────────────────────────────────────────────────────

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(result);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch { /* denied */ }
  };

  const downloadResult = () => {
    const modeLabel = MODES.find(m => m.id === mode)?.label ?? mode;
    const blob = new Blob([result], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${modeLabel.toLowerCase().replace(' ', '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Phase label shown in the thinking indicator ───────────────────────────

  const phaseLabel = (() => {
    if (view === 'thinking') return 'Thinking…';
    if (statusDetail)        return statusDetail;
    if (view === 'extracting')   return 'Extracting…';
    if (view === 'transcribing') return 'Transcribing…';
    return '';
  })();

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="summarize-page">
      <div className="summarize-inner">

        {/* Back */}
        <Link to="/" className="summarize-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        {/* Header */}
        <div className="summarize-header">
          <div className="summarize-header-icon">
            <Sparkles size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="summarize-title">Summarize</h1>
            <p className="summarize-subtitle">Extract insights from any content using AI</p>
          </div>
        </div>

        {/* Source tabs */}
        <div className="summarize-tabs" role="tablist">
          {SOURCE_TABS.map(tab => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={sourceTab === tab.id}
              className={`summarize-tab${sourceTab === tab.id ? ' active' : ''}`}
              onClick={() => !isRunning && setSourceTab(tab.id)}
              disabled={isRunning}
            >
              <tab.icon size={14} aria-hidden="true" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Source input area */}
        {sourceTab === 'text' && (
          <textarea
            className="summarize-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Paste your text, article, transcript, or notes here…"
            rows={10}
            disabled={isRunning}
            aria-label="Content to summarize"
          />
        )}

        {sourceTab === 'audio' && (
          <>
            <DropZone
              accept={AUDIO_ACCEPT}
              file={audioFile}
              onFile={setAudioFile}
              label="Drop audio or video file here, or click to browse"
              hint="MP3, WAV, M4A, FLAC, OGG, MP4, MKV, MOV, …"
              icon={Mic}
              disabled={isRunning}
            />
            <EnhancementPanel
              value={enhancement}
              onChange={setEnhancement}
              models={audioModels}
              disabled={isRunning}
            />
          </>
        )}

        {sourceTab === 'pdf' && (
          <DropZone
            accept=".pdf"
            file={pdfFile}
            onFile={setPdfFile}
            label="Drop a PDF here, or click to browse"
            hint="PDF files only"
            icon={FileIcon}
            disabled={isRunning}
          />
        )}

        {sourceTab === 'youtube' && (
          <div className="summarize-url-block">
            <input
              type="url"
              className="summarize-url-input"
              value={youtubeUrl}
              onChange={e => setYoutubeUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="https://www.youtube.com/watch?v=…"
              disabled={isRunning}
              aria-label="YouTube URL"
            />
            <label className="summarize-caption-toggle">
              <input
                type="checkbox"
                checked={preferCaptions}
                onChange={e => setPreferCaptions(e.target.checked)}
                disabled={isRunning}
              />
              Use captions when available (faster)
            </label>
          </div>
        )}

        {sourceTab === 'url' && (
          <input
            type="url"
            className="summarize-url-input"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="https://…"
            disabled={isRunning}
            aria-label="Webpage URL"
          />
        )}

        {/* Mode + submit */}
        <div className="summarize-controls">
          <div className="summarize-modes" role="group" aria-label="Summarization mode">
            {MODES.map(m => (
              <button
                key={m.id}
                className={`summarize-mode-btn${mode === m.id ? ' active' : ''}`}
                onClick={() => setMode(m.id)}
                disabled={isRunning}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            className="summarize-submit-btn"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            <Sparkles size={15} aria-hidden="true" />
            {isRunning ? 'Processing…' : 'Summarize'}
          </button>
        </div>

        {/* Results */}
        {view !== 'idle' && (
          <div className="summarize-result">

            {/* Result header */}
            <div className="summarize-result-header">
              <h2 className="summarize-result-title">
                {MODES.find(m => m.id === mode)?.label ?? 'Result'}
              </h2>
              {view === 'done' && (
                <div className="summarize-result-actions">
                  <button
                    className={`summarize-action-btn${isCopied ? ' copied' : ''}`}
                    onClick={copyResult}
                  >
                    <Copy size={14} aria-hidden="true" />
                    {isCopied ? 'Copied!' : 'Copy'}
                  </button>
                  <button className="summarize-action-btn" onClick={downloadResult}>
                    <Download size={14} aria-hidden="true" />
                    Download
                  </button>
                  <button className="summarize-action-btn summarize-action-btn--ghost" onClick={reset}>
                    <RotateCcw size={14} aria-hidden="true" />
                    New
                  </button>
                </div>
              )}
            </div>

            {/* Phase indicator: extracting / transcribing / thinking */}
            {(view === 'extracting' || view === 'transcribing' || view === 'thinking') && (
              <div className="summarize-thinking" aria-live="polite">
                <span className="summarize-thinking-dot" />
                <span className="summarize-thinking-dot" />
                <span className="summarize-thinking-dot" />
                <span className="summarize-thinking-label">{phaseLabel}</span>
              </div>
            )}

            {/* Error */}
            {view === 'error' && (
              <div className="summarize-error" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{errorMsg}</span>
                <button className="summarize-action-btn" onClick={reset}>Try again</button>
              </div>
            )}

            {/* Output */}
            {(view === 'streaming' || view === 'done') && result && (
              <div
                className={`summarize-output${view === 'streaming' ? ' streaming' : ''}`}
                aria-live="polite"
                aria-label="Summary result"
              >
                {result}
                {view === 'streaming' && <span className="summarize-cursor" aria-hidden="true" />}
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  );
}
