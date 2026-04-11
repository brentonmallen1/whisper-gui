"""
SQLite-backed settings and prompt store.

All runtime configuration lives here. Environment variables act as initial
seeds (via INSERT OR IGNORE) on first run — once seeded, the DB is the
source of truth and env vars are ignored.
"""

import json
import os
import sqlite3
import uuid
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
    "app_name":               os.getenv("APP_NAME", "Lumina"),
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
    "api_key":                os.getenv("API_KEY", ""),
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
    # External integrations
    "hf_token":          os.getenv("HF_TOKEN", ""),
    # Text-to-Speech
    "tts_enabled":       os.getenv("TTS_ENABLED", "true"),
    "tts_voice":         os.getenv("TTS_VOICE", "af_bella"),
    # YouTube
    "youtube_cookies":   os.getenv("YOUTUBE_COOKIES", ""),
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

            CREATE TABLE IF NOT EXISTS history (
                id             TEXT PRIMARY KEY,
                mode           TEXT NOT NULL,
                source         TEXT NOT NULL,
                source_detail  TEXT DEFAULT '',
                result         TEXT NOT NULL,
                reasoning      TEXT DEFAULT '',
                created_at     TEXT DEFAULT (datetime('now'))
            );
        """)
        # Migrate: add source_detail column if it doesn't exist (existing DBs)
        existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(history)")}
        if "source_detail" not in existing_cols:
            conn.execute("ALTER TABLE history ADD COLUMN source_detail TEXT DEFAULT ''")

        for key, value in _DEFAULTS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )
        # RSS/Podcast feed monitoring tables
        conn.execute("""
            CREATE TABLE IF NOT EXISTS feeds (
                id               TEXT PRIMARY KEY,
                url              TEXT NOT NULL UNIQUE,
                title            TEXT,
                last_checked     TEXT,
                last_entry_id    TEXT,
                check_interval   INTEGER DEFAULT 3600,
                auto_summarize   INTEGER DEFAULT 1,
                summarize_mode   TEXT DEFAULT 'summary',
                created_at       TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS feed_entries (
                id          TEXT PRIMARY KEY,
                feed_id     TEXT NOT NULL,
                entry_id    TEXT NOT NULL,
                title       TEXT,
                audio_url   TEXT,
                published   TEXT,
                status      TEXT DEFAULT 'pending',
                job_id      TEXT,
                created_at  TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (feed_id) REFERENCES feeds(id)
            )
        """)
        # FTS5 full-text search index for history
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
                result,
                reasoning,
                content='history',
                content_rowid='rowid'
            )
        """)
        # Triggers to keep FTS index in sync with history table
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
                INSERT INTO history_fts(rowid, result, reasoning)
                VALUES (NEW.rowid, NEW.result, NEW.reasoning);
            END
        """)
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
                INSERT INTO history_fts(history_fts, rowid, result, reasoning)
                VALUES ('delete', OLD.rowid, OLD.result, OLD.reasoning);
            END
        """)
        conn.execute("""
            CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE ON history BEGIN
                INSERT INTO history_fts(history_fts, rowid, result, reasoning)
                VALUES ('delete', OLD.rowid, OLD.result, OLD.reasoning);
                INSERT INTO history_fts(rowid, result, reasoning)
                VALUES (NEW.rowid, NEW.result, NEW.reasoning);
            END
        """)
        conn.commit()
        conn.close()
    seed_default_prompts()
    _rebuild_fts_if_empty()


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


# ── Prompt CRUD ────────────────────────────────────────────────────────────────

def _row_to_prompt(row: sqlite3.Row) -> dict:
    return {
        "id":            row["id"],
        "name":          row["name"],
        "mode":          row["mode"],
        "system_prompt": row["system_prompt"] or "",
        "template":      row["template"],
        "is_default":    bool(row["is_default"]),
        "created_at":    row["created_at"],
        "updated_at":    row["updated_at"],
    }


def get_all_prompts() -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM prompts ORDER BY is_default DESC, name ASC"
        ).fetchall()
        conn.close()
    return [_row_to_prompt(r) for r in rows]


def get_prompt_by_id(prompt_id: str) -> dict | None:
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,)).fetchone()
        conn.close()
    return _row_to_prompt(row) if row else None


def get_prompt_by_mode(mode: str) -> dict | None:
    """Return the active prompt for a mode — custom takes priority over default."""
    with _lock:
        conn = _connect()
        # Custom (non-default) first, then default
        row = conn.execute(
            "SELECT * FROM prompts WHERE mode = ? ORDER BY is_default ASC LIMIT 1",
            (mode,),
        ).fetchone()
        conn.close()
    return _row_to_prompt(row) if row else None


def create_prompt(name: str, mode: str, system_prompt: str, template: str) -> dict:
    prompt_id = str(uuid.uuid4())
    with _lock:
        conn = _connect()
        conn.execute(
            """INSERT INTO prompts (id, name, mode, system_prompt, template, is_default)
               VALUES (?, ?, ?, ?, ?, 0)""",
            (prompt_id, name, mode, system_prompt, template),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,)).fetchone()
        conn.close()
    return _row_to_prompt(row)


def update_prompt(prompt_id: str, name: str, system_prompt: str, template: str) -> dict | None:
    with _lock:
        conn = _connect()
        conn.execute(
            """UPDATE prompts
               SET name = ?, system_prompt = ?, template = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (name, system_prompt, template, prompt_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM prompts WHERE id = ?", (prompt_id,)).fetchone()
        conn.close()
    return _row_to_prompt(row) if row else None


def delete_prompt(prompt_id: str) -> bool:
    """Delete a custom prompt. Returns False if the prompt is a default (protected)."""
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT is_default FROM prompts WHERE id = ?", (prompt_id,)).fetchone()
        if not row or row["is_default"]:
            conn.close()
            return False
        conn.execute("DELETE FROM prompts WHERE id = ?", (prompt_id,))
        conn.commit()
        conn.close()
    return True


def seed_default_prompts() -> None:
    """Upsert built-in prompts: insert new ones, update changed ones."""
    from llm.prompts import PROMPTS  # local import to avoid circular dependency
    with _lock:
        conn = _connect()
        for mode, data in PROMPTS.items():
            existing = conn.execute(
                "SELECT id FROM prompts WHERE mode = ? AND is_default = 1",
                (mode,),
            ).fetchone()
            if existing:
                # Update in case the hardcoded prompt content changed
                conn.execute(
                    """UPDATE prompts
                       SET name = ?, system_prompt = ?, template = ?, updated_at = datetime('now')
                       WHERE mode = ? AND is_default = 1""",
                    (data["name"], data["system"], data["template"], mode),
                )
            else:
                conn.execute(
                    """INSERT INTO prompts (id, name, mode, system_prompt, template, is_default)
                       VALUES (?, ?, ?, ?, ?, 1)""",
                    (str(uuid.uuid4()), data["name"], mode, data["system"], data["template"]),
                )
        conn.commit()
        conn.close()


# ── History CRUD ───────────────────────────────────────────────────────────────

def create_history_entry(mode: str, source: str, result: str, reasoning: str = "", source_detail: str = "") -> dict:
    entry_id = str(uuid.uuid4())
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT INTO history (id, mode, source, source_detail, result, reasoning) VALUES (?, ?, ?, ?, ?, ?)",
            (entry_id, mode, source, source_detail, result, reasoning),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM history WHERE id = ?", (entry_id,)).fetchone()
        conn.close()
    return dict(row)


def list_history(limit: int = 50) -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM history ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
    return [dict(r) for r in rows]


def delete_history_entry(entry_id: str) -> bool:
    with _lock:
        conn = _connect()
        cur = conn.execute("DELETE FROM history WHERE id = ?", (entry_id,))
        conn.commit()
        conn.close()
    return cur.rowcount > 0


def clear_history() -> None:
    with _lock:
        conn = _connect()
        conn.execute("DELETE FROM history")
        conn.commit()
        conn.close()


def search_history(query: str, limit: int = 50) -> list[dict]:
    """Full-text search across history results using FTS5 MATCH syntax."""
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT h.id, h.mode, h.source, h.result, h.reasoning, h.created_at,
                       snippet(history_fts, 0, '<mark>', '</mark>', '…', 32) AS snippet
                FROM history h
                JOIN history_fts ON h.rowid = history_fts.rowid
                WHERE history_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (query, limit),
            ).fetchall()
        except Exception:
            rows = []
        conn.close()
    return [dict(r) for r in rows]


def _rebuild_fts_if_empty() -> None:
    """Populate FTS index from existing history rows (runs once after first migration)."""
    with _lock:
        conn = _connect()
        count = conn.execute("SELECT COUNT(*) FROM history_fts").fetchone()[0]
        total = conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        if total > 0 and count == 0:
            conn.execute("INSERT INTO history_fts(history_fts) VALUES('rebuild')")
            conn.commit()
        conn.close()


# ── Feed CRUD ──────────────────────────────────────────────────────────────────

def create_feed(url: str, title: str = "", check_interval: int = 3600,
                auto_summarize: bool = True, summarize_mode: str = "summary") -> dict:
    feed_id = str(uuid.uuid4())
    with _lock:
        conn = _connect()
        conn.execute(
            """INSERT INTO feeds (id, url, title, check_interval, auto_summarize, summarize_mode)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (feed_id, url, title, check_interval, int(auto_summarize), summarize_mode),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
        conn.close()
    return dict(row)


def list_feeds() -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute("SELECT * FROM feeds ORDER BY created_at DESC").fetchall()
        conn.close()
    return [dict(r) for r in rows]


def get_feed(feed_id: str) -> dict | None:
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
        conn.close()
    return dict(row) if row else None


def update_feed(feed_id: str, **kwargs) -> dict | None:
    allowed = {"title", "check_interval", "auto_summarize", "summarize_mode",
               "last_checked", "last_entry_id"}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return get_feed(feed_id)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    with _lock:
        conn = _connect()
        conn.execute(
            f"UPDATE feeds SET {set_clause} WHERE id = ?",
            list(updates.values()) + [feed_id],
        )
        conn.commit()
        row = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
        conn.close()
    return dict(row) if row else None


def delete_feed(feed_id: str) -> bool:
    with _lock:
        conn = _connect()
        conn.execute("DELETE FROM feed_entries WHERE feed_id = ?", (feed_id,))
        cur = conn.execute("DELETE FROM feeds WHERE id = ?", (feed_id,))
        conn.commit()
        conn.close()
    return cur.rowcount > 0


def list_feed_entries(feed_id: str, limit: int = 50) -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM feed_entries WHERE feed_id = ? ORDER BY created_at DESC LIMIT ?",
            (feed_id, limit),
        ).fetchall()
        conn.close()
    return [dict(r) for r in rows]


def upsert_feed_entry(feed_id: str, entry_id: str, title: str, audio_url: str,
                      published: str) -> dict:
    row_id = str(uuid.uuid4())
    with _lock:
        conn = _connect()
        existing = conn.execute(
            "SELECT id FROM feed_entries WHERE feed_id = ? AND entry_id = ?",
            (feed_id, entry_id),
        ).fetchone()
        if not existing:
            conn.execute(
                """INSERT INTO feed_entries (id, feed_id, entry_id, title, audio_url, published)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (row_id, feed_id, entry_id, title, audio_url, published),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM feed_entries WHERE id = ?", (row_id,)).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM feed_entries WHERE id = ?", (existing["id"],)
            ).fetchone()
        conn.close()
    return dict(row) if row else {}


def update_feed_entry_status(entry_id: str, status: str, job_id: str = "") -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "UPDATE feed_entries SET status = ?, job_id = ? WHERE id = ?",
            (status, job_id, entry_id),
        )
        conn.commit()
        conn.close()


def reset_default_prompts() -> None:
    """Overwrite built-in prompt entries with the hardcoded defaults."""
    from llm.prompts import PROMPTS
    with _lock:
        conn = _connect()
        for mode, data in PROMPTS.items():
            conn.execute(
                """UPDATE prompts
                   SET name = ?, system_prompt = ?, template = ?, updated_at = datetime('now')
                   WHERE mode = ? AND is_default = 1""",
                (data["name"], data["system"], data["template"], mode),
            )
        conn.commit()
        conn.close()
