"""
SQLite-backed settings store.

All runtime configuration lives here. Environment variables act as initial
seeds (via INSERT OR IGNORE) on first run — once seeded, the DB is the
source of truth and env vars are ignored.
"""

import os
import sqlite3
from pathlib import Path
from threading import Lock

# DB lives in a data directory that can be volume-mounted in Docker.
# Docker sets DATA_DIR=/data via docker-compose; local dev defaults to backend/data/.
_DATA_DIR = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
_DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = _DATA_DIR / "app.db"

_lock = Lock()

# Defaults seeded on first run. Env vars override these initial values.
_DEFAULTS: dict[str, str] = {
    "app_name":               os.getenv("APP_NAME", "Distill"),
    # Transcription
    "transcription_engine":   os.getenv("TRANSCRIPTION_ENGINE", "faster-whisper"),
    "whisper_model_size":     os.getenv("WHISPER_MODEL_SIZE", "large-v3-turbo"),
    "compute_type":           os.getenv("COMPUTE_TYPE", "int8"),
    "language":               os.getenv("LANGUAGE", ""),
    # Application
    "max_upload_size_mb":     os.getenv("MAX_UPLOAD_SIZE_MB", "500"),
    "audio_cache_ttl_hours":  os.getenv("AUDIO_CACHE_TTL_HOURS", "72"),
    # Security
    "auth_enabled":           os.getenv("AUTH_ENABLED", "false"),
    "auth_username":          os.getenv("AUTH_USERNAME", "admin"),
    "auth_password":          os.getenv("AUTH_PASSWORD", ""),
    # Ollama
    "ollama_url":              os.getenv("OLLAMA_URL", "http://localhost:11434"),
    "ollama_model":            os.getenv("OLLAMA_MODEL", ""),
    "ollama_timeout":          os.getenv("OLLAMA_TIMEOUT", "120"),
    "ollama_thinking_enabled": os.getenv("OLLAMA_THINKING_ENABLED", "true"),
    "ollama_token_budget":     os.getenv("OLLAMA_TOKEN_BUDGET", "280"),
    # Audio enhancement defaults (per-job UI pre-populates from these)
    "enhance_normalize": os.getenv("ENHANCE_NORMALIZE", "false"),
    "enhance_denoise":   os.getenv("ENHANCE_DENOISE",   "false"),
    "enhance_isolate":   os.getenv("ENHANCE_ISOLATE",   "false"),
    "enhance_upsample":  os.getenv("ENHANCE_UPSAMPLE",  "false"),
}


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Create tables and seed defaults. Safe to call on every startup."""
    with _lock:
        conn = _connect()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS prompts (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                mode          TEXT NOT NULL,
                system_prompt TEXT,
                template      TEXT NOT NULL,
                variables     TEXT DEFAULT '[]',
                is_default    INTEGER DEFAULT 0,
                created_at    TEXT DEFAULT (datetime('now')),
                updated_at    TEXT DEFAULT (datetime('now'))
            );
        """)
        for key, value in _DEFAULTS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )
        conn.commit()
        conn.close()


def get_all_settings() -> dict[str, str]:
    with _lock:
        conn = _connect()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        conn.close()
    return {row["key"]: row["value"] for row in rows}


def get_setting(key: str, default: str = "") -> str:
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        conn.close()
    return row["value"] if row else default


def update_settings(updates: dict[str, str]) -> dict[str, str]:
    """Persist a dict of key/value updates and return the full settings dict."""
    with _lock:
        conn = _connect()
        for key, value in updates.items():
            conn.execute(
                """INSERT OR REPLACE INTO settings (key, value, updated_at)
                   VALUES (?, ?, datetime('now'))""",
                (key, str(value)),
            )
        conn.commit()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        conn.close()
    return {row["key"]: row["value"] for row in rows}
