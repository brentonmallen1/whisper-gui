import type { AppInfo, AudioModelMap, Capabilities, EnhancementOptions, FileMeta, Job, OllamaModel, Settings, SettingsUpdateResponse } from '../types';

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
          if (ev.error)  { onError(ev.error); return; }
          if (ev.phase)  { onPhase(ev.phase, ev.detail ?? ''); continue; }
          if (ev.text)   { onChunk(ev.text); }
        } catch { /* partial / malformed line — skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  onDone();
}

// ── Summarize ─────────────────────────────────────────────────────────────

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
  await consumeSSE(res, onPhase, onChunk, onError, onDone);
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
  await consumeSSE(res, onPhase, onChunk, onError, onDone);
}
