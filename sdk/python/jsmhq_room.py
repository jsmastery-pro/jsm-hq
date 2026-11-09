"""My HQ project-room client. Standard library only; copy this file into your project.

It never raises: if My HQ isn't running (or the token is wrong) your project keeps working and
nothing shows in the office.

    from jsmhq_room import Room

    room = Room()  # reads HQ_ROOM_URL and HQ_ROOM_TOKEN (shown in My HQ: Settings -> Team -> Project room)
    room.setup("Job referrals", [
        {"id": "fetcher", "name": "Mailbot", "kind": "fetcher"},
        {"id": "writer", "name": "Quill", "kind": "writer"},
        {"id": "sender", "name": "Postie", "kind": "sender"},
    ])

    with room.working("fetcher", "Fetching 12 emails"):
        emails = fetch_emails()
    room.handoff("writer", frm="fetcher")  # an envelope flies to the writer
"""

import contextlib
import json
import os
import urllib.request

__all__ = ["Room"]


class Room:
    def __init__(self, url=None, token=None, timeout=1.0):
        self.url = (url or os.environ.get("HQ_ROOM_URL") or "http://127.0.0.1:7420").rstrip("/")
        self.token = token or os.environ.get("HQ_ROOM_TOKEN", "")
        self.timeout = timeout

    def _call(self, method, path, body=None):
        try:
            req = urllib.request.Request(
                self.url + path,
                data=None if body is None else json.dumps(body).encode(),
                method=method,
                headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read() or b"{}")
        except Exception:
            return None  # My HQ isn't there: carry on

    def setup(self, name, workers, demo=False):
        """Creates or replaces the room. workers: [{"id", "name", "kind": fetcher|writer|sender|custom, "color"?}].
        demo=False stops the demo animation (real events drive the room)."""
        return self._call("PUT", "/room", {"name": name, "workers": workers, **({} if demo else {"demo": False})})

    def status(self, worker, state="working", note=None, ttl=None):
        """Tells My HQ what a worker is doing: state is idle, working, error or done. It holds for `ttl`
        seconds (default 120, 8 for done), then the worker goes back to idle."""
        body = {"worker": worker, "state": state}
        if note:
            body["note"] = note
        if ttl:
            body["ttl"] = ttl
        return self._call("POST", "/room/event", body)

    def handoff(self, to, frm=None):
        """An envelope flies from one worker (or "in", the in-tray) to another (or "out", the out-tray)."""
        h = {"to": to}
        if frm is not None:
            h["from"] = frm
        return self._call("POST", "/room/event", {"handoff": h})

    def idle(self, worker):
        return self.status(worker, "idle")

    def error(self, worker, note=None):
        return self.status(worker, "error", note)

    @contextlib.contextmanager
    def working(self, worker, note=None):
        """Working while the block runs; done afterwards, or error if it raises."""
        self.status(worker, "working", note)
        try:
            yield
        except BaseException:
            self.status(worker, "error", note or "Failed")
            raise
        else:
            self.status(worker, "done", note)
