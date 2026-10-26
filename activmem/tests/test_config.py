from activmem.config import load_config
from activmem.memory import ActivMem


def test_config_file_overrides_and_merges_weights(tmp_path):
    home = tmp_path / ".activmem"
    home.mkdir()
    (home / "config.toml").write_text(
        "\n".join(
            [
                "threshold = 0.2",
                "steps = 2",
                "",
                "[weights]",
                "mentioned_by = 0.0",
                "",
            ]
        ),
        encoding="utf-8",
    )
    mem = ActivMem(tmp_path)
    assert mem.config.threshold == 0.2
    assert mem.config.steps == 2
    assert mem.config.weights["mentioned_by"] == 0.0
    assert mem.config.weights["mentions"] == 1.0
    assert load_config(home / "missing.toml").steps == 4
    mem.close()


def test_zero_mentioned_by_blocks_recall(tmp_path):
    home = tmp_path / ".activmem"
    home.mkdir()
    (home / "config.toml").write_text(
        "\n".join(
            [
                "[weights]",
                "mentions = 0",
                "mentioned_by = 0",
                "next = 0",
                "previous = 0",
                "",
            ]
        ),
        encoding="utf-8",
    )
    mem = ActivMem(tmp_path)
    mem.save("Halibut is my favourite fish.", actor="nash")
    result = mem.recall("What fish do I like?")
    assert result.results == []
    assert "fish" not in result.no_record_of
    mem.close()
