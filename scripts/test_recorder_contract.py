#!/usr/bin/env python
from record_server import recorder_data_issues


def main() -> None:
    good = recorder_data_issues(
        "pick up the yellow sponge", 30, 30, {"wrist": 0, "overhead": 1}, {"wrist", "overhead"}, {"wrist": True, "overhead": True}
    )
    assert good == []
    assert "no fresh frames" in recorder_data_issues("wrong", 30, 20, {}, set(), {"wrist": False})[-1]


if __name__ == "__main__":
    main()
