import { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  ArrowLeft, Sparkles, Copy, Download, RotateCcw,
  Mic, Youtube, Globe, FileText, File as FileIcon, Image as ImageIcon,
  AlertTriangle, Upload, X, Code, MessageSquare, Send, Trash2, Languages,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import * as api from '../api/client';
import type { AudioModelMap, ChatMessage, EnhancementOptions } from '../types';
import EnhancementPanel, { DEFAULT_ENHANCEMENT } from '../components/EnhancementPanel';
import MindMapDiagram from '../components/MindMapDiagram';
import { useSourceCache } from '../context/SourceCache';
import './Summarize.css';

// ── Types ──────────────────────────────────────────────────────────────────

type SourceTab = 'text' | 'audio' | 'youtube' | 'url' | 'pdf' | 'image';
type ViewState = 'idle' | 'extracting' | 'transcribing' | 'thinking' | 'streaming' | 'done' | 'error';

// gemma4 thinking block delimiters
const THINK_START = '<|channel>';
const THINK_END   = '<channel|>';

const SOURCE_TABS: { id: SourceTab; label: string; icon: React.ElementType }[] = [
  { id: 'text',    label: 'Text',    icon: FileText   },
  { id: 'audio',   label: 'Audio',   icon: Mic        },
  { id: 'youtube', label: 'YouTube', icon: Youtube    },
  { id: 'url',     label: 'URL',     icon: Globe      },
  { id: 'pdf',     label: 'PDF',     icon: FileIcon   },
  { id: 'image',   label: 'Image',   icon: ImageIcon  },
];

const TRANSCRIPT_MODE = { id: 'transcript', label: 'Transcript', hint: 'Raw transcription — no AI processing' };

// Static fallback modes (used before prompts load from API)
const DEFAULT_modes: { id: string; label: string; hint: string }[] = [
  { id: 'summary',         label: 'Summary',         hint: 'Concise prose overview' },
  { id: 'key_points',      label: 'Key Points',      hint: 'Numbered list of main ideas' },
  { id: 'mind_map',        label: 'Mind Map',        hint: 'Hierarchical outline' },
  { id: 'action_items',    label: 'Action Items',    hint: 'Concrete tasks and next steps' },
  { id: 'q_and_a',         label: 'Q&A',             hint: 'Questions and answers' },
  { id: 'meeting_minutes', label: 'Meeting Minutes', hint: 'Structured notes from a meeting' },
  TRANSCRIPT_MODE,
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
  const [searchParams] = useSearchParams();
  const sourceCache = useSourceCache();

  // ── Common state ──────────────────────────────────────────────────────────
  const validTabs = SOURCE_TABS.map(t => t.id) as string[];
  const initialTab = searchParams.get('tab');
  const [sourceTab, setSourceTab] = useState<SourceTab>(
    (initialTab && validTabs.includes(initialTab) ? initialTab : 'text') as SourceTab
  );
  const [mode,      setMode]      = useState<string>('summary');
  const [modes,     setModes]     = useState(DEFAULT_modes);
  const [view,      setView]      = useState<ViewState>('idle');
  const [result,    setResult]    = useState('');
  const [errorMsg,  setErrorMsg]  = useState('');
  const [statusDetail, setStatusDetail] = useState('');
  const [isCopied,       setIsCopied]       = useState(false);
  const [reasoning,      setReasoning]      = useState('');
  const [renderMarkdown, setRenderMarkdown] = useState(false);

  // Per-mode result cache: clicking a completed mode navigates to its output
  type ModeCache = Record<string, { result: string; reasoning: string }>;
  const [modeCache, setModeCache] = useState<ModeCache>({});

  // Accumulator refs so we can read the final result synchronously in onDone
  const resultAccumRef    = useRef('');
  const reasoningAccumRef = useRef('');
  const submittedModeRef  = useRef('');
  const submittedSourceRef = useRef('');

  // ── Source-specific state ─────────────────────────────────────────────────
  const [content,        setContent]        = useState('');          // text tab
  const [audioFile,      setAudioFile]      = useState<File | null>(null);
  const [pdfFile,        setPdfFile]        = useState<File | null>(null);
  const [imageFile,      setImageFile]      = useState<File | null>(null);
  const [youtubeUrl,     setYoutubeUrl]     = useState('');
  const [urlInput,       setUrlInput]       = useState('');
  const [preferCaptions, setPreferCaptions] = useState(true);
  const [enhancement,    setEnhancement]    = useState<EnhancementOptions>(DEFAULT_ENHANCEMENT);
  const [audioModels,    setAudioModels]    = useState<AudioModelMap | undefined>(undefined);

  // ── Translation state ─────────────────────────────────────────────────────
  const [translateLang,   setTranslateLang]   = useState('Spanish');
  const [translation,     setTranslation]     = useState('');
  const [translateState,  setTranslateState]  = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [translateError,  setTranslateError]  = useState('');
  const translateAccumRef = useRef('');

  // ── Chat state ────────────────────────────────────────────────────────────
  // sourceContent holds the full text available for chat (set after submit)
  const [sourceContent,    setSourceContent]    = useState('');
  const [isChatOpen,       setIsChatOpen]       = useState(false);
  const [chatMessages,     setChatMessages]     = useState<ChatMessage[]>([]);
  const [chatInput,        setChatInput]        = useState('');
  const [isChatStreaming,  setIsChatStreaming]  = useState(false);
  const [chatNotices,      setChatNotices]      = useState<string[]>([]);
  const chatEndRef    = useRef<HTMLDivElement>(null);
  const chatAccumRef  = useRef('');

  // Auto-scroll chat to bottom when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── Thinking-block parser refs ────────────────────────────────────────────
  const rawBufferRef  = useRef('');
  const thinkDoneRef  = useRef(false);

  // Load audio model status and prompt modes on mount
  useEffect(() => {
    api.getAudioModels().then(setAudioModels).catch(() => {});
    api.getPrompts().then(prompts => {
      // Deduplicate by mode: custom prompts shadow built-ins for the same mode slug
      const seen = new Map<string, { id: string; label: string; hint: string }>();
      // Process defaults first, then custom (custom overwrites defaults in the map)
      const sorted = [...prompts].sort((a, b) => Number(b.is_default) - Number(a.is_default));
      for (const p of sorted) {
        seen.set(p.mode, { id: p.mode, label: p.name, hint: '' });
      }
      if (seen.size > 0) setModes([...seen.values(), TRANSCRIPT_MODE]);
    }).catch(() => {});
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const reset = () => {
    setView('idle');
    setResult('');
    setErrorMsg('');
    setStatusDetail('');
    setReasoning('');
    setModeCache({});
    setSourceContent('');
    setChatMessages([]);
    setChatNotices([]);
    setChatInput('');
    setImageFile(null);
    setTranslation('');
    setTranslateState('idle');
    rawBufferRef.current      = '';
    thinkDoneRef.current      = false;
    resultAccumRef.current    = '';
    reasoningAccumRef.current = '';
  };

  const runTranslation = async () => {
    if (!result) return;
    setTranslation('');
    setTranslateError('');
    setTranslateState('streaming');
    translateAccumRef.current = '';
    await api.translateStream(
      result,
      translateLang,
      chunk => {
        translateAccumRef.current += chunk;
        setTranslation(translateAccumRef.current);
      },
      () => setTranslateState('done'),
      msg => { setTranslateError(msg); setTranslateState('error'); },
    );
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
      case 'image':   return imageFile !== null;
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
      resultAccumRef.current += chunk;
      setResult(prev => prev + chunk);
      return;
    }

    const startIdx = raw.indexOf(THINK_START);
    const endIdx   = raw.indexOf(THINK_END);

    if (startIdx === -1) {
      // No thinking block — show content directly
      thinkDoneRef.current = true;
      resultAccumRef.current += chunk;
      setView('streaming');
      setResult(prev => prev + chunk);
      return;
    }

    if (endIdx === -1) {
      // Inside thinking block — stay in "thinking" phase
      setView('thinking');
      return;
    }

    // Thinking block complete — capture reasoning, extract answer after it
    thinkDoneRef.current = true;
    const thinkText = raw.slice(startIdx + THINK_START.length, endIdx).replace(/^thought\n/, '').trim();
    const answer    = raw.slice(endIdx + THINK_END.length).trimStart();
    reasoningAccumRef.current = thinkText;
    resultAccumRef.current    = answer;
    setReasoning(thinkText);
    setResult(answer);
    setView('streaming');
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!canSubmit) return;

    // Reset streaming state but keep modeCache (other modes' results stay)
    setView('thinking');
    setResult('');
    setErrorMsg('');
    setStatusDetail('');
    setReasoning('');
    rawBufferRef.current       = '';
    thinkDoneRef.current       = false;
    resultAccumRef.current     = '';
    reasoningAccumRef.current  = '';
    submittedModeRef.current   = mode;
    submittedSourceRef.current = sourceTab;

    const onPhase = (phase: string, detail: string) => {
      setView(phase as ViewState);
      setStatusDetail(detail);
    };
    const onChunk = (chunk: string) => processChunk(chunk);
    const onError = (msg: string) => { setErrorMsg(msg); setView('error'); };
    const onDone  = () => {
      setView(v => v === 'error' ? v : 'done');
      const finalResult   = resultAccumRef.current;
      const finalReasoning = reasoningAccumRef.current;
      setModeCache(prev => ({
        ...prev,
        [submittedModeRef.current]: {
          result:    finalResult,
          reasoning: finalReasoning,
        },
      }));
      if (finalResult) {
        const src = submittedSourceRef.current as SourceTab;
        const sourceDetail =
          src === 'youtube' ? youtubeUrl.trim() :
          src === 'url'     ? urlInput.trim() :
          src === 'audio'   ? (audioFile?.name ?? '') :
          src === 'pdf'     ? (pdfFile?.name ?? '') :
          src === 'image'   ? (imageFile?.name ?? '') :
          '';
        api.saveHistory({
          mode:          submittedModeRef.current,
          source:        src,
          source_detail: sourceDetail,
          result:        finalResult,
          reasoning:     finalReasoning,
        }).catch(() => {/* ignore history save errors */});
      }
    };

    const onExtracted = (extracted: string) => setSourceContent(extracted);

    // Build a cache key for extractable sources (URL-based and file-based)
    const fileCacheKey = (prefix: string, f: File) =>
      `${prefix}:${f.name}:${f.size}:${f.lastModified}`;

    // Wrap onExtracted to populate the cache after a fresh extraction
    const withCaching = (key: string, label: string, type: string, cb: typeof onExtracted) =>
      (extracted: string) => {
        sourceCache.set(key, { content: extracted, label, sourceType: type });
        cb(extracted);
      };

    // Try to serve from cache for sources that support it
    const tryFromCache = async (
      key: string,
      fallback: () => Promise<void>,
    ) => {
      const cached = sourceCache.get(key);
      if (cached) {
        onPhase('extracting', 'Using cached extraction…');
        onExtracted(cached.content);
        await api.summarize(cached.content, mode, null, onChunk, onError, onDone);
      } else {
        await fallback();
      }
    };

    switch (sourceTab) {
      case 'text':
        setSourceContent(content.trim());
        await api.summarize(content.trim(), mode, null, onChunk, onError, onDone);
        break;

      case 'audio': {
        const key = fileCacheKey('audio', audioFile!);
        await tryFromCache(key, () =>
          api.summarizeFile(audioFile!, 'audio', mode, onPhase, onChunk, onError, onDone, enhancement,
            withCaching(key, audioFile!.name, 'audio', onExtracted))
        );
        break;
      }

      case 'pdf': {
        const key = fileCacheKey('pdf', pdfFile!);
        await tryFromCache(key, () =>
          api.summarizeFile(pdfFile!, 'pdf', mode, onPhase, onChunk, onError, onDone, undefined,
            withCaching(key, pdfFile!.name, 'pdf', onExtracted))
        );
        break;
      }

      case 'youtube': {
        const key = `youtube:${youtubeUrl.trim()}`;
        await tryFromCache(key, () =>
          api.summarizeUrl(youtubeUrl.trim(), 'youtube', mode, preferCaptions, onPhase, onChunk, onError, onDone,
            withCaching(key, youtubeUrl.trim(), 'youtube', onExtracted))
        );
        break;
      }

      case 'url': {
        const key = `url:${urlInput.trim()}`;
        await tryFromCache(key, () =>
          api.summarizeUrl(urlInput.trim(), 'url', mode, false, onPhase, onChunk, onError, onDone,
            withCaching(key, urlInput.trim(), 'url', onExtracted))
        );
        break;
      }

      case 'image':
        // No onExtracted: images have no text content, chat panel stays hidden
        await api.summarizeImage(imageFile!, mode, onChunk, onError, onDone);
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

  const downloadSvg = () => {
    const svg = document.querySelector('.mindmap-svg');
    if (!svg) return;
    const modeLabel = modes.find(m => m.id === mode)?.label ?? mode;
    const slug = modeLabel.toLowerCase().replace(/\s+/g, '-');
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${slug}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadResult = (format: 'txt' | 'md' = 'txt') => {
    const modeLabel = modes.find(m => m.id === mode)?.label ?? mode;
    const slug      = modeLabel.toLowerCase().replace(/\s+/g, '-');

    let content: string;
    if (format === 'md') {
      content = `# ${modeLabel}\n\n${result}`;
      if (reasoning) {
        content += `\n\n<details>\n<summary>Reasoning</summary>\n\n${reasoning}\n</details>`;
      }
    } else {
      content = result;
    }

    const blob = new Blob([content], { type: format === 'md' ? 'text/markdown' : 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${slug}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Mode tab navigation ───────────────────────────────────────────────────

  const handleModeClick = (newMode: string) => {
    if (isRunning) return;
    const cached = modeCache[newMode];
    if (cached) {
      // Navigate to cached result for this mode
      setMode(newMode);
      setResult(cached.result);
      setReasoning(cached.reasoning);
      setView('done');
    } else {
      setMode(newMode);
      // If currently showing a result, go idle so user knows they need to run it
      if (view === 'done' || view === 'streaming') {
        setView('idle');
        setResult('');
        setReasoning('');
      }
    }
  };

  const handleSourceTabClick = (tab: SourceTab) => {
    if (isRunning) return;
    setSourceTab(tab);
    // Different source = different content, clear cached results and chat
    if (tab !== sourceTab) {
      setModeCache({});
      setView('idle');
      setResult('');
      setReasoning('');
      setSourceContent('');
      setChatMessages([]);
      setChatNotices([]);
    }
  };

  // ── Chat submit ───────────────────────────────────────────────────────────

  const handleChatSubmit = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || isChatStreaming || !sourceContent) return;

    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    const historyToSend = [...chatMessages, userMsg];

    setChatMessages([...historyToSend, { role: 'assistant', content: '' }]);
    setChatInput('');
    setIsChatStreaming(true);
    chatAccumRef.current = '';

    await api.chat(
      sourceContent,
      historyToSend,
      (chunk) => {
        chatAccumRef.current += chunk;
        setChatMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: chatAccumRef.current };
          return updated;
        });
      },
      (notice) => setChatNotices(prev => [...prev, notice]),
      (err) => {
        setChatMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: `Error: ${err}` };
          return updated;
        });
        setIsChatStreaming(false);
      },
      () => setIsChatStreaming(false),
    );
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
              onClick={() => handleSourceTabClick(tab.id)}
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

        {sourceTab === 'image' && (
          <>
            <DropZone
              accept=".jpg,.jpeg,.png,.webp,.gif"
              file={imageFile}
              onFile={setImageFile}
              label="Drop an image here, or click to browse"
              hint="JPG, PNG, WebP, GIF — requires a vision-capable model"
              icon={ImageIcon}
              disabled={isRunning}
            />
          </>
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
            {modes.map(m => {
              const hasCached = Boolean(modeCache[m.id]);
              return (
                <button
                  key={m.id}
                  className={[
                    'summarize-mode-btn',
                    mode === m.id   ? 'active'      : '',
                    hasCached       ? 'has-result'  : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleModeClick(m.id)}
                  disabled={isRunning}
                  title={hasCached ? `${m.label} — click to view result` : m.hint}
                >
                  {m.label}
                  {hasCached && <span className="summarize-mode-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          <button
            className="summarize-submit-btn"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            <Sparkles size={15} aria-hidden="true" />
            {isRunning ? 'Processing…' : modeCache[mode] ? 'Re-run' : mode === 'transcript' ? 'Transcribe' : 'Summarize'}
          </button>
        </div>

        {/* Results */}
        {view !== 'idle' && (
          <div className="summarize-result">

            {/* Result header */}
            <div className="summarize-result-header">
              <h2 className="summarize-result-title">
                {modes.find(m => m.id === mode)?.label ?? 'Result'}
              </h2>
              {view === 'done' && (
                <div className="summarize-result-actions">
                  {mode !== 'mind_map' && (
                    <button
                      className={`summarize-action-btn${renderMarkdown ? ' active' : ''}`}
                      onClick={() => setRenderMarkdown(r => !r)}
                      title={renderMarkdown ? 'Show raw text' : 'Render as markdown'}
                      aria-pressed={renderMarkdown}
                    >
                      <Code size={14} aria-hidden="true" />
                      {renderMarkdown ? 'Raw' : 'Markdown'}
                    </button>
                  )}
                  {mode === 'mind_map' && (
                    <button
                      className={`summarize-action-btn${renderMarkdown ? ' active' : ''}`}
                      onClick={() => setRenderMarkdown(r => !r)}
                      title={renderMarkdown ? 'Show diagram' : 'Show raw markdown'}
                      aria-pressed={renderMarkdown}
                    >
                      <Code size={14} aria-hidden="true" />
                      {renderMarkdown ? 'Diagram' : 'Raw'}
                    </button>
                  )}
                  <button
                    className={`summarize-action-btn${isCopied ? ' copied' : ''}`}
                    onClick={copyResult}
                  >
                    <Copy size={14} aria-hidden="true" />
                    {isCopied ? 'Copied!' : 'Copy'}
                  </button>
                  {mode === 'mind_map' && !renderMarkdown && (
                    <button className="summarize-action-btn" onClick={downloadSvg}>
                      <Download size={14} aria-hidden="true" />
                      .svg
                    </button>
                  )}
                  {mode !== 'mind_map' && (
                    <>
                      <button className="summarize-action-btn" onClick={() => downloadResult('txt')}>
                        <Download size={14} aria-hidden="true" />
                        .txt
                      </button>
                      <button className="summarize-action-btn" onClick={() => downloadResult('md')}>
                        <Download size={14} aria-hidden="true" />
                        .md
                      </button>
                    </>
                  )}
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
              mode === 'mind_map' && view === 'done' && !renderMarkdown ? (
                <MindMapDiagram markdown={result} />
              ) : (
                <div
                  className={[
                    'summarize-output',
                    view === 'streaming' ? 'streaming' : '',
                    renderMarkdown && view === 'done' ? 'markdown' : '',
                  ].filter(Boolean).join(' ')}
                  aria-live={view === 'done' ? 'polite' : 'off'}
                  aria-busy={view === 'streaming'}
                  aria-label="Summary result"
                >
                  {renderMarkdown && view === 'done'
                    ? <ReactMarkdown>{result}</ReactMarkdown>
                    : <>{result}{view === 'streaming' && <span className="summarize-cursor" aria-hidden="true" />}</>
                  }
                </div>
              )
            )}

            {/* Reasoning panel — shown after result is complete */}
            {view === 'done' && reasoning && (
              <details className="summarize-reasoning">
                <summary className="summarize-reasoning-summary">
                  Reasoning
                  <span className="summarize-reasoning-lines">
                    {reasoning.split('\n').filter(Boolean).length} lines
                  </span>
                </summary>
                <pre className="summarize-reasoning-body">{reasoning}</pre>
              </details>
            )}

            {/* Translation panel — available once result is complete */}
            {view === 'done' && result && (
              <div className="summarize-translate-panel">
                <div className="summarize-translate-controls">
                  <Languages size={14} className="summarize-translate-icon" aria-hidden="true" />
                  <select
                    className="summarize-translate-select"
                    value={translateLang}
                    onChange={e => { setTranslateLang(e.target.value); setTranslation(''); setTranslateState('idle'); }}
                    aria-label="Target language"
                  >
                    {['Spanish','French','German','Portuguese','Italian','Chinese','Japanese','Korean','Russian','Arabic','Hindi','Dutch','Swedish','Polish','Turkish'].map(lang => (
                      <option key={lang} value={lang}>{lang}</option>
                    ))}
                  </select>
                  <button
                    className="summarize-action-btn"
                    onClick={runTranslation}
                    disabled={translateState === 'streaming'}
                  >
                    {translateState === 'streaming' ? 'Translating…' : translateState === 'done' ? 'Re-translate' : 'Translate'}
                  </button>
                </div>
                {translateState === 'error' && (
                  <p className="summarize-translate-error">{translateError}</p>
                )}
                {(translateState === 'streaming' || translateState === 'done') && translation && (
                  <div className="summarize-translate-result">
                    {translation}
                    {translateState === 'streaming' && <span className="summarize-cursor" aria-hidden="true" />}
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {/* Chat section — available once source content is set */}
        {sourceContent && (
          <div className="summarize-chat-section">
            <button
              className={`summarize-chat-toggle${isChatOpen ? ' active' : ''}`}
              onClick={() => setIsChatOpen(v => !v)}
            >
              <MessageSquare size={14} aria-hidden="true" />
              {isChatOpen ? 'Hide chat' : 'Chat about this'}
            </button>

            {isChatOpen && (
              <div className="summarize-chat-panel">
                {/* Context notices (compression / truncation) */}
                {chatNotices.length > 0 && (
                  <div className="summarize-chat-notices">
                    {chatNotices.map((n, i) => (
                      <div key={i} className="summarize-chat-notice">{n}</div>
                    ))}
                  </div>
                )}

                {/* Message list */}
                <div className="summarize-chat-messages">
                  {chatMessages.length === 0 && (
                    <div className="summarize-chat-empty">
                      Ask a question about the content…
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div
                      key={i}
                      className={`summarize-chat-msg summarize-chat-msg--${msg.role}`}
                    >
                      <div className="summarize-chat-msg-role">
                        {msg.role === 'user' ? 'You' : 'AI'}
                      </div>
                      <div className="summarize-chat-msg-content">
                        {msg.content || (
                          <span className="summarize-thinking-dot-row">
                            <span className="summarize-thinking-dot" />
                            <span className="summarize-thinking-dot" />
                            <span className="summarize-thinking-dot" />
                          </span>
                        )}
                        {i === chatMessages.length - 1 &&
                         msg.role === 'assistant' &&
                         isChatStreaming &&
                         msg.content && (
                          <span className="summarize-cursor" aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>

                {/* Input row */}
                <div className="summarize-chat-input-row">
                  <textarea
                    className="summarize-chat-input"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey && !isChatStreaming) {
                        e.preventDefault();
                        handleChatSubmit();
                      }
                    }}
                    placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
                    rows={2}
                    disabled={isChatStreaming}
                    aria-label="Chat input"
                  />
                  <button
                    className="summarize-chat-send"
                    onClick={handleChatSubmit}
                    disabled={!chatInput.trim() || isChatStreaming}
                    aria-label="Send message"
                  >
                    <Send size={15} aria-hidden="true" />
                  </button>
                </div>

                {/* Clear history */}
                {chatMessages.length > 0 && (
                  <button
                    className="summarize-chat-clear"
                    onClick={() => { setChatMessages([]); setChatNotices([]); }}
                    disabled={isChatStreaming}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    Clear history
                  </button>
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
