from __future__ import annotations

import unittest

from backend.app.security import (
    AuthenticationError,
    LoginRateLimiter,
    ShareTokenCipher,
    TokenService,
    hash_share_token,
    new_share_token,
)


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


class ShareTokenCipherTests(unittest.TestCase):
    def test_a_sealed_token_comes_back_unchanged(self) -> None:
        cipher = ShareTokenCipher("a-long-test-secret")
        token = new_share_token()
        self.assertEqual(cipher.decrypt(cipher.encrypt(token)), token)

    def test_the_token_is_not_recoverable_from_the_stored_value_alone(self) -> None:
        cipher = ShareTokenCipher("a-long-test-secret")
        token = new_share_token()
        sealed = cipher.encrypt(token)
        self.assertNotIn(token, sealed)
        # Sealing the same token twice must not produce the same row, or the
        # column would leak which links are duplicates of each other.
        self.assertNotEqual(sealed, cipher.encrypt(token))

    def test_another_secret_cannot_unseal_it(self) -> None:
        sealed = ShareTokenCipher("a-long-test-secret").encrypt(new_share_token())
        self.assertIsNone(ShareTokenCipher("a-different-secret").decrypt(sealed))

    def test_the_key_is_separate_from_the_one_that_signs_sessions(self) -> None:
        """Same secret, different purpose: a session token must not decrypt."""
        secret = "a-long-test-secret"
        session = TokenService("1234", secret, 60).issue()
        self.assertIsNone(ShareTokenCipher(secret).decrypt(session))

    def test_unreadable_values_are_none_rather_than_errors(self) -> None:
        cipher = ShareTokenCipher("a-long-test-secret")
        sealed = cipher.encrypt(new_share_token())
        for stored in (
            None,
            "",
            # Written before tokens were kept.
            "not-a-sealed-value",
            # Right prefix, unusable body.
            "v1:!!!!",
            "v1:",
            # A byte flipped in transit or in a partial restore.
            sealed[:-2] + ("aa" if not sealed.endswith("aa") else "bb"),
        ):
            with self.subTest(stored=stored):
                self.assertIsNone(cipher.decrypt(stored))

    def test_a_digest_is_not_a_sealed_token(self) -> None:
        """The two stored forms stay independent of each other.

        Resolution reads the digest and the panel reads the sealed copy; if
        either column ever held the other's value, nothing would silently
        accept it.
        """
        cipher = ShareTokenCipher("a-long-test-secret")
        token = new_share_token()
        digest = hash_share_token(token)
        self.assertNotEqual(digest, cipher.encrypt(token))
        self.assertIsNone(cipher.decrypt(digest))


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
