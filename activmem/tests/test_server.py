import threading
import time

from activmem.memory import ActivMem
from activmem.server import _Server, socket_path, try_call


def test_round_trip_and_revise(tmp_path):
    mem = ActivMem(tmp_path)
    server = _Server(socket_path(tmp_path), mem)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        saved = try_call(tmp_path, "save_turn", {
            "user_text": "I really like pollock.",
            "reply_text": "Noted.",
            "session": "s1",
        })
        assert saved and saved["ok"]
        user_id = saved["result"]["user_id"]
        revised = try_call(tmp_path, "revise", {
            "new_item": "sike, I don't",
            "old_item": user_id,
            "actor": "vera",
            "session": "s1",
        })
        assert revised and revised["ok"]
        try_call(tmp_path, "save_turn", {
            "user_text": "Halibut is my favourite fish.",
            "reply_text": "Sounds good.",
            "session": "s3",
        })
        recalled = try_call(tmp_path, "recall", {"question": "What fish do I like?", "k": 5})
        assert recalled and recalled["ok"]
        texts = [hit["text"] for hit in recalled["result"]["results"]]
        suppressed = recalled["result"]["suppressed"]
        assert any("Halibut" in text for text in texts)
        assert all("pollock" not in text.lower() for text in texts)
        assert any("sike" in hit["revising_text"].lower() for hit in suppressed)
    finally:
        server.shutdown()
        mem.close()


def test_missing_server_times_out_quickly(tmp_path):
    started = time.perf_counter()
    assert try_call(tmp_path, "recall", {"question": "hello"}, timeout=0.3) is None
    assert time.perf_counter() - started < 0.5
