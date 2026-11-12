"""Shared CLI context selection. Estimates are budgets, never billed usage.

Keep the current request and active summary intact and retain a contiguous tail
of complete turns. CLI-injected tools/rules need additional room, so reserve
20% of the configured envelope. No tokenizer for a particular model is assumed.
"""
from __future__ import annotations

import math
from .base import AgentRequest, ProviderError


def estimate_tokens(text: str) -> int:
    # Conservative multilingual heuristic, not a model-specific tokenizer.
    ascii_chars = sum(ord(char) < 128 for char in text)
    return math.ceil(ascii_chars / 3 + (len(text) - ascii_chars) * 2)


def build_context(request: AgentRequest, max_chars: int) -> str:
    token_budget = max(1, int(max_chars / 3 * 0.8))
    char_budget = max(1, int(max_chars * 0.8))
    history = list(request.history)
    summary_index = next((i for i in range(len(history) - 1, -1, -1)
                          if history[i].role == "summary"), None)
    summary = [history[summary_index]] if summary_index is not None else []
    if summary_index is not None:
        history = history[summary_index + 1:]

    def render(messages, omitted=False):
        text = "\n\n".join(f"{m.role.upper()}:\n{m.content}" for m in messages)
        notice = "Earlier complete conversation turns were omitted to fit the context budget.\n\n" if omitted else ""
        return f"{notice}Conversation history:\n{text}\n\nNEW MESSAGE FROM USER:\n{request.prompt}"

    def fits(text):
        return len(text) <= char_budget and estimate_tokens(text) <= token_budget

    full = render(summary + history)
    if fits(full):
        return full
    mandatory = render(summary, bool(history))
    if not fits(mandatory):
        raise ProviderError("当前请求与摘要超过上下文预算，请缩短输入或编辑摘要后重试。",
                            code="context_limit")
    turns = []
    for message in history:
        if message.role == "user" or not turns:
            turns.append([])
        turns[-1].append(message)
    remaining_chars = char_budget - len(mandatory)
    remaining_tokens = token_budget - estimate_tokens(mandatory)
    selected_turns = []
    for turn in reversed(turns):
        text = "\n\n".join(f"{m.role.upper()}:\n{m.content}" for m in turn) + "\n\n"
        cost = estimate_tokens(text)
        if len(text) > remaining_chars or cost > remaining_tokens:
            break
        selected_turns.append(turn)
        remaining_chars -= len(text)
        remaining_tokens -= cost
    selected = [message for turn in reversed(selected_turns) for message in turn]
    return render(summary + selected, len(selected) < len(history))
