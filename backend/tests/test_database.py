from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.app.database import Database


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temp_dir.name) / "orbitpane-test.db")
        self.database.migrate()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_conversation_and_message_lifecycle(self) -> None:
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        self.assertEqual(conversation.permission_mode, "unrestricted")
        message_id = self.database.add_message(
            conversation.id,
            "user",
            "hello",
            model="test-model",
            provider="antigravity",
            run_id="run-1",
            input_chars=5,
        )

        messages = self.database.list_messages(conversation.id)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].id, message_id)
        self.assertEqual(messages[0].content, "hello")
        self.assertEqual(messages[0].provider, "antigravity")
        self.assertEqual(messages[0].run_id, "run-1")
        self.assertTrue(messages[0].timestamp.endswith("Z"))

        updated = self.database.update_conversation(
            conversation.id,
            name="Renamed",
            is_pinned=True,
            preferred_model="test-model",
            permission_mode="unrestricted",
            draft="unfinished",
        )
        self.assertIsNotNone(updated)
        assert updated is not None
        self.assertEqual(updated.name, "Renamed")
        self.assertTrue(updated.is_pinned)
        self.assertEqual(updated.permission_mode, "unrestricted")
        self.assertEqual(updated.draft, "unfinished")

        checkpoint = self.database.create_summary_checkpoint(
            conversation.id, message_id, message_id, "summary"
        )
        self.assertTrue(checkpoint["active"])
        self.database.update_summary_checkpoint(
            conversation.id, checkpoint["id"], content="edited", active=False
        )
        self.assertIsNone(self.database.active_summary_message_id(conversation.id))

        self.assertTrue(self.database.delete_conversation(conversation.id))
        self.assertEqual(self.database.list_messages(conversation.id), [])


if __name__ == "__main__":
    unittest.main()
