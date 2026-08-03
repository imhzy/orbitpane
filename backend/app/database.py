from __future__ import annotations

import sqlite3
from pathlib import Path

from .models import Conversation, Message


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
                    provider TEXT NOT NULL DEFAULT 'agy'
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    conversation_id INTEGER NOT NULL,
                    thought TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'agy',
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                """
            )
            self._add_column(connection, "conversations", "provider", "TEXT NOT NULL DEFAULT 'agy'")
            self._add_column(connection, "messages", "thought", "TEXT NOT NULL DEFAULT ''")
            self._add_column(connection, "messages", "model", "TEXT NOT NULL DEFAULT ''")
            self._add_column(connection, "messages", "provider", "TEXT NOT NULL DEFAULT 'agy'")
            self._add_column(connection, "messages", "duration", "REAL NOT NULL DEFAULT 0.0")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id "
                "ON messages(conversation_id, id)"
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
                "COALESCE(model, '') AS model, COALESCE(provider, 'agy') AS provider, "
                "COALESCE(duration, 0.0) AS duration "
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
        provider: str = "agy",
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO messages("
                "conversation_id, role, content, thought, duration, model, provider"
                ") VALUES (?, ?, ?, ?, ?, ?, ?)",
                (conversation_id, role, content, thought, duration, model, provider),
            )

    def clear_messages(self, conversation_id: int) -> None:
        with self.connect() as connection:
            connection.execute(
                "DELETE FROM messages WHERE conversation_id = ?", (conversation_id,)
            )

