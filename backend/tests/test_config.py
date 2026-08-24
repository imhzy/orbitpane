from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from backend.app.config import Settings, load_dotenv


class DotenvTests(TestCase):
    def _write(self, directory: Path, content: str) -> Path:
        path = directory / ".env"
        path.write_text(content, encoding="utf-8")
        return path

    def test_parses_pairs_comments_quotes_and_export(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = self._write(
                Path(temp_dir),
                "\n".join(
                    [
                        "# a comment",
                        "",
                        "ORBITPANE_PIN=0524",
                        'ORBITPANE_AUTH_SECRET="quoted secret"',
                        "export ORBITPANE_HOST='127.0.0.1'",
                        "  ORBITPANE_PORT = 8005  ",
                        "MALFORMED_LINE_WITHOUT_EQUALS",
                    ]
                ),
            )
            with patch.dict(os.environ, {}, clear=True):
                load_dotenv(path)
                self.assertEqual(os.environ["ORBITPANE_PIN"], "0524")
                self.assertEqual(os.environ["ORBITPANE_AUTH_SECRET"], "quoted secret")
                self.assertEqual(os.environ["ORBITPANE_HOST"], "127.0.0.1")
                self.assertEqual(os.environ["ORBITPANE_PORT"], "8005")
                self.assertNotIn("MALFORMED_LINE_WITHOUT_EQUALS", os.environ)

    def test_real_environment_wins(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = self._write(Path(temp_dir), "ORBITPANE_PIN=from-file")
            with patch.dict(os.environ, {"ORBITPANE_PIN": "from-shell"}, clear=True):
                load_dotenv(path)
                self.assertEqual(os.environ["ORBITPANE_PIN"], "from-shell")

    def test_missing_file_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {}, clear=True):
                load_dotenv(Path(temp_dir) / "absent.env")
                self.assertNotIn("ORBITPANE_PIN", os.environ)


class SettingsTests(TestCase):
    def test_codex_reasoning_summary_defaults_to_detailed(self) -> None:
        with (
            patch("backend.app.config.load_dotenv"),
            patch.dict(os.environ, {}, clear=True),
        ):
            settings = Settings.from_env()

        self.assertEqual(settings.codex_reasoning_summary, "detailed")

    def test_codex_reasoning_summary_is_normalized(self) -> None:
        with (
            patch("backend.app.config.load_dotenv"),
            patch.dict(
                os.environ,
                {"CODEX_REASONING_SUMMARY": " Concise "},
                clear=True,
            ),
        ):
            settings = Settings.from_env()

        self.assertEqual(settings.codex_reasoning_summary, "concise")
