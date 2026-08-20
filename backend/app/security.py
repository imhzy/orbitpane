from __future__ import annotations

import base64
import functools
import hashlib
import hmac
import json
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
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
    """Digest used for lookup.

    Resolution never handles a stored token: a link is found by hashing what
    the visitor supplied. `ShareTokenCipher` keeps a separate sealed copy so
    the owner can be shown the link again, and that copy is not reachable from
    this side of the system at all.
    """
    return hashlib.sha256(token.encode()).hexdigest()


#: Domain separator for the share key. The same secret signs session cookies,
#: and the two derivations must not be able to coincide.
SHARE_CIPHER_INFO = b"orbitpane share-token v1"
#: Version tag on every sealed value, so the format can change without having
#: to guess how an existing row was written.
SHARE_CIPHER_PREFIX = "v1:"
SHARE_CIPHER_NONCE_BYTES = 12


@functools.lru_cache(maxsize=4)
def _share_cipher_key(secret: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=SHARE_CIPHER_INFO,
    ).derive(secret.encode())


@dataclass(frozen=True, slots=True)
class ShareTokenCipher:
    """Reversible at-rest storage for share tokens.

    A link the owner cannot read back is a link they can only revoke, so the
    token is kept — but kept sealed. The key is derived from the signing
    secret, which lives in the environment rather than in the database, so a
    stolen `history.db` on its own is still not a set of working links.
    """

    secret: str

    def encrypt(self, token: str) -> str:
        nonce = secrets.token_bytes(SHARE_CIPHER_NONCE_BYTES)
        sealed = AESGCM(_share_cipher_key(self.secret)).encrypt(
            nonce, token.encode(), None
        )
        return SHARE_CIPHER_PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode()

    def decrypt(self, stored: str | None) -> str | None:
        """The token, or None when it cannot be recovered.

        Unrecoverable is an ordinary outcome rather than an error: rows written
        before tokens were kept at all, and rows sealed with a secret that has
        since been rotated. Both mean "this link can no longer be shown", which
        every caller has to handle anyway, so nothing here raises.
        """
        if not stored or not stored.startswith(SHARE_CIPHER_PREFIX):
            return None
        try:
            raw = base64.urlsafe_b64decode(stored[len(SHARE_CIPHER_PREFIX) :])
            nonce, sealed = (
                raw[:SHARE_CIPHER_NONCE_BYTES],
                raw[SHARE_CIPHER_NONCE_BYTES:],
            )
            token = AESGCM(_share_cipher_key(self.secret)).decrypt(
                nonce, sealed, None
            ).decode()
        except (InvalidTag, ValueError, TypeError, UnicodeDecodeError):
            return None
        # A value that decrypts but is not a token means the column no longer
        # holds what this class wrote; a link is not built out of it.
        return token if SHARE_TOKEN_PATTERN.match(token) else None


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
