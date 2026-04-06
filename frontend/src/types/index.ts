export type JobStatus = 'pending' | 'enhancing' | 'processing' | 'done' | 'error';

export interface Job {
  status: JobStatus;
  status_detail: string;
  result: string | null;
  error: string | null;
  filename: string | null;
  audio_path: string;
}

export interface AppInfo {
  status: string;
  engine: string;
  model: string | null;
  gpu_available: boolean;
  gpu_name: string | null;
}

export interface FileMeta {
  job_id: string;
  filename: string | null;
  audio_file: string;
  size: number;
  uploaded_at: string;
}

export interface Settings {
  app_name: string;
  // Transcription
  transcription_engine: string;
  whisper_model_size: string;
  compute_type: string;
  language: string;
  // Application
  max_upload_size_mb: string;
  audio_cache_ttl_hours: string;
  // Security
  auth_enabled: string;
  auth_username: string;
  auth_password: string;
  // Ollama
  ollama_url: string;
  ollama_model: string;
  ollama_timeout: string;
  ollama_thinking_enabled: string;
  ollama_token_budget: string;
  // Enhancement defaults
  enhance_normalize: string;
  enhance_denoise: string;
  enhance_isolate: string;
  enhance_upsample: string;
}

export interface EngineCapability {
  available: boolean;
  reason: string | null;
}

export interface Capabilities {
  gpu: boolean;
  engines: Record<string, EngineCapability>;
}

export interface OllamaModel {
  name: string;
  size: number;
  parameter_size: string;
}

export interface EnhancementOptions {
  normalize: boolean;
  denoise:   boolean;
  isolate:   boolean;
  upsample:  boolean;
}

export interface ModelStatus {
  package: boolean;
  weights: boolean;
}

export type AudioModelMap = Record<string, ModelStatus>;

export interface SettingsUpdateResponse {
  settings: Settings;
  restart_required: boolean;
}
