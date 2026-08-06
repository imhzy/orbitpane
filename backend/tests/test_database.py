from __future__ import annotations

import tempfile
import unittest
import pymysql

from backend.app.database import Database

class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_name = "orbitpane_test"
        self.database = Database(
            host="127.0.0.1",
            port=3306,
            user="root",
            password="REDACTED_PASSWORD",
            db_name=self.db_name,
        )
        # Drop test db if it exists
        try:
            conn = pymysql.connect(
                host="127.0.0.1",
                port=3306,
                user="root",
                password="REDACTED_PASSWORD"
            )
            with conn.cursor() as cursor:
                cursor.execute(f"DROP DATABASE IF EXISTS `{self.db_name}`")
            conn.commit()
            conn.close()
        except Exception:
            pass

        self.database.migrate()

    def tearDown(self) -> None:
        # Clean up db
        try:
            conn = pymysql.connect(
                host="127.0.0.1",
                port=3306,
                user="root",
                password="REDACTED_PASSWORD"
            )
            with conn.cursor() as cursor:
                cursor.execute(f"DROP DATABASE IF EXISTS `{self.db_name}`")
            conn.commit()
            conn.close()
        except Exception:
            pass
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

if __name__ == "__main__":
    unittest.main()
