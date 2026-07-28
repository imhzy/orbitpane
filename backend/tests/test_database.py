from __future__ import annotations

import tempfile
import unittest
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
            "Workspace", self.temp_dir.name, "agy"
        )
        self.database.add_message(
            conversation.id,
            "user",
            "hello",
            model="test-model",
            provider="agy",
        )

        messages = self.database.list_messages(conversation.id)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].content, "hello")
        self.assertEqual(messages[0].provider, "agy")

        updated = self.database.update_conversation(
            conversation.id, name="Renamed"
        )
        self.assertIsNotNone(updated)
        self.assertEqual(updated.name, "Renamed")

        self.assertTrue(self.database.delete_conversation(conversation.id))
        self.assertEqual(self.database.list_messages(conversation.id), [])


if __name__ == "__main__":
    unittest.main()

