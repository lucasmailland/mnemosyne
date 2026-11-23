#!/usr/bin/env python3
# SS02 — bounded SubagentStop payload reader (SS01 contract). Text is
# last_assistant_message; agent_transcript_path is never opened. Error codes carry no content.
import json
import sys

MAX_INPUT_BYTES = 256 * 1024
MAX_TEXT_CHARS = 64 * 1024
EVENT = "SubagentStop"


def _err(code):
    return {"ok": False, "code": code}


def read_payload(raw):
    if len(raw.encode("utf-8", "replace")) > MAX_INPUT_BYTES:
        return _err("oversize")
    if not raw.strip():
        return _err("empty")
    try:
        payload = json.loads(raw)
    except ValueError:
        return _err("invalid_json")
    if not isinstance(payload, dict):
        return _err("unknown_payload")
    if payload.get("hook_event_name") != EVENT:
        return _err("wrong_event")
    ids = [payload.get("session_id"), payload.get("agent_id")]
    if not all(isinstance(i, str) and i for i in ids):
        return _err("unknown_payload")
    text = payload.get("last_assistant_message")
    if not isinstance(text, str) or not text.strip():
        return _err("no_visible_text")
    if len(text) > MAX_TEXT_CHARS:
        return _err("oversize")
    return {"ok": True, "session_id": ids[0], "agent_id": ids[1], "text": text}


if __name__ == "__main__":
    print(json.dumps(read_payload(sys.stdin.read(MAX_INPUT_BYTES + 1))))
