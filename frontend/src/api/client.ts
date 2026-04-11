import type { AppInfo, AudioModelMap, Capabilities, ChatMessage, EnhancementOptions, Feed, FeedEntry, FileMeta, HistoryEntry, Job, OllamaModel, PipelineSession, Prompt, Settings, SettingsUpdateResponse, YouTubeDownloadJob, YouTubeVideoInfo } from '../types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export function getInfo(): Promise<AppInfo> {
  return request<AppInfo>('/api/info');
}

export function getCapabilities(): Promise<Capabilities> {
  return request<Capabilities>('/api/capabilities');
}

export function getReady(): Promise<{ status: string; message: string }> {
  return request('/api/ready');
}

// ── Transcription ──────────────────────────────────────────────────────────

export function uploadFile(file: File, enhancement?: Partial<EnhancementOptions>): Promise<{ job_id: string }> {
  const form = new FormData();
  form.append('file', file);
  if (enhancement) {
    form.append('enhance_normalize', String(enhancement.normalize ?? false));
    form.append('enhance_denoise',   String(enhancement.denoise   ?? false));
    form.append('enhance_isolate',   String(enhancement.isolate   ?? false));
    form.append('enhance_upsample',  String(enhancement.upsample  ?? false));
  }
  return request('/api/transcribe', { method: 'POST', body: form });
}

export function getStatus(jobId: string): Promise<Job> {
  return request<Job>(`/api/status/${jobId}`);
}

export function getAudioUrl(jobId: string): string {
  return `/api/audio/${jobId}`;
}

export function getExportUrl(jobId: string): string {
  return `/api/export/${jobId}`;
}

export function getSrtExportUrl(jobId: string): string {
  return `/api/export/${jobId}/srt`;
}

export function getVttExportUrl(jobId: string): string {
  return `/api/export/${jobId}/vtt`;
}

export function getFiles(): Promise<FileMeta[]> {
  return request<FileMeta[]>('/api/files');
}

export function retranscribe(jobId: string, enhancement?: Partial<EnhancementOptions>): Promise<{ job_id: string }> {
  return request(`/api/retranscribe/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enhance_normalize: enhancement?.normalize ?? false,
      enhance_denoise:   enhancement?.denoise   ?? false,
      enhance_isolate:   enhancement?.isolate   ?? false,
      enhance_upsample:  enhancement?.upsample  ?? false,
    }),
  });
}

// ── Audio Enhancement ──────────────────────────────────────────────────────

export function enhanceFile(file: File, enhancement: Partial<EnhancementOptions>): Promise<{ job_id: string }> {
  const form = new FormData();
  form.append('file', file);
  form.append('enhance_normalize', String(enhancement.normalize ?? false));
  form.append('enhance_denoise',   String(enhancement.denoise   ?? false));
  form.append('enhance_isolate',   String(enhancement.isolate   ?? false));
  form.append('enhance_upsample',  String(enhancement.upsample  ?? false));
  return request('/api/enhance', { method: 'POST', body: form });
}

export function getEnhancedAudioUrl(jobId: string): string {
  return `/api/enhance/${jobId}/download`;
}

export function getOriginalAudioUrl(jobId: string): string {
  return `/api/enhance/${jobId}/original`;
}

export function reenhance(jobId: string, enhancement: Partial<EnhancementOptions>): Promise<{ job_id: string }> {
  return request(`/api/reenhance/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enhance_normalize: enhancement.normalize ?? false,
      enhance_denoise:   enhancement.denoise   ?? false,
      enhance_isolate:   enhancement.isolate   ?? false,
      enhance_upsample:  enhancement.upsample  ?? false,
    }),
  });
}

// ── Settings ───────────────────────────────────────────────────────────────

export function getSettings(): Promise<Settings> {
  return request<Settings>('/api/settings');
}

export function updateSettings(updates: Partial<Settings>): Promise<SettingsUpdateResponse> {
  return request<SettingsUpdateResponse>('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export function reloadEngine(): Promise<{ status: string }> {
  return request('/api/reload-engine', { method: 'POST' });
}

// ── Ollama ─────────────────────────────────────────────────────────────────

export function testOllamaConnection(): Promise<{ ok: boolean; message: string }> {
  return request('/api/ollama/test');
}

export function getOllamaModels(): Promise<{ models: OllamaModel[] }> {
  return request('/api/ollama/models');
}

// ── Prompts ────────────────────────────────────────────────────────────────

export function getPrompts(): Promise<Prompt[]> {
  return request<Prompt[]>('/api/prompts');
}

export function createPrompt(data: {
  name: string;
  mode: string;
  system_prompt: string;
  template: string;
}): Promise<Prompt> {
  return request<Prompt>('/api/prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function updatePrompt(id: string, data: {
  name: string;
  system_prompt: string;
  template: string;
}): Promise<Prompt> {
  return request<Prompt>(`/api/prompts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function deletePrompt(id: string): Promise<void> {
  return request(`/api/prompts/${id}`, { method: 'DELETE' });
}

export function resetPrompts(): Promise<{ ok: boolean }> {
  return request('/api/prompts/reset', { method: 'POST' });
}

// ── History ────────────────────────────────────────────────────────────────

// ── RSS/Podcast feeds ──────────────────────────────────────────────────────

export function getFeedsStatus(): Promise<{ available: boolean; reason: string }> {
  return request('/api/feeds/status');
}

export function getFeeds(): Promise<Feed[]> {
  return request<Feed[]>('/api/feeds');
}

export function createFeed(data: {
  url: string;
  check_interval?: number;
  auto_summarize?: boolean;
  summarize_mode?: string;
}): Promise<Feed> {
  return request<Feed>('/api/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function deleteFeed(feedId: string): Promise<void> {
  return request(`/api/feeds/${feedId}`, { method: 'DELETE' });
}

export function getFeedEntries(feedId: string): Promise<FeedEntry[]> {
  return request<FeedEntry[]>(`/api/feeds/${feedId}/entries`);
}

export function checkFeedNow(feedId: string): Promise<{ status: string }> {
  return request(`/api/feeds/${feedId}/check`, { method: 'POST' });
}

// ── Speaker diarization ────────────────────────────────────────────────────

export function getDiarizeStatus(): Promise<{ available: boolean; reason: string; token_configured: boolean }> {
  return request('/api/diarize/status');
}

export function diarizeJob(jobId: string): Promise<{ segments: import('../types').Segment[]; diarization: { speaker: string; start: number; end: number }[] }> {
  return request(`/api/diarize/${jobId}`, { method: 'POST' });
}

// ── Clip extraction ────────────────────────────────────────────────────────

export function extractClip(
  jobId: string,
  start: number,
  end: number,
  format: 'mp3' | 'wav' | 'm4a' | 'flac' = 'mp3',
): Promise<{ clip_id: string; filename: string; job_id: string }> {
  return request(`/api/clip/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start, end, format }),
  });
}

export function getClipDownloadUrl(jobId: string, clipId: string): string {
  return `/api/clip/${jobId}/${clipId}/download`;
}

// ── Translation ────────────────────────────────────────────────────────────

export async function translateStream(
  text: string,
  targetLanguage: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): Promise<void> {
  const res = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language: targetLanguage }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') { onDone(); return; }
      try {
        const ev = JSON.parse(payload);
        if (ev.text) onChunk(ev.text);
        else if (ev.error) { onError(ev.error); return; }
      } catch { /* ignore malformed */ }
    }
  }
  onDone();
}

// ── History ────────────────────────────────────────────────────────────────

export function getHistory(): Promise<HistoryEntry[]> {
  return request<HistoryEntry[]>('/api/history');
}

export function searchHistory(q: string): Promise<(HistoryEntry & { snippet?: string })[]> {
  return request(`/api/history/search?q=${encodeURIComponent(q)}`);
}

export function saveHistory(data: {
  mode: string;
  source: string;
  source_detail?: string;
  result: string;
  reasoning?: string;
}): Promise<HistoryEntry> {
  return request<HistoryEntry>('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function deleteHistoryEntry(id: string): Promise<void> {
  return request(`/api/history/${id}`, { method: 'DELETE' });
}

export function clearHistory(): Promise<void> {
  return request('/api/history', { method: 'DELETE' });
}

// ── YouTube Download ───────────────────────────────────────────────────────

export function getYouTubeInfo(url: string): Promise<YouTubeVideoInfo> {
  return request<YouTubeVideoInfo>(`/api/youtube/info?url=${encodeURIComponent(url)}`);
}

export function startYouTubeDownload(opts: {
  url:           string;
  mode:          'video' | 'audio';
  video_quality?: string;
  video_format?:  string;
  audio_format?:  string;
  audio_quality?: string;
}): Promise<{ job_id: string }> {
  return request('/api/youtube/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function getYouTubeJobStatus(jobId: string): Promise<YouTubeDownloadJob> {
  return request<YouTubeDownloadJob>(`/api/youtube/${jobId}`);
}

export function getYouTubeFileUrl(jobId: string): string {
  return `/api/youtube/${jobId}/file`;
}

// ── Interactive Audio Pipeline ─────────────────────────────────────────────

export function createPipeline(file: File): Promise<{ session_id: string; filename: string | null }> {
  const form = new FormData();
  form.append('file', file);
  return request('/api/pipeline', { method: 'POST', body: form });
}

export function getPipelineSession(sessionId: string): Promise<PipelineSession> {
  return request<PipelineSession>(`/api/pipeline/${sessionId}`);
}

export function applyPipelineStep(sessionId: string, step: string): Promise<{ status: string; step: string }> {
  return request(`/api/pipeline/${sessionId}/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step }),
  });
}

export function undoPipelineStep(sessionId: string): Promise<{ status: string; steps_remaining: number }> {
  return request(`/api/pipeline/${sessionId}/step`, { method: 'DELETE' });
}

export function transcribePipeline(sessionId: string): Promise<{ job_id: string }> {
  return request(`/api/pipeline/${sessionId}/transcribe`, { method: 'POST' });
}

export function getPipelineAudioUrl(sessionId: string, step: string = 'current'): string {
  return `/api/pipeline/${sessionId}/audio?step=${encodeURIComponent(step)}`;
}

export function getPipelineDownloadUrl(sessionId: string): string {
  return `/api/pipeline/${sessionId}/download`;
}

export function deletePipeline(sessionId: string): Promise<{ status: string }> {
  return request(`/api/pipeline/${sessionId}`, { method: 'DELETE' });
}

// ── Audio models ───────────────────────────────────────────────────────────

export function getAudioModels(): Promise<AudioModelMap> {
  return request<AudioModelMap>('/api/audio/models');
}

/**
 * Download one or more audio enhancement models.
 * Streams SSE events:
 *   {"model": "deepfilternet", "status": "downloading"|"done"|"error", "message": "..."}
 *   [DONE]
 */
export async function downloadAudioModels(
  models: string[],
  onProgress: (model: string, status: string, message: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/audio/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models }),
    });
  } catch {
    onError('Network error — is the API server running?');
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }

  const reader  = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') { onDone(); return; }
        try {
          const ev = JSON.parse(payload);
          if (ev.error)  { onError(ev.error); return; }
          if (ev.model)  { onProgress(ev.model, ev.status ?? '', ev.message ?? ''); }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  onDone();
}

// ── Shared SSE consumer ────────────────────────────────────────────────────

/**
 * Read a streaming SSE response and dispatch events to the provided handlers.
 *
 * Event shapes emitted by the backend:
 *   {"phase": "extracting"|"transcribing", "detail": "..."}  — extraction progress
 *   {"extracted_content": "..."}                              — full source text after extraction
 *   {"text": "...chunk..."}                                    — LLM output chunk
 *   {"error": "...message..."}                                — terminal error
 *   [DONE]                                                    — end of stream
 */
async function consumeSSE(
  res: Response,
  onPhase: (phase: string, detail: string) => void,
  onChunk: (text: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
  onExtracted?: (content: string) => void,
): Promise<void> {
  const reader  = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') { onDone(); return; }
        try {
          const ev = JSON.parse(payload);
          if (ev.error)             { onError(ev.error); return; }
          if (ev.phase)             { onPhase(ev.phase, ev.detail ?? ''); continue; }
          if (ev.extracted_content) { onExtracted?.(ev.extracted_content); continue; }
          if (ev.text)              { onChunk(ev.text); }
        } catch { /* partial / malformed line — skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  onDone();
}

// ── Summarize ──────────────────────────────────────────────────────────────

/**
 * Stream a summarization of plain text via SSE.
 * The text endpoint has no extraction phase, so onPhase will not fire.
 */
export async function summarize(
  content: string,
  mode: string,
  model: string | null,
  onChunk: (text: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, mode, model }),
    });
  } catch {
    onError('Network error — is the API server running?');
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }
  await consumeSSE(res, () => {}, onChunk, onError, onDone);
}

/**
 * Upload a file (audio/video/PDF) and stream extraction + summarization.
 * onPhase fires with (phase, detail) as backend progresses through extraction.
 */
export async function summarizeFile(
  file: File,
  source: 'audio' | 'pdf',
  mode: string,
  onPhase: (phase: string, detail: string) => void,
  onChunk: (text: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
  enhancement?: Partial<EnhancementOptions>,
  onExtracted?: (content: string) => void,
): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  form.append('source', source);
  form.append('mode', mode);
  if (enhancement && source === 'audio') {
    form.append('enhance_normalize', String(enhancement.normalize ?? false));
    form.append('enhance_denoise',   String(enhancement.denoise   ?? false));
    form.append('enhance_isolate',   String(enhancement.isolate   ?? false));
    form.append('enhance_upsample',  String(enhancement.upsample  ?? false));
  }

  let res: Response;
  try {
    res = await fetch('/api/summarize/file', { method: 'POST', body: form });
  } catch {
    onError('Network error — is the API server running?');
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }
  await consumeSSE(res, onPhase, onChunk, onError, onDone, onExtracted);
}

/**
 * Upload an image file and stream a vision-LLM summary via SSE.
 * Requires a vision-capable model selected in Settings → Ollama.
 * No extraction phases (image bytes go directly to the LLM).
 */
export async function summarizeImage(
  file: File,
  mode: string,
  onChunk: (text: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  form.append('mode', mode);

  let res: Response;
  try {
    res = await fetch('/api/summarize/image', { method: 'POST', body: form });
  } catch {
    onError('Network error — is the API server running?');
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }
  await consumeSSE(res, () => {}, onChunk, onError, onDone);
}

/**
 * Fetch a URL (YouTube or webpage) and stream extraction + summarization.
 * onPhase fires with (phase, detail) as backend progresses through extraction.
 */
export async function summarizeUrl(
  url: string,
  source: 'youtube' | 'url',
  mode: string,
  preferCaptions: boolean,
  onPhase: (phase: string, detail: string) => void,
  onChunk: (text: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
  onExtracted?: (content: string) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/summarize/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, url, mode, prefer_captions: preferCaptions }),
    });
  } catch {
    onError('Network error — is the API server running?');
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }
  await consumeSSE(res, onPhase, onChunk, onError, onDone, onExtracted);
}

// ── Chat ───────────────────────────────────────────────────────────────────

/**
 * Multi-turn streaming chat about a source document.
 *
 * Events:
 *   onChunk  — each text token from the model
 *   onNotice — informational notice (context compression, source truncation)
 *   onError  — terminal error
 *   onDone   — stream complete
 */
export async function chat(
  content: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  onNotice: (notice: string) => void,
  onError: (message: string) => void,
  onDone: () => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, messages }),
    });
  } catch {
    onError('Network error — is the API server running?');
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    onError(body.detail ?? res.statusText);
    return;
  }

  const reader  = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') { onDone(); return; }
        try {
          const ev = JSON.parse(payload);
          if (ev.error)  { onError(ev.error); return; }
          if (ev.notice) { onNotice(ev.notice); continue; }
          if (ev.text)   { onChunk(ev.text); }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  onDone();
}
