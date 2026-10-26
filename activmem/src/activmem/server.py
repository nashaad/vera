"""One long-running ActivMem. Unix socket, one JSON object per line."""

from __future__ import annotations

import hashlib
import json
import socket
import socketserver
import tempfile
import threading
from pathlib import Path

from activmem.events import ActivMemError
from activmem.memory import ActivMem


def socket_path(root: str | Path) -> Path:
    """A short path. macOS refuses Unix sockets once the path exceeds 104 bytes."""
    home = Path(root) / ".activmem"
    home.mkdir(parents=True, exist_ok=True)
    pointer = home / "socket-path"
    if pointer.exists():
        return Path(pointer.read_text(encoding="utf-8").strip())
    digest = hashlib.sha256(str(home.resolve()).encode()).hexdigest()[:12]
    path = Path(tempfile.gettempdir()) / f"activmem-{digest}.sock"
    pointer.write_text(str(path), encoding="utf-8")
    return path


def try_call(root: str | Path, method: str, params: dict, timeout: float = 2.0) -> dict | None:
    """Return the server response, or None when no server is listening."""
    path = socket_path(root)
    if not path.exists():
        return None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(path))
            client.sendall((json.dumps({"method": method, "params": params}) + "\n").encode("utf-8"))
            chunks = []
            while True:
                piece = client.recv(65536)
                if not piece:
                    break
                chunks.append(piece)
                if b"\n" in piece:
                    break
        line = b"".join(chunks).split(b"\n", 1)[0]
        if not line:
            return None
        return json.loads(line.decode("utf-8"))
    except (OSError, json.JSONDecodeError, TimeoutError):
        return None


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        raw = self.rfile.readline()
        if not raw:
            return
        try:
            request = json.loads(raw.decode("utf-8"))
            result = self.server.dispatch(request.get("method"), request.get("params") or {})
            payload = {"ok": True, "result": result}
        except ActivMemError as exc:
            payload = {"ok": False, "error": str(exc)}
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        self.wfile.write((json.dumps(payload) + "\n").encode("utf-8"))


class _Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, path: Path, mem: ActivMem):
        self.mem = mem
        self._lock = threading.Lock()
        super().__init__(str(path), _Handler)

    def dispatch(self, method: str | None, params: dict):
        with self._lock:
            if method == "save_turn":
                user_id, reply_id = self.mem.save_turn(
                    params["user_text"],
                    params["reply_text"],
                    params["session"],
                    learned_at=params.get("learned_at"),
                )
                return {"user_id": user_id, "reply_id": reply_id}
            if method == "recall":
                result = self.mem.recall(
                    params["question"],
                    k=params.get("k"),
                    seeds=params.get("seeds", "both"),
                    explain=bool(params.get("explain")),
                    carry=params.get("carry"),
                )
                return result.to_dict()
            if method == "context_for":
                return self.mem.context_for(
                    params.get("session") or "",
                    params.get("next_message") or "",
                    k=params.get("k"),
                )
            if method == "annotate" or method == "revise":
                new_id = self.mem.revise(
                    params.get("new_item") or params.get("from"),
                    params.get("old_item") or params.get("to"),
                    actor=params.get("actor") or "vera",
                    session=params.get("session"),
                )
                return {"new_id": new_id, "old_id": params.get("old_item") or params.get("to")}
            if method == "forget":
                self.mem.forget(params["item"], actor=params.get("actor") or "nash")
                return {"forgot": params["item"]}
            if method == "stats":
                return self.mem.stats()
            raise ActivMemError(f"unknown method: {method}")


def serve(root: str | Path, *, force: bool = False) -> int:
    path = socket_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    mem = ActivMem(root, force=force)
    server = _Server(path, mem)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        mem.close()
        if path.exists():
            path.unlink()
    return 0
