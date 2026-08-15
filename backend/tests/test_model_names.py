from __future__ import annotations

from unittest import TestCase

from backend.app.agents.base import humanize_model_id


class HumanizeModelIdTests(TestCase):
    def test_matches_previously_hardcoded_client_labels(self) -> None:
        """The fallback must reproduce the names the client used to hardcode."""
        cases = {
            "gemini-3.6-flash-high": "Gemini 3.6 Flash (High)",
            "gemini-3.6-flash-medium": "Gemini 3.6 Flash (Medium)",
            "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
            "claude-sonnet-4-6": "Claude Sonnet 4.6",
            "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
            "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
            "gpt-5.6-sol": "GPT 5.6 Sol",
            "gpt-5.4-mini": "GPT 5.4 Mini",
        }
        for model_id, expected in cases.items():
            with self.subTest(model_id=model_id):
                self.assertEqual(humanize_model_id(model_id), expected)

    def test_unknown_shapes_degrade_gracefully(self) -> None:
        self.assertEqual(humanize_model_id("brand-new-model"), "Brand New Model")
        self.assertEqual(humanize_model_id("single"), "Single")
        self.assertEqual(humanize_model_id(""), "")
        # A bare effort word is a name, not a suffix, when it stands alone.
        self.assertEqual(humanize_model_id("high"), "High")
