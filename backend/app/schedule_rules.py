"""Timezone-aware recurrence calculation, independent of transport and storage."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .models import ScheduleSpec


def utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def next_fire_time(spec: ScheduleSpec, after: datetime, *, anchor: datetime | None = None) -> datetime:
    """Return the first slot strictly after `after` without replaying old slots.

    Intervals retain their original phase. Calendar slots use local wall time;
    nonexistent DST times are skipped and a repeated time fires only once, at
    the first occurrence. All persisted instants are UTC.
    """
    after = after.astimezone(timezone.utc)
    if spec.kind == "interval":
        seconds = (spec.interval or 1) * (60 if spec.unit == "minutes" else 3600)
        origin = anchor.astimezone(timezone.utc) if anchor else after
        steps = max(1 if anchor is None else 0, int((after - origin).total_seconds() // seconds) + 1)
        return origin + timedelta(seconds=steps * seconds)

    zone = ZoneInfo(spec.timezone)
    local_date = after.astimezone(zone).date()
    for offset in range(15):
        day = local_date + timedelta(days=offset)
        if spec.kind == "weekly" and day.weekday() not in spec.weekdays:
            continue
        candidates = []
        for clock in spec.times:
            hour, minute = map(int, clock.split(":"))
            local = datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone, fold=0)
            instant = local.astimezone(timezone.utc)
            # Round-tripping detects a wall time lost during a forward jump.
            if instant.astimezone(zone).replace(tzinfo=None) != local.replace(tzinfo=None):
                continue
            if instant > after:
                candidates.append(instant)
        if candidates:
            return min(candidates)
    raise ValueError("无法计算下一次执行时间")
