# LaWAM local runtime corrections

`scripts/run_lawam_policy.sh` now runs `scripts/lawam_robot_client.py`.
The tracked adapter uses the installed LeRobot client without editing its
ignored checkout. A worktree without a virtualenv can select an existing
installation with `SUDS_PYTHON=/Users/nikhi/SUDS/.venv/bin/python`.
This does not change a dashboard running from another checkout.

## Fixed locally

- Merge incoming chunks without discarding pending future actions. Serialize
  queue merges with action execution so an in-flight action cannot be reinserted.
- Send observations with `must_go=True`: the current server's joint-similarity
  filter otherwise skips visually meaningful observations while joints barely
  move. Both upload and server queues still retain only the latest observation.
- Require the requested camera name; never substitute the first available feed.
  Preserve the camera publisher's existing RGB JPEG-byte convention.
- Fail the process on transport/watchdog/observation failure instead of reporting
  a completed rollout. Reject malformed and non-finite action chunks.
- Log queue starvation duration, incoming/stale action counts, and targets versus
  commands after safety limits. Save three exact raw pre-upload observations on
  the upload worker in `logs/lawam_inputs_*/input_*.npz` (RGB overhead/wrist arrays,
  state, joint names, task). These are before the server's resize/preprocessing.

Keep 24 actions and `max_relative_target=5`. Arm joint limits are in degrees;
the gripper limit is in normalized 0–100 units. Do not remove safety clamping to
hide disagreement between current positions and model targets.

## Verify without hardware or RunPod

```sh
/Users/nikhi/SUDS/.venv/bin/python scripts/test_lawam_robot_client.py
bash -n scripts/run_lawam_policy.sh
```

Tests use fake motors, camera packets and action chunks. They cover stale chunks,
overlap blending, the action/merge race, invalid actions, missing camera names,
RGB preservation, latest-observation delivery, saved inputs, and failure shutdown.
They do not prove smooth physical motion or model task competence.

## Remaining live evidence

Inspect the saved RGB arrays to confirm physical wrist/overhead identity; matching
index labels is insufficient and indices can change after reconnecting. After a
separately authorized GPU restart, `scripts/lawam_server_smoke.py` additionally
reports per-joint prediction error against recorded actions. This is a no-motion
diagnostic, not a pass/fail accuracy test. It cannot run while the GPU is stopped.

Historical empty queues establish pauses, but do not prove every pause came from
the corrected queue bugs. Network latency, server filtering and model behavior
still need a new end-to-end measurement. The 92-episode dataset's sufficiency
remains unproven; these local tests do not justify a retraining decision.
