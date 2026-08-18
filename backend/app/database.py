from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import Conversation, Message

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

    def migrate(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
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
        }
        for name, definition in conversation_columns.items():
            self._add_column(connection, "conversations", name, definition)
        for name, definition in message_columns.items():
            self._add_column(connection, "messages", name, definition)

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
    ) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO messages(conversation_id, role, content, thought, duration, "
                "model, provider, run_id, input_chars, output_chars, context_chars) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            connection.execute(
                f"UPDATE runs SET {', '.join(f'{key} = ?' for key, _ in updates)} "
                "WHERE run_id = ?",
                [value for _, value in updates] + [run_id],
            )

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

    def search(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        pattern = f"%{query.casefold()}%"
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT 'conversation' AS result_type, c.id AS conversation_id, "
                "NULL AS message_id, c.name AS title, c.path AS snippet, c.created_at "
                "FROM conversations c WHERE c.is_archived = 0 AND "
                "(lower(c.name) LIKE ? OR lower(c.path) LIKE ?) "
                "UNION ALL "
                "SELECT 'message' AS result_type, m.conversation_id, m.id AS message_id, "
                "c.name AS title, substr(m.content, 1, 280) AS snippet, m.timestamp AS created_at "
                "FROM messages m JOIN conversations c ON c.id = m.conversation_id "
                "WHERE c.is_archived = 0 AND lower(m.content) LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (pattern, pattern, pattern, limit),
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
        title: str,
        snapshot: str,
        message_count: int,
        include_thoughts: bool,
        expires_at: str | None,
    ) -> dict[str, Any]:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO shares(conversation_id, token_hash, title, snapshot, "
                "message_count, include_thoughts, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    token_hash,
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
        return self._share_dict(row) if row else None

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
        return [self._share_dict(row) for row in rows]

    def count_shares(self, conversation_id: int) -> int:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS total FROM shares WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return int(row["total"])

    def find_share_by_token_hash(self, token_hash: str) -> dict[str, Any] | None:
        """Resolve a public link. Lookup is by hash: the raw token is never stored.

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
