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
        self.assertEqual(conversation.permission_mode, "workspace")
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
        self.assertEqual(messages[0].feedback, "")

        rated = self.database.set_message_feedback(conversation.id, message_id, "up")
        self.assertIsNotNone(rated)
        assert rated is not None
        self.assertEqual(rated.feedback, "up")
        cleared = self.database.set_message_feedback(conversation.id, message_id, "")
        assert cleared is not None
        self.assertEqual(cleared.feedback, "")
        self.assertIsNone(
            self.database.set_message_feedback(conversation.id, message_id + 999, "up")
        )

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

    def test_clear_history_also_drops_summaries_runs_and_shares(self) -> None:
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        message_id = self.database.add_message(
            conversation.id, "user", "hello", run_id="run-1"
        )
        self.database.create_summary_checkpoint(
            conversation.id, message_id, message_id, "summary"
        )
        for run_id, status, prompt in (
            ("run-1", "completed", "hello"),
            ("run-2", "queued", "queued task"),
        ):
            self.database.create_run(
                run_id,
                conversation.id,
                status=status,
                prompt=prompt,
                model="test-model",
                provider="antigravity",
                is_summary=False,
            )

        self.database.create_share(
            conversation.id,
            token_hash="hash-1",
            token_cipher="sealed-1",
            title="Workspace",
            snapshot='{"messages": []}',
            message_count=1,
            include_thoughts=False,
            expires_at=None,
        )

        self.database.clear_history(conversation.id)

        self.assertEqual(self.database.list_shares(conversation.id), [])
        self.assertEqual(self.database.list_messages(conversation.id), [])
        self.assertEqual(
            self.database.list_summary_checkpoints(conversation.id), []
        )
        self.assertEqual(
            self.database.list_runs(conversation_id=conversation.id), []
        )
        self.assertIsNone(self.database.active_summary_message_id(conversation.id))


    def test_share_snapshots_are_keyed_by_hash_and_scoped_to_a_conversation(self) -> None:
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        other = self.database.create_conversation(
            "Other", self.temp_dir.name, "antigravity"
        )
        share = self.database.create_share(
            conversation.id,
            token_hash="hash-1",
            token_cipher="sealed-1",
            title="Workspace",
            snapshot='{"messages": [1]}',
            message_count=1,
            include_thoughts=True,
            expires_at=None,
        )
        # Owner-facing metadata must never carry the lookup key or the payload.
        self.assertNotIn("token_hash", share)
        self.assertNotIn("snapshot", share)
        self.assertTrue(share["include_thoughts"])
        self.assertEqual(share["view_count"], 0)
        # The sealed token comes back to its owner and to nobody else.
        self.assertEqual(share["token_cipher"], "sealed-1")
        self.assertEqual(
            self.database.list_shares(conversation.id)[0]["token_cipher"], "sealed-1"
        )

        resolved = self.database.find_share_by_token_hash("hash-1")
        self.assertIsNotNone(resolved)
        assert resolved is not None
        self.assertEqual(resolved["snapshot"], '{"messages": [1]}')
        self.assertNotIn("token_cipher", resolved)
        self.assertIsNone(self.database.find_share_by_token_hash("hash-2"))

        self.database.record_share_view(int(share["id"]))
        viewed = self.database.list_shares(conversation.id)[0]
        self.assertEqual(viewed["view_count"], 1)
        self.assertIsNotNone(viewed["last_viewed_at"])

        # A link belongs to its conversation; another project cannot revoke it.
        self.assertFalse(self.database.delete_share(other.id, int(share["id"])))
        self.assertTrue(self.database.delete_share(conversation.id, int(share["id"])))
        self.assertIsNone(self.database.find_share_by_token_hash("hash-1"))

    def test_a_share_stored_without_a_sealed_token_still_lists(self) -> None:
        """The shape of every row written before the token was kept.

        Such a link cannot be shown again, but it is still a live link: it has
        to keep listing, keep counting views and keep being revocable.
        """
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        share = self.database.create_share(
            conversation.id,
            token_hash="hash-legacy",
            token_cipher=None,
            title="Workspace",
            snapshot='{"messages": []}',
            message_count=0,
            include_thoughts=False,
            expires_at=None,
        )

        self.assertIsNone(share["token_cipher"])
        listed = self.database.list_shares(conversation.id)
        self.assertEqual(len(listed), 1)
        self.assertIsNone(listed[0]["token_cipher"])
        self.assertTrue(self.database.delete_share(conversation.id, int(share["id"])))

    def test_deleting_a_conversation_removes_its_share_snapshots(self) -> None:
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        self.database.create_share(
            conversation.id,
            token_hash="hash-cascade",
            token_cipher="sealed-cascade",
            title="Workspace",
            snapshot='{"messages": []}',
            message_count=0,
            include_thoughts=False,
            expires_at=None,
        )

        self.database.delete_conversation(conversation.id)

        self.assertIsNone(self.database.find_share_by_token_hash("hash-cascade"))
        with self.database.connect() as connection:
            remaining = connection.execute("SELECT COUNT(*) FROM shares").fetchone()[0]
        self.assertEqual(remaining, 0)

    def _orphan_share(self, token_hash: str) -> None:
        """Insert a snapshot whose conversation does not exist.

        Foreign keys are turned off for the insert so the row can exist at all —
        this is the shape a database would have if the cascade had ever failed
        to run, which is precisely what the read path has to survive.
        """
        with self.database.connect() as connection:
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(
                "INSERT INTO shares(conversation_id, token_hash, title, snapshot, "
                "message_count, include_thoughts, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (999_999, token_hash, "Ghost", '{"messages": []}', 0, 0, None),
            )

    def test_a_share_whose_conversation_is_gone_never_resolves(self) -> None:
        self._orphan_share("hash-orphan")

        self.assertIsNone(self.database.find_share_by_token_hash("hash-orphan"))

    def test_purge_removes_expired_and_orphaned_snapshots(self) -> None:
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        self.database.create_share(
            conversation.id,
            token_hash="hash-expired",
            token_cipher="sealed-expired",
            title="Workspace",
            snapshot='{"messages": []}',
            message_count=0,
            include_thoughts=False,
            expires_at="2000-01-01T00:00:00.000000Z",
        )
        self.database.create_share(
            conversation.id,
            token_hash="hash-live",
            token_cipher="sealed-live",
            title="Workspace",
            snapshot='{"messages": []}',
            message_count=0,
            include_thoughts=False,
            expires_at=None,
        )
        self._orphan_share("hash-orphan")

        self.assertEqual(self.database.purge_dead_shares(), 2)

        with self.database.connect() as connection:
            surviving = [
                row[0]
                for row in connection.execute("SELECT token_hash FROM shares")
            ]
        self.assertEqual(surviving, ["hash-live"])

    def test_deleting_a_conversation_does_not_rely_on_the_foreign_key_pragma(
        self,
    ) -> None:
        """The cascade is a backstop, not the mechanism.

        `delete_conversation` deletes the snapshots itself, so a connection that
        somehow ran without foreign key enforcement would still not leave a
        public copy of a deleted project behind.
        """
        conversation = self.database.create_conversation(
            "Workspace", self.temp_dir.name, "antigravity"
        )
        self.database.create_share(
            conversation.id,
            token_hash="hash-explicit",
            token_cipher="sealed-explicit",
            title="Workspace",
            snapshot='{"messages": []}',
            message_count=0,
            include_thoughts=False,
            expires_at=None,
        )

        original_connect = self.database.connect

        def connect_without_foreign_keys():
            connection = original_connect()
            connection.execute("PRAGMA foreign_keys = OFF")
            return connection

        self.database.connect = connect_without_foreign_keys  # type: ignore[method-assign]
        try:
            self.database.delete_conversation(conversation.id)
        finally:
            self.database.connect = original_connect  # type: ignore[method-assign]

        with self.database.connect() as connection:
            remaining = connection.execute("SELECT COUNT(*) FROM shares").fetchone()[0]
        self.assertEqual(remaining, 0)


if __name__ == "__main__":
    unittest.main()
