from __future__ import annotations

import sqlite3
from pathlib import Path

from .models import Conversation, Message

DEFAULT_PROVIDER_ID = "antigravity"
_LEGACY_PROVIDER_ID = "".join(("a", "g", "y"))


class Database:
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
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    provider TEXT NOT NULL DEFAULT 'antigravity'
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    conversation_id INTEGER NOT NULL,
                    thought TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'antigravity',
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                """
            )
            self._add_column(
                connection,
                "conversations",
                "provider",
                "TEXT NOT NULL DEFAULT 'antigravity'",
            )
            self._add_column(connection, "messages", "thought", "TEXT NOT NULL DEFAULT ''")
            self._add_column(connection, "messages", "model", "TEXT NOT NULL DEFAULT ''")
            self._add_column(
                connection,
                "messages",
                "provider",
                "TEXT NOT NULL DEFAULT 'antigravity'",
            )
            self._add_column(connection, "messages", "duration", "REAL NOT NULL DEFAULT 0.0")
            self._add_column(connection, "messages", "run_id", "TEXT NOT NULL DEFAULT ''")
            self._migrate_provider_id(connection)
            self._rebuild_provider_schema_if_needed(connection)
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id "
                "ON messages(conversation_id, id)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_run_id "
                "ON messages(conversation_id, run_id)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_created_at "
                "ON conversations(created_at DESC)"
            )

    @staticmethod
    def _add_column(
        connection: sqlite3.Connection, table: str, name: str, definition: str
    ) -> None:
        columns = {
            row["name"] for row in connection.execute(f"PRAGMA table_info({table})")
        }
        if name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")

    @staticmethod
    def _migrate_provider_id(connection: sqlite3.Connection) -> None:
        for table in ("conversations", "messages"):
            connection.execute(
                f"UPDATE {table} SET provider = ? WHERE provider = ?",
                (DEFAULT_PROVIDER_ID, _LEGACY_PROVIDER_ID),
            )

    @staticmethod
    def _rebuild_provider_schema_if_needed(
        connection: sqlite3.Connection,
    ) -> None:
        schema_rows = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' "
            "AND name IN ('conversations', 'messages')"
        ).fetchall()
        if not any(
            _LEGACY_PROVIDER_ID.casefold() in (row["sql"] or "").casefold()
            for row in schema_rows
        ):
            return

        connection.commit()
        connection.execute("PRAGMA foreign_keys = OFF")
        try:
            connection.executescript(
                """
                BEGIN IMMEDIATE;

                CREATE TABLE orbitpane_conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    provider TEXT NOT NULL DEFAULT 'antigravity'
                );
                INSERT INTO orbitpane_conversations(
                    id, name, path, created_at, provider
                )
                SELECT
                    id,
                    COALESCE(name, ''),
                    COALESCE(path, ''),
                    COALESCE(created_at, CURRENT_TIMESTAMP),
                    COALESCE(provider, 'antigravity')
                FROM conversations;

                CREATE TABLE orbitpane_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    conversation_id INTEGER,
                    thought TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'antigravity',
                    duration REAL NOT NULL DEFAULT 0.0,
                    run_id TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(conversation_id)
                        REFERENCES orbitpane_conversations(id) ON DELETE CASCADE
                );
                INSERT INTO orbitpane_messages(
                    id, role, content, timestamp, conversation_id, thought,
                    model, provider, duration, run_id
                )
                SELECT
                    id,
                    COALESCE(role, ''),
                    COALESCE(content, ''),
                    COALESCE(timestamp, CURRENT_TIMESTAMP),
                    conversation_id,
                    COALESCE(thought, ''),
                    COALESCE(model, ''),
                    COALESCE(provider, 'antigravity'),
                    COALESCE(duration, 0.0),
                    COALESCE(run_id, '')
                FROM messages;

                DROP TABLE messages;
                DROP TABLE conversations;
                ALTER TABLE orbitpane_conversations RENAME TO conversations;
                ALTER TABLE orbitpane_messages RENAME TO messages;

                COMMIT;
                """
            )
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.execute("PRAGMA foreign_keys = ON")

    def list_conversations(self) -> list[Conversation]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, name, path, created_at, provider "
                "FROM conversations ORDER BY id DESC"
            ).fetchall()
        return [Conversation(**dict(row)) for row in rows]

    def get_conversation(self, conversation_id: int) -> Conversation | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id, name, path, created_at, provider "
                "FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return Conversation(**dict(row)) if row else None

    def create_conversation(self, name: str, path: str, provider: str) -> Conversation:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO conversations(name, path, provider) VALUES (?, ?, ?)",
                (name, path, provider),
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
    ) -> Conversation | None:
        updates: list[str] = []
        values: list[object] = []
        for column, value in (("name", name), ("path", path), ("provider", provider)):
            if value is not None:
                updates.append(f"{column} = ?")
                values.append(value)
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
            connection.execute(
                "DELETE FROM messages WHERE conversation_id = ?", (conversation_id,)
            )
            cursor = connection.execute(
                "DELETE FROM conversations WHERE id = ?", (conversation_id,)
            )
        return cursor.rowcount > 0

    def list_messages(self, conversation_id: int) -> list[Message]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT role, content, COALESCE(thought, '') AS thought, timestamp, "
                "COALESCE(model, '') AS model, "
                "COALESCE(provider, 'antigravity') AS provider, "
                "COALESCE(duration, 0.0) AS duration, COALESCE(run_id, '') AS run_id "
                "FROM messages WHERE conversation_id = ? ORDER BY id ASC",
                (conversation_id,),
            ).fetchall()
        return [Message(**dict(row)) for row in rows]

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
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO messages("
                "conversation_id, role, content, thought, duration, model, provider, run_id"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    conversation_id,
                    role,
                    content,
                    thought,
                    duration,
                    model,
                    provider,
                    run_id,
                ),
            )

    def clear_messages(self, conversation_id: int) -> None:
        with self.connect() as connection:
            connection.execute(
                "DELETE FROM messages WHERE conversation_id = ?", (conversation_id,)
            )
