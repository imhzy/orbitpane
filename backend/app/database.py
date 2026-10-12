from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import Conversation, Message, ScheduleSpec
from .schedule_rules import next_fire_time, parse_time, utc_iso

DEFAULT_PROVIDER_ID = "antigravity"
_LEGACY_PROVIDER_ID = "".join(("a", "g", "y"))


def _utc_iso(value: object | None = None) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value).strip()
    if not text:
        return _utc_iso()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text.replace(" ", "T") + ("" if text.endswith("Z") else "Z")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class Database:
    """SQLite persistence repository.

    A short-lived connection is used for every operation. WAL mode and a busy
    timeout keep concurrent WebSocket and REST writes predictable while still
    allowing each test to use an isolated temporary database file.
    """

    def __init__(self, path: Path):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def passkey_ids(self) -> list[bytes]:
        with self.connect() as connection:
            return [row[0] for row in connection.execute("SELECT credential_id FROM passkeys")]

    def get_passkey(self, credential_id: bytes) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM passkeys WHERE credential_id = ?", (credential_id,)
            ).fetchone()
            return dict(row) if row else None

    def add_passkey(self, credential_id: bytes, public_key: bytes, sign_count: int) -> bool:
        with self.connect() as connection:
            return connection.execute(
                "INSERT OR IGNORE INTO passkeys (credential_id, public_key, sign_count) VALUES (?, ?, ?)",
                (credential_id, public_key, sign_count),
            ).rowcount == 1

    def update_passkey_counter(self, credential_id: bytes, old: int, new: int) -> bool:
        with self.connect() as connection:
            return connection.execute(
                "UPDATE passkeys SET sign_count = ? WHERE credential_id = ? AND sign_count = ?",
                (new, credential_id, old),
            ).rowcount == 1

    def save_passkey_challenge(self, challenge_id: str, challenge: bytes, purpose: str,
                              session_hash: str, previous_id: str | None = None) -> bool:
        with self.connect() as connection:
            connection.execute("DELETE FROM passkey_challenges WHERE expires_at <= ? OR id = ?",
                               (time.time(), previous_id))
            if connection.execute("SELECT count(*) FROM passkey_challenges").fetchone()[0] >= 1000:
                return False
            connection.execute(
                "INSERT INTO passkey_challenges VALUES (?, ?, ?, ?, ?)",
                (challenge_id, challenge, purpose, session_hash, time.time() + 300),
            )
            return True

    def consume_passkey_challenge(self, challenge_id: str, purpose: str,
                                 session_hash: str) -> bytes | None:
        # DELETE RETURNING is atomic across processes: even invalid responses
        # consume the ceremony, and a verified assertion cannot be replayed.
        with self.connect() as connection:
            row = connection.execute(
                "DELETE FROM passkey_challenges WHERE id = ? RETURNING *", (challenge_id,)
            ).fetchone()
            if (row and row["expires_at"] > time.time() and row["purpose"] == purpose
                    and row["session_hash"] == session_hash):
                return row["challenge"]
            return None

    def migrate(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS passkeys (
                    credential_id BLOB PRIMARY KEY,
                    public_key BLOB NOT NULL,
                    sign_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                CREATE TABLE IF NOT EXISTS push_subscriptions (
                    endpoint TEXT PRIMARY KEY,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    application_server_key TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS push_deliveries (
                    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
                    endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt REAL NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (run_id, endpoint)
                );
                CREATE TABLE IF NOT EXISTS passkey_challenges (
                    id TEXT PRIMARY KEY,
                    challenge BLOB NOT NULL,
                    purpose TEXT NOT NULL,
                    session_hash TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    provider TEXT NOT NULL DEFAULT 'antigravity',
                    is_pinned INTEGER NOT NULL DEFAULT 0,
                    is_archived INTEGER NOT NULL DEFAULT 0,
                    preferred_model TEXT NOT NULL DEFAULT '',
                    permission_mode TEXT NOT NULL DEFAULT 'workspace',
                    draft TEXT NOT NULL DEFAULT '',
                    active_summary_id INTEGER
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    conversation_id INTEGER NOT NULL,
                    thought TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'antigravity',
                    duration REAL NOT NULL DEFAULT 0.0,
                    run_id TEXT NOT NULL DEFAULT '',
                    input_chars INTEGER NOT NULL DEFAULT 0,
                    output_chars INTEGER NOT NULL DEFAULT 0,
                    context_chars INTEGER NOT NULL DEFAULT 0,
                    feedback TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS summary_checkpoints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL,
                    message_id INTEGER NOT NULL,
                    covered_through_id INTEGER NOT NULL DEFAULT 0,
                    title TEXT NOT NULL DEFAULT '上下文检查点',
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS shares (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    -- Sealed by the application, opaque here. Resolution uses
                    -- token_hash only; this column exists so the owner's panel
                    -- can show a link it handed out earlier.
                    token_cipher TEXT,
                    title TEXT NOT NULL,
                    snapshot TEXT NOT NULL,
                    message_count INTEGER NOT NULL DEFAULT 0,
                    include_thoughts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    expires_at TEXT,
                    view_count INTEGER NOT NULL DEFAULT 0,
                    last_viewed_at TEXT,
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    spec TEXT NOT NULL,
                    compact_before INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    next_run_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    conversation_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    prompt TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'antigravity',
                    is_summary INTEGER NOT NULL DEFAULT 0,
                    queued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    started_at TEXT,
                    completed_at TEXT,
                    duration REAL NOT NULL DEFAULT 0.0,
                    input_chars INTEGER NOT NULL DEFAULT 0,
                    output_chars INTEGER NOT NULL DEFAULT 0,
                    context_chars INTEGER NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                -- The last model list each agent CLI reported, so a restart
                -- serves it immediately instead of waiting on a fresh probe.
                CREATE TABLE IF NOT EXISTS model_catalogs (
                    provider TEXT PRIMARY KEY,
                    models TEXT NOT NULL,
                    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                """
            )
            self._migrate_legacy_columns(connection)
            for table in ("conversations", "messages"):
                connection.execute(
                    f"UPDATE {table} SET provider = ? WHERE provider = ?",
                    (DEFAULT_PROVIDER_ID, _LEGACY_PROVIDER_ID),
                )
            # A process restart cannot safely resume a CLI child process. Keep
            # the record but make the interruption explicit in the task center.
            connection.execute(
                "UPDATE runs SET status = 'interrupted', completed_at = ?, "
                "error = CASE WHEN error = '' THEN '服务重启，任务未继续执行' ELSE error END "
                "WHERE status IN ('queued', 'starting', 'running')",
                (_utc_iso(),),
            )
            connection.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
                    ON messages(conversation_id, id);
                CREATE INDEX IF NOT EXISTS idx_messages_run_id
                    ON messages(conversation_id, run_id);
                CREATE INDEX IF NOT EXISTS idx_conversations_created_at
                    ON conversations(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_runs_conversation_status
                    ON runs(conversation_id, status, queued_at DESC);
                CREATE INDEX IF NOT EXISTS idx_summaries_conversation
                    ON summary_checkpoints(conversation_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_shares_conversation
                    ON shares(conversation_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_schedules_due
                    ON schedules(enabled, next_run_at);
                CREATE INDEX IF NOT EXISTS idx_schedules_conversation
                    ON schedules(conversation_id, id);
                CREATE INDEX IF NOT EXISTS idx_runs_schedule
                    ON runs(schedule_id, queued_at DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_schedule_slot
                    ON runs(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;
                """
            )
            # SQLite enforces foreign keys *per connection*, and `shares`
            # leans on ON DELETE CASCADE so that deleting a project also
            # unpublishes it. If that pragma ever stops applying, the cascade
            # silently stops running and deleted conversations keep serving
            # public snapshots. Fail at startup rather than discover it from a
            # live link.
            if not connection.execute("PRAGMA foreign_keys").fetchone()[0]:
                raise RuntimeError(
                    "SQLite foreign key enforcement is off; share snapshots "
                    "would outlive the conversations they copy"
                )
            self._purge_dead_shares(connection)

    @staticmethod
    def _add_column(
        connection: sqlite3.Connection, table: str, name: str, definition: str
    ) -> None:
        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({table})")
        }
        if name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")

    def _migrate_legacy_columns(self, connection: sqlite3.Connection) -> None:
        conversation_columns = {
            "provider": "TEXT NOT NULL DEFAULT 'antigravity'",
            "is_pinned": "INTEGER NOT NULL DEFAULT 0",
            "is_archived": "INTEGER NOT NULL DEFAULT 0",
            "preferred_model": "TEXT NOT NULL DEFAULT ''",
            # Existing rows keep whatever they were created with; only projects
            # created from here on inherit the safer default.
            "permission_mode": "TEXT NOT NULL DEFAULT 'workspace'",
            "draft": "TEXT NOT NULL DEFAULT ''",
            "active_summary_id": "INTEGER",
        }
        message_columns = {
            "thought": "TEXT NOT NULL DEFAULT ''",
            "model": "TEXT NOT NULL DEFAULT ''",
            "provider": "TEXT NOT NULL DEFAULT 'antigravity'",
            "duration": "REAL NOT NULL DEFAULT 0.0",
            "run_id": "TEXT NOT NULL DEFAULT ''",
            "input_chars": "INTEGER NOT NULL DEFAULT 0",
            "output_chars": "INTEGER NOT NULL DEFAULT 0",
            "context_chars": "INTEGER NOT NULL DEFAULT 0",
            "feedback": "TEXT NOT NULL DEFAULT ''",
            "schedule_id": "INTEGER",
            "schedule_name": "TEXT NOT NULL DEFAULT ''",
            "scheduled_for": "TEXT NOT NULL DEFAULT ''",
            "is_error": "INTEGER NOT NULL DEFAULT 0",
            "error_code": "TEXT NOT NULL DEFAULT ''",
        }
        run_columns = {
            "schedule_id": "INTEGER REFERENCES schedules(id) ON DELETE SET NULL",
            "schedule_name": "TEXT NOT NULL DEFAULT ''",
            "scheduled_for": "TEXT NOT NULL DEFAULT ''",
            "compact_before": "INTEGER NOT NULL DEFAULT 0",
        }
        # Links created before the token was kept stay listed and revocable;
        # they simply have nothing to show.
        share_columns = {"token_cipher": "TEXT"}
        for name, definition in conversation_columns.items():
            self._add_column(connection, "conversations", name, definition)
        for name, definition in message_columns.items():
            self._add_column(connection, "messages", name, definition)
        for name, definition in share_columns.items():
            self._add_column(connection, "shares", name, definition)
        for name, definition in run_columns.items():
            self._add_column(connection, "runs", name, definition)

    @staticmethod
    def _conversation(row: sqlite3.Row) -> Conversation:
        return Conversation(
            id=int(row["id"]),
            name=str(row["name"]),
            path=str(row["path"]),
            created_at=_utc_iso(row["created_at"]),
            provider=str(row["provider"] or DEFAULT_PROVIDER_ID),
            is_pinned=bool(row["is_pinned"]),
            is_archived=bool(row["is_archived"]),
            preferred_model=str(row["preferred_model"] or ""),
            permission_mode=(
                "unrestricted"
                if row["permission_mode"] == "unrestricted"
                else "workspace"
            ),
            draft=str(row["draft"] or ""),
            active_summary_id=(
                int(row["active_summary_id"])
                if row["active_summary_id"] is not None
                else None
            ),
        )

    @staticmethod
    def _message(row: sqlite3.Row) -> Message:
        return Message(
            id=int(row["id"]),
            role=str(row["role"]),
            content=str(row["content"]),
            thought=str(row["thought"] or ""),
            timestamp=_utc_iso(row["timestamp"]),
            model=str(row["model"] or ""),
            provider=str(row["provider"] or DEFAULT_PROVIDER_ID),
            duration=float(row["duration"] or 0),
            run_id=str(row["run_id"] or ""),
            input_chars=int(row["input_chars"] or 0),
            output_chars=int(row["output_chars"] or 0),
            context_chars=int(row["context_chars"] or 0),
            feedback=str(row["feedback"] or ""),
            schedule_id=row["schedule_id"],
            schedule_name=str(row["schedule_name"] or ""),
            scheduled_for=str(row["scheduled_for"] or ""),
            is_error=bool(row["is_error"]),
            error_code=str(row["error_code"] or ""),
        )

    def list_conversations(self, *, include_archived: bool = False) -> list[Conversation]:
        where = "" if include_archived else "WHERE is_archived = 0"
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM conversations " + where +
                " ORDER BY is_pinned DESC, id DESC"
            ).fetchall()
        return [self._conversation(row) for row in rows]

    def get_conversation(self, conversation_id: int) -> Conversation | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return self._conversation(row) if row else None

    def create_conversation(
        self,
        name: str,
        path: str,
        provider: str,
        *,
        preferred_model: str = "",
        permission_mode: str = "workspace",
    ) -> Conversation:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO conversations"
                "(name, path, provider, preferred_model, permission_mode) "
                "VALUES (?, ?, ?, ?, ?)",
                (name, path, provider, preferred_model, permission_mode),
            )
            conversation_id = int(cursor.lastrowid)
        conversation = self.get_conversation(conversation_id)
        if conversation is None:
            raise RuntimeError("Conversation was not created")
        return conversation

    def update_conversation(
        self,
        conversation_id: int,
        *,
        name: str | None = None,
        path: str | None = None,
        provider: str | None = None,
        is_pinned: bool | None = None,
        is_archived: bool | None = None,
        preferred_model: str | None = None,
        permission_mode: str | None = None,
        draft: str | None = None,
        active_summary_id: int | None | object = ...,
    ) -> Conversation | None:
        updates: list[str] = []
        values: list[object] = []
        fields: tuple[tuple[str, object | None], ...] = (
            ("name", name),
            ("path", path),
            ("provider", provider),
            ("is_pinned", int(is_pinned) if is_pinned is not None else None),
            ("is_archived", int(is_archived) if is_archived is not None else None),
            ("preferred_model", preferred_model),
            ("permission_mode", permission_mode),
            ("draft", draft),
        )
        for column, value in fields:
            if value is not None:
                updates.append(f"{column} = ?")
                values.append(value)
        if active_summary_id is not ...:
            updates.append("active_summary_id = ?")
            values.append(active_summary_id)
        if updates:
            values.append(conversation_id)
            with self.connect() as connection:
                connection.execute(
                    f"UPDATE conversations SET {', '.join(updates)} WHERE id = ?",
                    values,
                )
        return self.get_conversation(conversation_id)

    def delete_conversation(self, conversation_id: int) -> bool:
        with self.connect() as connection:
            # The FK cascade already covers this. It is written out anyway,
            # inside the same transaction, because "a public copy outlived the
            # conversation it copied" is the one failure this code must not
            # have, and it should not depend on a pragma being set correctly on
            # whichever connection happens to run the delete.
            connection.execute(
                "DELETE FROM shares WHERE conversation_id = ?", (conversation_id,)
            )
            cursor = connection.execute(
                "DELETE FROM conversations WHERE id = ?", (conversation_id,)
            )
        return cursor.rowcount > 0

    def list_messages(self, conversation_id: int) -> list[Message]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC",
                (conversation_id,),
            ).fetchall()
        return [self._message(row) for row in rows]

    def message_page(
        self, conversation_id: int, limit: int = 60, *,
        before_id: int | None = None, after_id: int | None = None,
    ) -> tuple[list[Message], bool, int]:
        clauses = ["conversation_id = ?"]
        params: list[object] = [conversation_id]
        if before_id is not None:
            clauses.append("id < ?")
            params.append(before_id)
        if after_id is not None:
            clauses.append("id > ?")
            params.append(after_id)
        order = "ASC" if after_id is not None else "DESC"
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM messages WHERE {' AND '.join(clauses)} ORDER BY id {order} LIMIT ?",
                [*params, limit + 1],
            ).fetchall()
            first_id = connection.execute(
                "SELECT COALESCE(MIN(id), 0) FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()[0]
        more = len(rows) > limit
        rows = rows[:limit]
        if after_id is None:
            rows.reverse()
        return [self._message(row) for row in rows], more, int(first_id)

    def max_message_id(self, conversation_id: int) -> int:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(id), 0) AS value FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["value"] if row else 0)

    def add_message(
        self,
        conversation_id: int,
        role: str,
        content: str,
        *,
        thought: str = "",
        duration: float = 0.0,
        model: str = "",
        provider: str = DEFAULT_PROVIDER_ID,
        run_id: str = "",
        input_chars: int = 0,
        output_chars: int = 0,
        context_chars: int = 0,
        schedule_id: int | None = None,
        schedule_name: str = "",
        scheduled_for: str = "",
        is_error: bool = False,
        error_code: str = "",
    ) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO messages(conversation_id, role, content, thought, duration, "
                "model, provider, run_id, input_chars, output_chars, context_chars, "
                "schedule_id, schedule_name, scheduled_for, is_error, error_code) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    role,
                    content,
                    thought,
                    duration,
                    model,
                    provider,
                    run_id,
                    input_chars,
                    output_chars,
                    context_chars,
                    schedule_id,
                    schedule_name,
                    scheduled_for,
                    int(is_error),
                    error_code,
                ),
            )
            return int(cursor.lastrowid)

    def update_message_content(self, message_id: int, content: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE messages SET content = ? WHERE id = ?", (content, message_id)
            )

    def get_message(self, conversation_id: int, message_id: int) -> Message | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM messages WHERE conversation_id = ? AND id = ?",
                (conversation_id, message_id),
            ).fetchone()
        return self._message(row) if row else None

    def set_message_feedback(
        self, conversation_id: int, message_id: int, feedback: str
    ) -> Message | None:
        """Persist a thumbs-up/down. An empty string clears the rating."""
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE messages SET feedback = ? WHERE conversation_id = ? AND id = ?",
                (feedback, conversation_id, message_id),
            )
            if cursor.rowcount == 0:
                return None
        return self.get_message(conversation_id, message_id)

    def clear_history(self, conversation_id: int) -> None:
        """Drop every trace of previous turns: messages, summaries, runs, shares.

        Run records carry the prompts of queued/finished tasks, so leaving them
        behind would keep the task center showing content the user just cleared.
        Share snapshots are a published copy of exactly that content, so a link
        outliving the clear would keep serving what the user just erased.
        """
        with self.connect() as connection:
            connection.execute(
                "DELETE FROM shares WHERE conversation_id = ?", (conversation_id,)
            )
            connection.execute(
                "DELETE FROM summary_checkpoints WHERE conversation_id = ?",
                (conversation_id,),
            )
            connection.execute(
                "DELETE FROM messages WHERE conversation_id = ?", (conversation_id,)
            )
            connection.execute(
                "DELETE FROM runs WHERE conversation_id = ?", (conversation_id,)
            )
            connection.execute(
                "UPDATE conversations SET active_summary_id = NULL WHERE id = ?",
                (conversation_id,),
            )

    def create_summary_checkpoint(
        self,
        conversation_id: int,
        message_id: int,
        covered_through_id: int,
        content: str,
    ) -> dict[str, Any]:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO summary_checkpoints(conversation_id, message_id, "
                "covered_through_id, title, content) VALUES (?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    message_id,
                    covered_through_id,
                    f"上下文检查点 · 消息 {covered_through_id}",
                    content,
                ),
            )
            checkpoint_id = int(cursor.lastrowid)
            connection.execute(
                "UPDATE conversations SET active_summary_id = ? WHERE id = ?",
                (checkpoint_id, conversation_id),
            )
        checkpoint = self.get_summary_checkpoint(conversation_id, checkpoint_id)
        if checkpoint is None:
            raise RuntimeError("Summary checkpoint was not created")
        return checkpoint

    def get_summary_checkpoint(
        self, conversation_id: int, checkpoint_id: int
    ) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT s.*, c.active_summary_id FROM summary_checkpoints s "
                "JOIN conversations c ON c.id = s.conversation_id "
                "WHERE s.conversation_id = ? AND s.id = ?",
                (conversation_id, checkpoint_id),
            ).fetchone()
        return self._checkpoint_dict(row) if row else None

    @staticmethod
    def _checkpoint_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "conversation_id": int(row["conversation_id"]),
            "message_id": int(row["message_id"]),
            "covered_through_id": int(row["covered_through_id"]),
            "title": str(row["title"]),
            "content": str(row["content"]),
            "created_at": _utc_iso(row["created_at"]),
            "active": row["active_summary_id"] == row["id"],
        }

    def list_summary_checkpoints(self, conversation_id: int) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT s.*, c.active_summary_id FROM summary_checkpoints s "
                "JOIN conversations c ON c.id = s.conversation_id "
                "WHERE s.conversation_id = ? ORDER BY s.id DESC",
                (conversation_id,),
            ).fetchall()
        return [self._checkpoint_dict(row) for row in rows]

    def update_summary_checkpoint(
        self,
        conversation_id: int,
        checkpoint_id: int,
        *,
        title: str | None = None,
        content: str | None = None,
        active: bool | None = None,
    ) -> dict[str, Any] | None:
        checkpoint = self.get_summary_checkpoint(conversation_id, checkpoint_id)
        if checkpoint is None:
            return None
        with self.connect() as connection:
            if title is not None:
                connection.execute(
                    "UPDATE summary_checkpoints SET title = ? WHERE id = ?",
                    (title, checkpoint_id),
                )
            if content is not None:
                connection.execute(
                    "UPDATE summary_checkpoints SET content = ? WHERE id = ?",
                    (content, checkpoint_id),
                )
                connection.execute(
                    "UPDATE messages SET content = ? WHERE id = ?",
                    (content, checkpoint["message_id"]),
                )
            if active is not None:
                connection.execute(
                    "UPDATE conversations SET active_summary_id = ? WHERE id = ?",
                    (checkpoint_id if active else None, conversation_id),
                )
        return self.get_summary_checkpoint(conversation_id, checkpoint_id)

    def active_summary_message_id(self, conversation_id: int) -> int | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT s.message_id FROM conversations c "
                "JOIN summary_checkpoints s ON s.id = c.active_summary_id "
                "WHERE c.id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["message_id"]) if row else None

    def save_compaction_checkpoint(self, run_id: str, *, content: str, thought: str,
                                   duration: float, covered_through_id: int) -> Message:
        """Publish the summary and activate its checkpoint in one transaction."""
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            if run is None:
                raise ValueError("执行记录不存在")
            cursor = connection.execute(
                "INSERT INTO messages(conversation_id, role, content, thought, duration, model, "
                "provider, run_id, output_chars, schedule_id, schedule_name, scheduled_for) "
                "VALUES (?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (run["conversation_id"], content, thought, duration, run["model"], run["provider"],
                 run_id + "-compact", len(content), run["schedule_id"], run["schedule_name"], run["scheduled_for"]),
            )
            message_id = int(cursor.lastrowid)
            checkpoint = connection.execute(
                "INSERT INTO summary_checkpoints(conversation_id, message_id, covered_through_id, "
                "title, content) VALUES (?, ?, ?, ?, ?)",
                (run["conversation_id"], message_id, covered_through_id,
                 f"上下文检查点 · 消息 {covered_through_id}", content),
            )
            connection.execute("UPDATE conversations SET active_summary_id = ? WHERE id = ?",
                               (checkpoint.lastrowid, run["conversation_id"]))
            return self._message(connection.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone())

    _SCHEDULE_SELECT = (
        "SELECT s.*, c.name AS conversation_name, "
        "r.run_id AS last_run_id, r.status AS last_status, r.error AS last_error, "
        "r.queued_at AS last_run_at, r.completed_at AS last_completed_at, "
        "(SELECT COUNT(*) FROM runs q WHERE q.schedule_id = s.id "
        "AND q.status IN ('queued', 'starting')) AS pending_count "
        "FROM schedules s JOIN conversations c ON c.id = s.conversation_id "
        "LEFT JOIN runs r ON r.run_id = (SELECT x.run_id FROM runs x "
        "WHERE x.schedule_id = s.id ORDER BY x.rowid DESC LIMIT 1) "
    )

    @staticmethod
    def _schedule(row: sqlite3.Row) -> dict[str, Any]:
        return {**dict(row), "spec": json.loads(row["spec"]),
                "enabled": bool(row["enabled"]), "compact_before": bool(row["compact_before"])}

    def list_schedules(self, conversation_id: int | None = None) -> list[dict[str, Any]]:
        where = "WHERE s.conversation_id = ? " if conversation_id is not None else ""
        with self.connect() as connection:
            rows = connection.execute(
                self._SCHEDULE_SELECT + where + "ORDER BY s.enabled DESC, s.next_run_at, s.id",
                (conversation_id,) if conversation_id is not None else (),
            ).fetchall()
        return [self._schedule(row) for row in rows]

    def get_schedule(self, conversation_id: int, schedule_id: int) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                self._SCHEDULE_SELECT + "WHERE s.conversation_id = ? AND s.id = ?",
                (conversation_id, schedule_id),
            ).fetchone()
        return self._schedule(row) if row else None

    def create_schedule(self, conversation_id: int, *, name: str, prompt: str,
                        spec: dict, compact_before: bool, enabled: bool,
                        now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(timezone.utc)
        rule = ScheduleSpec.model_validate(spec)
        next_at = utc_iso(next_fire_time(rule, now)) if enabled else None
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute(
                "SELECT COUNT(*) FROM schedules WHERE conversation_id = ?", (conversation_id,)
            ).fetchone()[0] >= 100:
                raise ValueError("每个聊天最多可创建 100 个定时任务")
            cursor = connection.execute(
                "INSERT INTO schedules(conversation_id, name, prompt, spec, compact_before, "
                "enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (conversation_id, name, prompt, rule.model_dump_json(), int(compact_before),
                 int(enabled), next_at, utc_iso(now), utc_iso(now)),
            )
            schedule_id = int(cursor.lastrowid)
        return self.get_schedule(conversation_id, schedule_id)  # type: ignore[return-value]

    def update_schedule(self, conversation_id: int, schedule_id: int, values: dict,
                        *, now: datetime | None = None) -> dict[str, Any] | None:
        now = now or datetime.now(timezone.utc)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM schedules WHERE conversation_id = ? AND id = ?",
                (conversation_id, schedule_id),
            ).fetchone()
            if row is None:
                return None
            if "version" in values and values["version"] != row["version"]:
                raise ValueError("任务已在其他窗口修改，请刷新后重试")
            changed = {key: value for key, value in values.items()
                       if key in {"name", "prompt", "spec", "compact_before", "enabled"}}
            spec = ScheduleSpec.model_validate(changed.get("spec", json.loads(row["spec"])))
            enabled = changed.get("enabled", bool(row["enabled"]))
            rule_changed = spec.model_dump() != ScheduleSpec.model_validate_json(row["spec"]).model_dump()
            if rule_changed or (enabled and not row["enabled"]):
                changed["next_run_at"] = utc_iso(next_fire_time(spec, now)) if enabled else None
            elif not enabled:
                changed["next_run_at"] = None
            if "spec" in changed:
                changed["spec"] = spec.model_dump_json()
            if changed:
                changed["updated_at"] = utc_iso(now)
                connection.execute(
                    f"UPDATE schedules SET {', '.join(f'{key} = ?' for key in changed)}, "
                    "version = version + 1 WHERE id = ?",
                    [*changed.values(), schedule_id],
                )
        return self.get_schedule(conversation_id, schedule_id)

    def delete_schedule(self, conversation_id: int, schedule_id: int) -> bool:
        with self.connect() as connection:
            return connection.execute(
                "DELETE FROM schedules WHERE conversation_id = ? AND id = ?",
                (conversation_id, schedule_id),
            ).rowcount == 1

    def claim_due_schedules(self, now: datetime, *, skip_all: bool = False) -> list[dict[str, Any]]:
        """Atomically advance due rules and persist each accepted execution.

        Startup advances every old slot without running it. During normal
        operation a five-second polling tolerance absorbs event-loop jitter;
        older slots are skipped. Busy agents do not affect this deadline: each
        accepted slot is queued separately and may wait as long as necessary.
        """
        claimed = []
        now_text = utc_iso(now)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT s.*, c.provider, c.preferred_model FROM schedules s "
                "JOIN conversations c ON c.id = s.conversation_id "
                "WHERE s.enabled = 1 AND s.next_run_at <= ? ORDER BY s.next_run_at, s.id",
                (now_text,),
            ).fetchall()
            for row in rows:
                due = parse_time(row["next_run_at"])
                rule = ScheduleSpec.model_validate_json(row["spec"])
                next_at = utc_iso(next_fire_time(rule, now, anchor=due))
                connection.execute("UPDATE schedules SET next_run_at = ? WHERE id = ?", (next_at, row["id"]))
                if skip_all or (now - due).total_seconds() > 5:
                    continue
                run_id = f"{row['conversation_id']}-{uuid.uuid4().hex}"
                connection.execute(
                    "INSERT INTO runs(run_id, conversation_id, status, prompt, model, provider, "
                    "schedule_id, schedule_name, scheduled_for, compact_before, queued_at) "
                    "VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
                    (run_id, row["conversation_id"], row["prompt"], row["preferred_model"],
                     row["provider"], row["id"], row["name"], row["next_run_at"],
                     row["compact_before"], now_text),
                )
                claimed.append({"run_id": run_id, "conversation_id": row["conversation_id"]})
        return claimed

    def create_schedule_run(self, conversation_id: int, schedule_id: int,
                            request_id: str) -> str | None:
        """Run-now is retry-safe, without moving the recurring trigger."""
        run_id = f"{conversation_id}-{uuid.uuid5(uuid.NAMESPACE_URL, 'schedule-' + request_id).hex}"
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT s.*, c.provider, c.preferred_model FROM schedules s "
                "JOIN conversations c ON c.id = s.conversation_id "
                "WHERE s.conversation_id = ? AND s.id = ?", (conversation_id, schedule_id),
            ).fetchone()
            if row is None:
                return None
            previous = connection.execute("SELECT schedule_id FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            if previous:
                if previous["schedule_id"] != schedule_id:
                    raise ValueError("请求标识已用于其他定时任务")
                return run_id
            connection.execute(
                "INSERT INTO runs(run_id, conversation_id, status, prompt, model, provider, "
                "schedule_id, schedule_name, scheduled_for, compact_before) "
                "VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
                (run_id, conversation_id, row["prompt"], row["preferred_model"], row["provider"],
                 schedule_id, row["name"], _utc_iso(), row["compact_before"]),
            )
        return run_id

    def pending_schedule_runs(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT run_id, conversation_id FROM runs WHERE status = 'queued' "
                "AND schedule_name != '' ORDER BY queued_at, rowid",
            ).fetchall()
        return [dict(row) for row in rows]

    def record_scheduled_failure(self, run_id: str, error: str, error_code: str) -> None:
        """Keep the attempted prompt and failure visible after a reconnect.

        A preflight failure can happen before the user turn was persisted.
        Both inserts are idempotent and preserve the trigger's immutable source
        metadata, even if its schedule was subsequently edited or removed.
        """
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO messages(conversation_id, role, content, provider, run_id, input_chars, "
                "schedule_id, schedule_name, scheduled_for) "
                "SELECT r.conversation_id, 'user', r.prompt, r.provider, r.run_id, LENGTH(r.prompt), "
                "r.schedule_id, r.schedule_name, r.scheduled_for FROM runs r "
                "WHERE r.run_id = ? AND r.schedule_name != '' AND NOT EXISTS "
                "(SELECT 1 FROM messages m WHERE m.conversation_id = r.conversation_id AND m.run_id = r.run_id AND m.role = 'user')",
                (run_id,),
            )
            connection.execute(
                "INSERT INTO messages(conversation_id, role, content, provider, run_id, "
                "schedule_id, schedule_name, scheduled_for, is_error, error_code) "
                "SELECT r.conversation_id, 'system', ?, r.provider, r.run_id, r.schedule_id, "
                "r.schedule_name, r.scheduled_for, 1, ? FROM runs r "
                "WHERE r.run_id = ? AND r.schedule_name != '' AND NOT EXISTS "
                "(SELECT 1 FROM messages m WHERE m.conversation_id = r.conversation_id AND m.run_id = r.run_id AND m.role = 'system' AND m.is_error = 1)",
                (error, error_code, run_id),
            )

    def create_run(
        self,
        run_id: str,
        conversation_id: int,
        *,
        status: str,
        prompt: str,
        model: str,
        provider: str,
        is_summary: bool,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO runs(run_id, conversation_id, status, prompt, model, "
                "provider, is_summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    conversation_id,
                    status,
                    prompt,
                    model,
                    provider,
                    int(is_summary),
                ),
            )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT r.*, c.name AS conversation_name FROM runs r "
                "JOIN conversations c ON c.id = r.conversation_id WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return {**dict(row), "is_summary": bool(row["is_summary"])} if row else None

    def update_run(self, run_id: str, **values: object) -> None:
        allowed = {
            "status",
            "prompt",
            "model",
            "provider",
            "started_at",
            "completed_at",
            "duration",
            "input_chars",
            "output_chars",
            "context_chars",
            "error",
        }
        updates = [(key, value) for key, value in values.items() if key in allowed]
        if not updates:
            return
        with self.connect() as connection:
            # Persist notification work in the same transaction as completion.
            # Repeated completion writes, reconnects and request retries cannot
            # enqueue the same run twice, even after delivery has been removed.
            if values.get("status") in {"completed", "failed"}:
                connection.execute(
                    "INSERT OR IGNORE INTO push_deliveries(run_id, endpoint, created_at) "
                    "SELECT r.run_id, s.endpoint, ? FROM runs r CROSS JOIN push_subscriptions s "
                    "WHERE r.run_id = ? AND r.status NOT IN ('completed', 'failed', 'interrupted', 'canceled') "
                    "AND (? = 'completed' OR r.schedule_name != '')",
                    (time.time(), run_id, values["status"]),
                )
            connection.execute(
                f"UPDATE runs SET {', '.join(f'{key} = ?' for key, _ in updates)} "
                "WHERE run_id = ?",
                [value for _, value in updates] + [run_id],
            )

    def save_push_subscription(self, subscription: dict[str, Any]) -> None:
        with self.connect() as connection:
            # OrbitPane has one authenticated workspace owner, with multiple
            # devices. Bound storage even if a client keeps submitting new URLs.
            if connection.execute(
                "SELECT COUNT(*) FROM push_subscriptions WHERE endpoint != ?",
                (subscription["endpoint"],),
            ).fetchone()[0] >= 100:
                raise ValueError("Too many push subscriptions")
            connection.execute(
                "INSERT INTO push_subscriptions VALUES (?, ?, ?, ?) "
                "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, "
                "auth=excluded.auth, application_server_key=excluded.application_server_key",
                (subscription["endpoint"], subscription["keys"]["p256dh"],
                 subscription["keys"]["auth"], subscription["application_server_key"]),
            )

    def delete_push_subscription(self, endpoint: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))

    def pending_push_deliveries(self, public_key: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            connection.execute("DELETE FROM push_deliveries WHERE created_at < ?", (time.time() - 86400,))
            # Key rotation invalidates the old browser subscriptions.
            connection.execute("DELETE FROM push_subscriptions WHERE application_server_key != ?", (public_key,))
            rows = connection.execute(
                "SELECT d.*, s.p256dh, s.auth, r.conversation_id, r.status, r.schedule_name FROM push_deliveries d "
                "JOIN push_subscriptions s ON s.endpoint = d.endpoint "
                "JOIN runs r ON r.run_id = d.run_id "
                "WHERE d.next_attempt <= ? ORDER BY d.next_attempt, d.created_at LIMIT 10",
                (time.time(),),
            ).fetchall()
        return [dict(row) for row in rows]

    def finish_push_delivery(self, run_id: str, endpoint: str, *, retry: bool = False) -> None:
        with self.connect() as connection:
            if retry:
                connection.execute(
                    "UPDATE push_deliveries SET attempts=attempts+1, "
                    "next_attempt=? + MIN(3600, 30 * (1 << MIN(attempts, 7))) "
                    "WHERE run_id=? AND endpoint=?", (time.time(), run_id, endpoint),
                )
            else:
                connection.execute("DELETE FROM push_deliveries WHERE run_id=? AND endpoint=?", (run_id, endpoint))

    def list_runs(
        self, *, conversation_id: int | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        params: list[object] = []
        where = ""
        if conversation_id is not None:
            where = "WHERE r.conversation_id = ?"
            params.append(conversation_id)
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT r.*, c.name AS conversation_name FROM runs r "
                "JOIN conversations c ON c.id = r.conversation_id "
                f"{where} ORDER BY r.queued_at DESC LIMIT ?",
                params,
            ).fetchall()
        return [
            {
                **dict(row),
                "is_summary": bool(row["is_summary"]),
                "queued_at": _utc_iso(row["queued_at"]),
                "started_at": _utc_iso(row["started_at"]) if row["started_at"] else None,
                "completed_at": (
                    _utc_iso(row["completed_at"]) if row["completed_at"] else None
                ),
            }
            for row in rows
        ]

    def search(self, query: str, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        pattern = "%" + query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT 'conversation' AS result_type, c.id AS conversation_id, "
                "NULL AS message_id, c.name AS title, c.path AS snippet, c.created_at "
                "FROM conversations c WHERE c.is_archived = 0 AND "
                "(lower(c.name) LIKE ? ESCAPE '\\' OR lower(c.path) LIKE ? ESCAPE '\\') "
                "UNION ALL "
                "SELECT 'message' AS result_type, m.conversation_id, m.id AS message_id, "
                "c.name AS title, substr(m.content, MAX(1, instr(lower(m.content), lower(?)) - 90), 280) AS snippet, m.timestamp AS created_at "
                "FROM messages m JOIN conversations c ON c.id = m.conversation_id "
                "WHERE c.is_archived = 0 AND lower(m.content) LIKE ? ESCAPE '\\' "
                "ORDER BY created_at DESC, conversation_id DESC, message_id DESC LIMIT ? OFFSET ?",
                (pattern, pattern, query, pattern, limit, offset),
            ).fetchall()
        return [
            {
                **dict(row),
                "created_at": _utc_iso(row["created_at"]),
            }
            for row in rows
        ]

    def conversation_stats(self, conversation_id: int) -> dict[str, Any]:
        with self.connect() as connection:
            message_row = connection.execute(
                "SELECT COUNT(*) AS message_count, COALESCE(SUM(duration), 0) AS duration, "
                "COALESCE(SUM(input_chars), 0) AS input_chars, "
                "COALESCE(SUM(output_chars), 0) AS output_chars, "
                "COALESCE(MAX(context_chars), 0) AS context_chars "
                "FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            summary_count = connection.execute(
                "SELECT COUNT(*) AS value FROM summary_checkpoints WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return {
            "message_count": int(message_row["message_count"]),
            "duration": round(float(message_row["duration"]), 1),
            "input_chars": int(message_row["input_chars"]),
            "output_chars": int(message_row["output_chars"]),
            "context_chars": int(message_row["context_chars"]),
            "summary_count": int(summary_count["value"]),
        }

    # ── Share snapshots ─────────────────────────────────────────────────────
    #
    # A share is a frozen copy of the conversation, not a view onto it: the
    # rendered payload is stored once at creation and never re-read from
    # `messages`, so later turns, edits and deletions cannot change or leak
    # into a link that is already public.

    @classmethod
    def _owner_share(cls, row: sqlite3.Row) -> dict[str, Any]:
        """`_share_dict` plus the sealed token, for the owner's own panel.

        Only the two authenticated reads use this. The public lookup builds its
        answer from `_share_dict`, which cannot carry the token in any form.
        """
        return {
            **cls._share_dict(row),
            "token_cipher": str(row["token_cipher"]) if row["token_cipher"] else None,
        }

    @staticmethod
    def _share_dict(row: sqlite3.Row) -> dict[str, Any]:
        """Owner-facing metadata. The token hash and payload never come along."""
        return {
            "id": int(row["id"]),
            "conversation_id": int(row["conversation_id"]),
            "title": str(row["title"]),
            "message_count": int(row["message_count"]),
            "include_thoughts": bool(row["include_thoughts"]),
            "created_at": _utc_iso(row["created_at"]),
            "expires_at": _utc_iso(row["expires_at"]) if row["expires_at"] else None,
            "view_count": int(row["view_count"]),
            "last_viewed_at": (
                _utc_iso(row["last_viewed_at"]) if row["last_viewed_at"] else None
            ),
        }

    def purge_dead_shares(self) -> int:
        """Run the sweep on its own connection. Returns the number of rows gone."""
        with self.connect() as connection:
            return self._purge_dead_shares(connection)

    @staticmethod
    def _purge_dead_shares(connection: sqlite3.Connection) -> int:
        """Delete every snapshot that must no longer exist.

        Two classes of row. Expired: past its deadline a link should stop being
        a stored copy of the conversation, not merely stop resolving. Orphaned:
        rows whose conversation is gone, which the cascade normally removes —
        swept anyway so that a database written by an older build, or restored
        from a backup taken mid-delete, cannot carry a public copy of content
        that no longer exists.
        """
        cursor = connection.execute(
            "DELETE FROM shares "
            "WHERE (expires_at IS NOT NULL AND expires_at <= ?) "
            "OR conversation_id NOT IN (SELECT id FROM conversations)",
            (_utc_iso(),),
        )
        return int(cursor.rowcount)

    def create_share(
        self,
        conversation_id: int,
        *,
        token_hash: str,
        token_cipher: str | None,
        title: str,
        snapshot: str,
        message_count: int,
        include_thoughts: bool,
        expires_at: str | None,
    ) -> dict[str, Any]:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO shares(conversation_id, token_hash, token_cipher, title, "
                "snapshot, message_count, include_thoughts, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    token_hash,
                    token_cipher,
                    title,
                    snapshot,
                    message_count,
                    int(include_thoughts),
                    expires_at,
                ),
            )
            share_id = int(cursor.lastrowid)
        share = self.get_share(conversation_id, share_id)
        if share is None:
            raise RuntimeError("Share was not created")
        return share

    def get_share(self, conversation_id: int, share_id: int) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM shares WHERE conversation_id = ? AND id = ?",
                (conversation_id, share_id),
            ).fetchone()
        return self._owner_share(row) if row else None

    def list_shares(self, conversation_id: int) -> list[dict[str, Any]]:
        """Owner-facing link list, and the sweep that keeps the table honest.

        Opening the share panel is the moment the owner reasons about what is
        public, so it is also the moment expired and orphaned snapshots get
        deleted for real rather than merely filtered out of the response.
        """
        with self.connect() as connection:
            self._purge_dead_shares(connection)
            rows = connection.execute(
                "SELECT * FROM shares WHERE conversation_id = ? ORDER BY id DESC",
                (conversation_id,),
            ).fetchall()
        return [self._owner_share(row) for row in rows]

    def count_shares(self, conversation_id: int) -> int:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS total FROM shares WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["total"])

    def find_share_by_token_hash(self, token_hash: str) -> dict[str, Any] | None:
        """Resolve a public link, by digest rather than by any stored token.

        The sealed copy in `token_cipher` is unreachable from here by design:
        nothing on the public path can be tricked into reading it, and the row
        is found only by someone who already holds the token.

        The join is the actual guarantee that deleted content stops being
        served. Cleanup on the write side can be missed — a cascade that did not
        fire, a future code path that forgets — but a snapshot whose
        conversation is gone cannot match this query at all, so a stale row is
        an unreachable row rather than a live leak.
        """
        with self.connect() as connection:
            row = connection.execute(
                "SELECT shares.* FROM shares "
                "JOIN conversations ON conversations.id = shares.conversation_id "
                "WHERE shares.token_hash = ?",
                (token_hash,),
            ).fetchone()
        if row is None:
            return None
        return {**self._share_dict(row), "snapshot": str(row["snapshot"])}

    def record_share_view(self, share_id: int) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? "
                "WHERE id = ?",
                (_utc_iso(), share_id),
            )

    def delete_share(self, conversation_id: int, share_id: int) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM shares WHERE conversation_id = ? AND id = ?",
                (conversation_id, share_id),
            )
        return cursor.rowcount > 0

    def delete_share_by_id(self, share_id: int) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM shares WHERE id = ?", (share_id,))

    def load_model_catalog(self, provider: str) -> tuple[tuple[str, str], ...]:
        """The (model id, display name) pairs last saved for a provider."""
        with self.connect() as connection:
            row = connection.execute(
                "SELECT models FROM model_catalogs WHERE provider = ?", (provider,)
            ).fetchone()
        if row is None:
            return ()
        try:
            entries = json.loads(row["models"])
        except (TypeError, ValueError):
            return ()
        # Written by this process, but read back on a later start by whatever
        # version is running then: anything unexpected is simply not a list.
        if not isinstance(entries, list):
            return ()
        return tuple(
            (entry[0], entry[1])
            for entry in entries
            if isinstance(entry, list)
            and len(entry) == 2
            and all(isinstance(part, str) and part for part in entry)
        )

    def save_model_catalog(
        self, provider: str, catalog: tuple[tuple[str, str], ...]
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO model_catalogs(provider, models, fetched_at) "
                "VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET "
                "models = excluded.models, fetched_at = excluded.fetched_at",
                (
                    provider,
                    json.dumps([list(entry) for entry in catalog], ensure_ascii=False),
                    _utc_iso(),
                ),
            )
