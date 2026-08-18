from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import HTTPException, Request, WebSocket, status


SESSION_COOKIE_NAME = "orbitpane_session"

#: 192 bits of entropy in the URL path. Share links are capability URLs — the
#: token *is* the credential — so guessing has to stay out of reach even for a
#: caller who can try continuously.
SHARE_TOKEN_BYTES = 24
SHARE_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def new_share_token() -> str:
    return secrets.token_urlsafe(SHARE_TOKEN_BYTES)


def hash_share_token(token: str) -> str:
    """Digest used for storage and lookup.

    Only the hash is persisted, so a leaked database backup is not also a set
    of working public links.
    """
    return hashlib.sha256(token.encode()).hexdigest()


class AuthenticationError(ValueError):
    pass


class LoginRateLimiter:
    def __init__(self, max_attempts: int = 10, window_seconds: int = 300):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def check(self, client_id: str) -> bool:
        now = time.monotonic()
        failures = self._failures[client_id]
        while failures and failures[0] <= now - self.window_seconds:
            failures.popleft()
        return len(failures) < self.max_attempts

    def record_failure(self, client_id: str) -> None:
        self._failures[client_id].append(time.monotonic())

    def reset(self, client_id: str) -> None:
        self._failures.pop(client_id, None)


@dataclass(frozen=True, slots=True)
class TokenService:
    pin: str
    secret: str
    ttl_seconds: int

    def verify_pin(self, candidate: str) -> bool:
        return bool(candidate) and hmac.compare_digest(candidate, self.pin)

    def issue(self) -> str:
        payload = {
            "iat": int(time.time()),
            "exp": int(time.time()) + self.ttl_seconds,
            "sub": "orbitpane-user",
        }
        encoded = self._encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        )
        signature = self._sign(encoded)
        return f"{encoded}.{signature}"

    def verify(self, token: str | None) -> dict[str, object]:
        if not token:
            raise AuthenticationError("Missing authentication token")
        try:
            encoded, supplied_signature = token.split(".", 1)
            expected_signature = self._sign(encoded)
            if not hmac.compare_digest(supplied_signature, expected_signature):
                raise AuthenticationError("Invalid authentication token")
            payload = json.loads(self._decode(encoded))
            if int(payload.get("exp", 0)) <= int(time.time()):
                raise AuthenticationError("Authentication token has expired")
            return payload
        except AuthenticationError:
            raise
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            raise AuthenticationError("Invalid authentication token") from exc

    def _sign(self, value: str) -> str:
        digest = hmac.new(
            self.secret.encode(), value.encode(), hashlib.sha256
        ).digest()
        return self._encode(digest)

    @staticmethod
    def _encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    @staticmethod
    def _decode(value: str) -> bytes:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def bearer_token(request: Request) -> str | None:
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() == "bearer" and token.strip():
        return token.strip()
    return request.cookies.get(SESSION_COOKIE_NAME)


async def require_auth(request: Request) -> dict[str, object]:
    service: TokenService = request.app.state.tokens
    try:
        return service.verify(bearer_token(request))
    except AuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def authenticate_websocket(websocket: WebSocket, token: str | None) -> bool:
    service: TokenService = websocket.app.state.tokens
    try:
        service.verify(token or websocket.cookies.get(SESSION_COOKIE_NAME))
        return True
    except AuthenticationError as exc:
        await websocket.send_json({"type": "error", "code": "unauthorized", "content": str(exc)})
        await websocket.close(code=4401)
        return False
