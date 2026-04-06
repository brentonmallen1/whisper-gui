import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowLeft, Layers, Upload, X, CheckCircle, AlertCircle, Loader, Play, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import * as api from '../api/client';
import './Batch.css';

// ── Types ──────────────────────────────────────────────────────────────────

type BatchSource = 'audio' | 'pdf' | 'image';
type BatchStatus = 'pending' | 'extracting' | 'transcribing' | 'thinking' | 'streaming' | 'done' | 'error';

interface BatchItem {
  id:           string;
  file:         File;
  source:       BatchSource;
  status:       BatchStatus;
  statusDetail: string;
  result:       string;
  reasoning:    string;
  error:        string;
  expanded:     boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const AUDIO_EXTS = new Set(['mp3','wav','m4a','flac','ogg','webm','opus','aac','wma','mp4','mkv','avi','mov','wmv','flv','m4v']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','gif']);
const ACCEPT     = [
  '.mp3,.wav,.m4a,.flac,.ogg,.webm,.opus,.aac,.wma,.mp4,.mkv,.avi,.mov,.wmv,.flv,.m4v',
  '.pdf',
  '.jpg,.jpeg,.png,.webp,.gif',
].join(',');

const DEFAULT_MODES = [
  { id: 'summary',      label: 'Summary' },
  { id: 'key_points',   label: 'Key Points' },
  { id: 'mind_map',     label: 'Mind Map' },
  { id: 'action_items', label: 'Action Items' },
  { id: 'q_and_a',      label: 'Q&A' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function detectSource(file: File): BatchSource | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === 'pdf')        return 'pdf';
  if (IMAGE_EXTS.has(ext))  return 'image';
  return null;
}

function makeId(): string {
  return Math.random().toString(36).slice(2);
}

function makeItem(file: File, source: BatchSource): BatchItem {
  return {
    id: makeId(), file, source,
    status: 'pending', statusDetail: '', result: '', reasoning: '', error: '',
    expanded: false,
  };
}

const STATUS_LABELS: Record<BatchStatus, string> = {
  pending:      'Pending',
  extracting:   'Extracting…',
  transcribing: 'Transcribing…',
  thinking:     'Thinking…',
  streaming:    'Generating…',
  done:         'Done',
  error:        'Error',
};

const SOURCE_BADGE: Record<BatchSource, string> = {
  audio: 'AUDIO',
  pdf:   'PDF',
  image: 'IMAGE',
};

// ── Component ──────────────────────────────────────────────────────────────

export default function Batch() {
  const [items,        setItems]        = useState<BatchItem[]>([]);
  const [mode,         setMode]         = useState('summary');
  const [modes,        setModes]        = useState(DEFAULT_MODES);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragging,     setDragging]     = useState(false);

  const processingRef = useRef(false);
  const inputRef      = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getPrompts().then(prompts => {
      const seen = new Map<string, { id: string; label: string }>();
      const sorted = [...prompts].sort((a, b) => Number(b.is_default) - Number(a.is_default));
      for (const p of sorted) seen.set(p.mode, { id: p.mode, label: p.name });
      if (seen.size > 0) setModes([...seen.values()]);
    }).catch(() => {});
  }, []);

  // ── Item management ────────────────────────────────────────────────────────

  const updateItem = useCallback((id: string, patch: Partial<BatchItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const appendResult = useCallback((id: string, chunk: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, result: item.result + chunk } : item
    ));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const newItems: BatchItem[] = [];
    for (const file of files) {
      const source = detectSource(file);
      if (source) newItems.push(makeItem(file, source));
    }
    if (newItems.length > 0) setItems(prev => [...prev, ...newItems]);
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    if (!isProcessing) setItems([]);
  }, [isProcessing]);

  const toggleExpand = useCallback((id: string) => {
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, expanded: !item.expanded } : item
    ));
  }, []);

  // ── Drop zone ──────────────────────────────────────────────────────────────

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (isProcessing) return;
    addFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  // ── Processing ─────────────────────────────────────────────────────────────

  const startBatch = async () => {
    if (isProcessing) return;
    const pending = items.filter(i => i.status === 'pending');
    if (pending.length === 0) return;

    processingRef.current = true;
    setIsProcessing(true);

    for (const item of pending) {
      if (!processingRef.current) break;

      updateItem(item.id, { status: 'thinking', statusDetail: '', result: '', error: '' });

      const onPhase = (phase: string, detail: string) =>
        updateItem(item.id, { status: phase as BatchStatus, statusDetail: detail });

      const onChunk = (chunk: string) => appendResult(item.id, chunk);

      const onError = (msg: string) =>
        updateItem(item.id, { status: 'error', error: msg });

      const onDone = () => {
        setItems(prev => {
          const found = prev.find(i => i.id === item.id);
          if (found?.result) {
            api.saveHistory({
              mode,
              source: item.source,
              result: found.result,
              reasoning: found.reasoning,
            }).catch(() => {});
          }
          return prev.map(i => i.id === item.id ? { ...i, status: 'done' } : i);
        });
      };

      if (item.source === 'audio') {
        await api.summarizeFile(item.file, 'audio', mode, onPhase, onChunk, onError, onDone);
      } else if (item.source === 'pdf') {
        await api.summarizeFile(item.file, 'pdf', mode, onPhase, onChunk, onError, onDone);
      } else if (item.source === 'image') {
        await api.summarizeImage(item.file, mode, onChunk, onError, onDone);
      }
    }

    processingRef.current = false;
    setIsProcessing(false);
  };

  const stopBatch = () => {
    processingRef.current = false;
    // The current in-flight item will complete; subsequent ones won't start
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const doneCount  = items.filter(i => i.status === 'done').length;
  const errorCount = items.filter(i => i.status === 'error').length;
  const pendingCount = items.filter(i => i.status === 'pending').length;
  const canStart   = !isProcessing && pendingCount > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="batch-page">
      <div className="batch-inner">

        <Link to="/" className="batch-back">
          <ArrowLeft size={15} aria-hidden="true" />
          All tools
        </Link>

        <div className="batch-header">
          <div className="batch-header-icon">
            <Layers size={20} aria-hidden="true" />
          </div>
          <div>
            <h1 className="batch-title">Batch</h1>
            <p className="batch-subtitle">Summarize multiple files at once</p>
          </div>
        </div>

        {/* Drop zone */}
        <div
          className={`batch-dropzone${dragging ? ' dragging' : ''}${isProcessing ? ' disabled' : ''}`}
          onDragOver={e => { e.preventDefault(); if (!isProcessing) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => { if (!isProcessing) inputRef.current?.click(); }}
          role="button"
          tabIndex={isProcessing ? -1 : 0}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && !isProcessing && inputRef.current?.click()}
          aria-label="Drop files to add to batch"
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={handleFileInput}
            disabled={isProcessing}
          />
          <Upload size={22} className="batch-dropzone-icon" aria-hidden="true" />
          <span className="batch-dropzone-label">Drop files here, or click to browse</span>
          <span className="batch-dropzone-hint">Audio, PDF, and image files supported</span>
        </div>

        {/* Controls */}
        <div className="batch-controls">
          <div className="batch-mode-group">
            <label className="batch-mode-label" htmlFor="batch-mode">Mode</label>
            <select
              id="batch-mode"
              className="batch-mode-select"
              value={mode}
              onChange={e => setMode(e.target.value)}
              disabled={isProcessing}
            >
              {modes.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="batch-actions">
            {items.length > 0 && !isProcessing && (
              <button className="batch-btn batch-btn--ghost" onClick={clearAll}>
                <Trash2 size={14} aria-hidden="true" />
                Clear all
              </button>
            )}
            {isProcessing ? (
              <button className="batch-btn batch-btn--danger" onClick={stopBatch}>
                Stop after current
              </button>
            ) : (
              <button
                className="batch-btn batch-btn--primary"
                onClick={startBatch}
                disabled={!canStart}
              >
                <Play size={14} aria-hidden="true" />
                Start batch
              </button>
            )}
          </div>
        </div>

        {/* Progress summary */}
        {items.length > 0 && (
          <div className="batch-progress">
            <span className="batch-progress-count">
              {doneCount}/{items.length} complete
            </span>
            {errorCount > 0 && (
              <span className="batch-progress-errors">{errorCount} error{errorCount > 1 ? 's' : ''}</span>
            )}
            {isProcessing && (
              <span className="batch-progress-running">Processing…</span>
            )}
          </div>
        )}

        {/* Item list */}
        {items.length > 0 && (
          <ul className="batch-list">
            {items.map(item => (
              <li key={item.id} className={`batch-item batch-item--${item.status}`}>

                {/* Row header */}
                <div className="batch-item-row">
                  <StatusIcon status={item.status} />

                  <div className="batch-item-info">
                    <span className="batch-item-name" title={item.file.name}>{item.file.name}</span>
                    <div className="batch-item-meta">
                      <span className={`batch-source-badge batch-source-badge--${item.source}`}>
                        {SOURCE_BADGE[item.source]}
                      </span>
                      <span className="batch-item-status">
                        {item.status === 'error'
                          ? item.error
                          : STATUS_LABELS[item.status]}
                        {item.statusDetail ? ` — ${item.statusDetail}` : ''}
                      </span>
                    </div>
                  </div>

                  <div className="batch-item-actions">
                    {item.status === 'done' && (
                      <button
                        className="batch-icon-btn"
                        onClick={() => toggleExpand(item.id)}
                        aria-expanded={item.expanded}
                        aria-label={item.expanded ? 'Collapse result' : 'Expand result'}
                      >
                        {item.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    )}
                    {!isProcessing && item.status !== 'streaming' && item.status !== 'thinking' && (
                      <button
                        className="batch-icon-btn batch-icon-btn--danger"
                        onClick={() => removeItem(item.id)}
                        aria-label="Remove item"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Streaming output (live) */}
                {item.status === 'streaming' && item.result && (
                  <div className="batch-item-streaming">
                    {item.result}
                    <span className="batch-cursor" aria-hidden="true" />
                  </div>
                )}

                {/* Expanded result (done) */}
                {item.status === 'done' && item.expanded && (
                  <div className="batch-item-body">
                    <div className="batch-result-text">
                      <ReactMarkdown>{item.result}</ReactMarkdown>
                    </div>
                    {item.reasoning && (
                      <details className="batch-reasoning">
                        <summary className="batch-reasoning-summary">
                          Reasoning
                          <span className="batch-reasoning-lines">
                            {item.reasoning.split('\n').filter(Boolean).length} lines
                          </span>
                        </summary>
                        <pre className="batch-reasoning-body">{item.reasoning}</pre>
                      </details>
                    )}
                  </div>
                )}

              </li>
            ))}
          </ul>
        )}


      </div>
    </div>
  );
}

// ── Status icon sub-component ──────────────────────────────────────────────

function StatusIcon({ status }: { status: BatchStatus }) {
  switch (status) {
    case 'done':
      return <CheckCircle size={16} className="batch-status-icon batch-status-icon--done" aria-label="Done" />;
    case 'error':
      return <AlertCircle size={16} className="batch-status-icon batch-status-icon--error" aria-label="Error" />;
    case 'pending':
      return <span className="batch-status-dot" aria-label="Pending" />;
    default:
      return <Loader size={16} className="batch-status-icon batch-status-icon--running" aria-label="Processing" />;
  }
}
