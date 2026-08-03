from __future__ import annotations

import unittest

from backend.app.security import AuthenticationError, LoginRateLimiter, TokenService


class TokenServiceTests(unittest.TestCase):
    def test_issued_token_can_be_verified(self) -> None:
        service = TokenService("1234", "a-long-test-secret", 60)
        payload = service.verify(service.issue())
        self.assertEqual(payload["sub"], "orbitpane-user")

    def test_tampered_token_is_rejected(self) -> None:
        service = TokenService("1234", "a-long-test-secret", 60)
        token = service.issue()
        with self.assertRaises(AuthenticationError):
            service.verify(f"{token}x")

    def test_expired_token_is_rejected(self) -> None:
        service = TokenService("1234", "a-long-test-secret", -1)
        with self.assertRaises(AuthenticationError):
            service.verify(service.issue())

    def test_pin_comparison(self) -> None:
        service = TokenService("1234", "a-long-test-secret", 60)
        self.assertTrue(service.verify_pin("1234"))
        self.assertFalse(service.verify_pin("4321"))


class LoginRateLimiterTests(unittest.TestCase):
    def test_failed_attempts_are_limited_and_resettable(self) -> None:
        limiter = LoginRateLimiter(max_attempts=2, window_seconds=60)
        self.assertTrue(limiter.check("client"))
        limiter.record_failure("client")
        limiter.record_failure("client")
        self.assertFalse(limiter.check("client"))
        limiter.reset("client")
        self.assertTrue(limiter.check("client"))


if __name__ == "__main__":
    unittest.main()
