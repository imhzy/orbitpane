"""Web Push delivery (including iOS PWA subscriptions served by APNs)."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from .config import Settings
from .database import Database
from .models import PushEndpoint

logger = logging.getLogger(__name__)


class PushNotifications:
    def __init__(self, settings: Settings, database: Database):
        self.database = database
        self.subject = settings.push_vapid_subject
        self.vapid = None
        self.public_key = ""
        if not settings.push_vapid_private_key:
            return
        try:
            subject = urlsplit(self.subject)
            if not ((subject.scheme == "mailto" and "@" in subject.path)
                    or (subject.scheme == "https" and subject.hostname
                        and subject.hostname != "localhost" and not subject.username)):
                raise ValueError()
            # Decode key material ourselves: a configuration value must never
            # be interpreted by py-vapid as an arbitrary filesystem path.
            key = serialization.load_der_private_key(
                base64.urlsafe_b64decode(settings.push_vapid_private_key + "=="), password=None,
            )
            if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
                raise ValueError()
            self.vapid = Vapid(private_key=key)
            self.public_key = base64.urlsafe_b64encode(key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint,
            )).decode().rstrip("=")
        except Exception:
            raise RuntimeError("Invalid Web Push VAPID key or subject configuration") from None

    @property
    def enabled(self) -> bool:
        return self.vapid is not None

    def deliver(self, delivery: dict) -> None:
        endpoint = delivery["endpoint"]
        retry = False
        try:
            PushEndpoint(endpoint=endpoint)
            with requests.Session() as session:
                # Do not let a push service redirect the server to an arbitrary
                # destination. Neither endpoints nor exception bodies are logged.
                session.max_redirects = 0
                webpush(
                    subscription_info={"endpoint": endpoint, "keys": {
                        "p256dh": delivery["p256dh"], "auth": delivery["auth"],
                    }},
                    data=json.dumps({
                        "title": "OrbitPane · 定时任务失败" if delivery.get("status") == "failed" else "OrbitPane · 任务完成",
                        "body": "任务执行失败，点击查看详情。" if delivery.get("status") == "failed" else "任务已完成，点击查看结果。",
                        "url": f"/?id={delivery['conversation_id']}",
                        "tag": f"orbitpane-{delivery['run_id']}",
                    }, ensure_ascii=False),
                    vapid_private_key=self.vapid,
                    # pywebpush mutates claims; never share them across sends.
                    vapid_claims={"sub": self.subject},
                    content_encoding="aes128gcm", ttl=86400, timeout=10,
                    headers={"Urgency": "normal"}, requests_session=session,
                )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):
                self.database.delete_push_subscription(endpoint)
            else:
                retry = status is None or status == 429 or status >= 500
                logger.warning("Web Push delivery rejected (status=%s)", status)
        except requests.RequestException:
            retry = True
            logger.warning("Web Push service temporarily unreachable")
        except Exception:
            logger.warning("Web Push delivery failed validation or encryption")
        self.database.finish_push_delivery(delivery["run_id"], endpoint, retry=retry)

    async def run(self) -> None:
        if not self.enabled:
            return
        while True:
            try:
                deliveries = await asyncio.to_thread(self.database.pending_push_deliveries, self.public_key)
                # A bounded batch keeps push I/O from exhausting the shared pool.
                await asyncio.gather(*(asyncio.to_thread(self.deliver, item) for item in deliveries))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Web Push delivery queue unavailable; retrying")
            await asyncio.sleep(2)
