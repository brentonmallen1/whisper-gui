import { AlertTriangle } from 'lucide-react';
import type { AudioModelMap, EnhancementOptions } from '../types';
import './EnhancementPanel.css';

export type { EnhancementOptions, AudioModelMap };

export const DEFAULT_ENHANCEMENT: EnhancementOptions = {
  normalize: false,
  denoise:   false,
  isolate:   false,
  upsample:  false,
};

// ── Stage definitions ──────────────────────────────────────────────────────

const STAGES: {
  key: keyof EnhancementOptions;
  label: string;
  hint: string;
  modelKey?: string;  // key in AudioModelMap — undefined means no model needed (ffmpeg)
}[] = [
  {
    key:      'normalize',
    label:    'Normalize',
    hint:     'EBU R128 loudness normalization via ffmpeg',
    modelKey: undefined,
  },
  {
    key:      'denoise',
    label:    'Denoise',
    hint:     'Noise reduction via DeepFilterNet',
    modelKey: 'deepfilternet',
  },
  {
    key:      'isolate',
    label:    'Isolate vocals',
    hint:     'Vocal isolation via Demucs (htdemucs)',
    modelKey: 'demucs',
  },
  {
    key:      'upsample',
    label:    'Upsample',
    hint:     'Audio super-resolution to 48kHz via LavaSR',
    modelKey: 'lavasr',
  },
];

// ── Component ──────────────────────────────────────────────────────────────

interface EnhancementPanelProps {
  value:    EnhancementOptions;
  onChange: (opts: EnhancementOptions) => void;
  models?:  AudioModelMap;   // from GET /api/audio/models — optional, shows warnings if provided
  disabled?: boolean;
}

export default function EnhancementPanel({
  value,
  onChange,
  models,
  disabled,
}: EnhancementPanelProps) {
  const toggle = (key: keyof EnhancementOptions) => {
    if (disabled) return;
    onChange({ ...value, [key]: !value[key] });
  };

  const anyActive = Object.values(value).some(Boolean);

  return (
    <div className={`enhance-panel${disabled ? ' disabled' : ''}`}>
      <p className="enhance-panel-label">Audio enhancement</p>
      <div className="enhance-stages">
        {STAGES.map(stage => {
          const active  = value[stage.key];
          const status  = stage.modelKey ? models?.[stage.modelKey] : undefined;
          const missing = status !== undefined && !status.package;
          const noWeights = status !== undefined && status.package && !status.weights;

          return (
            <button
              key={stage.key}
              type="button"
              className={[
                'enhance-chip',
                active   ? 'active'   : '',
                missing  ? 'missing'  : '',
                disabled ? 'disabled' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => toggle(stage.key)}
              disabled={disabled || missing}
              title={missing ? `${stage.hint} — package not installed` : stage.hint}
              aria-pressed={active}
            >
              {stage.label}
              {noWeights && active && (
                <span className="enhance-chip-warn" title="Model weights not downloaded — will download on first use">
                  <AlertTriangle size={11} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {anyActive && (
        <p className="enhance-panel-note">
          Applied before transcription. Processing time increases with each stage.
        </p>
      )}
    </div>
  );
}
