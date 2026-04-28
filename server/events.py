from __future__ import annotations

import json
import threading
import time
from collections import deque
from typing import Any


_condition = threading.Condition()
_events: deque[dict[str, Any]] = deque(maxlen=512)
_version = 0


def publish(event_type: str, workspace_id: str | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    global _version
    with _condition:
        _version += 1
        event = {
            "id": _version,
            "type": event_type,
            "workspaceId": workspace_id,
            "payload": payload or {},
            "createdAt": time.time(),
        }
        _events.append(event)
        _condition.notify_all()
        return event


def stream(workspace_id: str | None = None):
    last_seen = 0
    yield ": connected\n\n"
    while True:
        with _condition:
            _condition.wait_for(lambda: _version > last_seen, timeout=20)
            pending = [event for event in _events if event["id"] > last_seen]
            if not pending:
                yield ": keepalive\n\n"
                continue
            last_seen = pending[-1]["id"]

        for event in pending:
            if workspace_id and event["workspaceId"] not in {None, workspace_id}:
                continue
            data = json.dumps(event, separators=(",", ":"))
            yield f"id: {event['id']}\nevent: {event['type']}\ndata: {data}\n\n"
