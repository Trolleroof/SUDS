#!/usr/bin/env python
from record_server import TRAINING_CAMERAS, recorder_data_issues


def main() -> None:
    # The contract comes from config/cameras.json, not a copy of it here.
    assert set(TRAINING_CAMERAS) == {"wrist", "overhead"}, TRAINING_CAMERAS
    good = recorder_data_issues(
        "pick up the yellow sponge", 30, 30, dict(TRAINING_CAMERAS), {"wrist", "overhead"}, {"wrist": True, "overhead": True}
    )
    assert good == []
    crossed = {"wrist": TRAINING_CAMERAS["overhead"], "overhead": TRAINING_CAMERAS["wrist"]}
    assert any("camera labels must be" in issue for issue in recorder_data_issues(
        "pick up the yellow sponge", 30, 30, crossed, {"wrist", "overhead"}, {"wrist": True, "overhead": True}
    ))
    assert "no fresh frames" in recorder_data_issues("wrong", 30, 20, {}, set(), {"wrist": False})[-1]


if __name__ == "__main__":
    main()
