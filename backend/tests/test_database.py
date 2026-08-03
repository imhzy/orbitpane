from __future__ import annotations

import tempfile
import unittest
import sqlite3
from pathlib import Path

from backend.app.database import Database


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temp_dir.name) / "history.db")
        self.database.migrate()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_conversation_and_message_lifecycle(self) -> None:
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        self.database.add_message(
            conversation.id,
            "user",
            "hello",
            model="test-model",
            provider="antigravity",
            run_id="run-1",
        )

        messages = self.database.list_messages(conversation.id)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].content, "hello")
        self.assertEqual(messages[0].provider, "antigravity")
        self.assertEqual(messages[0].run_id, "run-1")

        updated = self.database.update_conversation(
            conversation.id, name="Renamed"
        )
        self.assertIsNotNone(updated)
        self.assertEqual(updated.name, "Renamed")

        self.assertTrue(self.database.delete_conversation(conversation.id))
        self.assertEqual(self.database.list_messages(conversation.id), [])

    def test_migrate_replaces_the_previous_provider_schema_and_values(self) -> None:
        legacy = "".join(("a", "g", "y"))
        path = Path(self.temp_dir.name) / "legacy.db"
        with sqlite3.connect(path) as connection:
            connection.executescript(
                f"""
                CREATE TABLE conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT,
                    path TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    provider TEXT NOT NULL DEFAULT '{legacy}'
                );
                CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT,
                    content TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    conversation_id INTEGER,
                    thought TEXT,
                    model TEXT,
                    provider TEXT NOT NULL DEFAULT '{legacy}',
                    duration REAL NOT NULL DEFAULT 0.0,
                    run_id TEXT NOT NULL DEFAULT ''
                );
                INSERT INTO conversations(name, path) VALUES ('Legacy', '/tmp');
                INSERT INTO messages(role, content, provider)
                    VALUES ('user', 'hello', '{legacy}');
                """
            )

        migrated = Database(path)
        migrated.migrate()
        with migrated.connect() as connection:
            conversation_provider = connection.execute(
                "SELECT provider FROM conversations"
            ).fetchone()["provider"]
            message_provider = connection.execute(
                "SELECT provider FROM messages"
            ).fetchone()["provider"]
            schema = "\n".join(
                row["sql"] or ""
                for row in connection.execute(
                    "SELECT sql FROM sqlite_master WHERE type = 'table'"
                )
            ).casefold()

        self.assertEqual(conversation_provider, "antigravity")
        self.assertEqual(message_provider, "antigravity")
        self.assertNotIn(legacy, schema)


if __name__ == "__main__":
    unittest.main()
