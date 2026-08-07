from __future__ import annotations

import pymysql
import pymysql.cursors

from .models import Conversation, Message

DEFAULT_PROVIDER_ID = "antigravity"
_LEGACY_PROVIDER_ID = "".join(("a", "g", "y"))


class Database:
    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        db_name: str,
    ):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.db_name = db_name

    def connect(self) -> pymysql.connections.Connection:
        # First ensure database exists (connect without db)
        conn = pymysql.connect(
            host=self.host,
            port=self.port,
            user=self.user,
            password=self.password,
            charset='utf8mb4',
            init_command="SET time_zone = '+08:00'"
        )
        with conn.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{self.db_name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        conn.commit()
        conn.close()

        # Connect to the database
        return pymysql.connect(
            host=self.host,
            port=self.port,
            user=self.user,
            password=self.password,
            database=self.db_name,
            charset='utf8mb4',
            cursorclass=pymysql.cursors.DictCursor,
            init_command="SET time_zone = '+08:00'"
        )

    def migrate(self) -> None:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS conversations (
                        id INTEGER PRIMARY KEY AUTO_INCREMENT,
                        name VARCHAR(255) NOT NULL,
                        path VARCHAR(1024) NOT NULL,
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        provider VARCHAR(255) NOT NULL DEFAULT 'antigravity'
                    );
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS messages (
                        id INTEGER PRIMARY KEY AUTO_INCREMENT,
                        role VARCHAR(255) NOT NULL,
                        content LONGTEXT NOT NULL,
                        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        conversation_id INTEGER NOT NULL,
                        thought LONGTEXT,
                        model VARCHAR(255) NOT NULL DEFAULT '',
                        provider VARCHAR(255) NOT NULL DEFAULT 'antigravity',
                        duration REAL NOT NULL DEFAULT 0.0,
                        run_id VARCHAR(255) NOT NULL DEFAULT '',
                        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                    );
                    """
                )
                
                # Indexes
                cursor.execute(
                    "CREATE INDEX idx_messages_conversation_id "
                    "ON messages(conversation_id, id)"
                )
                cursor.execute(
                    "CREATE INDEX idx_messages_run_id "
                    "ON messages(conversation_id, run_id)"
                )
                cursor.execute(
                    "CREATE INDEX idx_conversations_created_at "
                    "ON conversations(created_at DESC)"
                )
                
            self._migrate_provider_id(connection)
            connection.commit()
        # Ignore duplicate index errors
        except pymysql.err.OperationalError as e:
            if "Duplicate key name" not in str(e):
                raise
        finally:
            connection.close()


    @staticmethod
    def _migrate_provider_id(connection: pymysql.connections.Connection) -> None:
        with connection.cursor() as cursor:
            for table in ("conversations", "messages"):
                cursor.execute(
                    f"UPDATE {table} SET provider = %s WHERE provider = %s",
                    (DEFAULT_PROVIDER_ID, _LEGACY_PROVIDER_ID),
                )

    def list_conversations(self) -> list[Conversation]:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, name, path, created_at, provider "
                    "FROM conversations ORDER BY id DESC"
                )
                rows = cursor.fetchall()
            return [Conversation(**dict(row)) for row in rows]
        finally:
            connection.close()

    def get_conversation(self, conversation_id: int) -> Conversation | None:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, name, path, created_at, provider "
                    "FROM conversations WHERE id = %s",
                    (conversation_id,),
                )
                row = cursor.fetchone()
            return Conversation(**dict(row)) if row else None
        finally:
            connection.close()

    def create_conversation(self, name: str, path: str, provider: str) -> Conversation:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO conversations(name, path, provider) VALUES (%s, %s, %s)",
                    (name, path, provider),
                )
                conversation_id = int(cursor.lastrowid)
            connection.commit()
            return self.get_conversation(conversation_id) # type: ignore
        finally:
            connection.close()

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
                updates.append(f"{column} = %s")
                values.append(value)
        if updates:
            values.append(conversation_id)
            connection = self.connect()
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"UPDATE conversations SET {', '.join(updates)} WHERE id = %s",
                        tuple(values),
                    )
                connection.commit()
            finally:
                connection.close()
        return self.get_conversation(conversation_id)

    def delete_conversation(self, conversation_id: int) -> bool:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM messages WHERE conversation_id = %s", (conversation_id,)
                )
                cursor.execute(
                    "DELETE FROM conversations WHERE id = %s", (conversation_id,)
                )
                rowcount = cursor.rowcount
            connection.commit()
            return rowcount > 0
        finally:
            connection.close()

    def list_messages(self, conversation_id: int) -> list[Message]:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT role, content, COALESCE(thought, '') AS thought, timestamp, "
                    "COALESCE(model, '') AS model, "
                    "COALESCE(provider, 'antigravity') AS provider, "
                    "COALESCE(duration, 0.0) AS duration, COALESCE(run_id, '') AS run_id "
                    "FROM messages WHERE conversation_id = %s ORDER BY id ASC",
                    (conversation_id,),
                )
                rows = cursor.fetchall()
            return [Message(**dict(row)) for row in rows]
        finally:
            connection.close()

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
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO messages("
                    "conversation_id, role, content, thought, duration, model, provider, run_id"
                    ") VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
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
            connection.commit()
        finally:
            connection.close()

    def clear_messages(self, conversation_id: int) -> None:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM messages WHERE conversation_id = %s", (conversation_id,)
                )
            connection.commit()
        finally:
            connection.close()
