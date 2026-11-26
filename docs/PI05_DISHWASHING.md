# π₀.₅ dishwashing rollout with guided RTC

This rollout uses the corrected `suds/live_2_corrected` recordings for
`pick up the yellow sponge`. The task, two camera names, 30 Hz cadence and six
absolute SO-101 actions carry through training and deployment. Guided RTC
conditions each prediction on the still-relevant part of the previous chunk.
The initial server configuration uses a 15-step exponential prefix schedule
and a guidance weight of 10. These are starting values for latency testing.
[LeRobot RTC documentation](https://huggingface.co/docs/lerobot/rtc)

## Install

Use a separate LeRobot checkout and environment for π₀.₅ on both the GPU and
robot hosts. The split rollout uses the Zenoh policy server.

```bash
# From the SUDS checkout on each host
suds="$PWD"
git clone https://github.com/huggingface/lerobot.git "$HOME/lerobot-pi05"
cd "$HOME/lerobot-pi05"
git checkout b07adcc5e3ce42c26a248236dbb3571f84c28c43

# GPU host
UV_PROJECT_ENVIRONMENT="$suds/.venv-pi05" uv sync --locked \
  --extra core_scripts --extra remote --extra training --extra pi

# Robot host
UV_PROJECT_ENVIRONMENT="$suds/.venv-pi05" uv sync --locked \
  --extra core_scripts --extra remote --extra feetech
cd "$suds"
```

The launcher uses `jq` to read the rig and dataset files. Use `SUDS_PI05_BIN`
if the LeRobot executables live in a different environment.

## Train and check server readiness

Copy the corrected dataset to the GPU host. Its state and action statistics
need `q01` and `q99` for π₀.₅'s default quantile normalization.
The launcher reads the 46 accepted episode IDs from the checked-in manifest.

```bash
SUDS_PI05_DATASET_ROOT=/path/to/live_2_corrected scripts/run_pi05_dishwashing.sh train

SUDS_PI05_CHECKPOINT="$PWD/outputs/train/pi05_dishwashing/checkpoints/last/pretrained_model" \
  scripts/run_pi05_dishwashing.sh server
```

An existing π₀.₅ checkpoint needs the same camera names, joint ordering and
units. Set `SUDS_PI05_CHECKPOINT_REVISION` to pin a Hub checkpoint. Wait for
`Policy server ready` after warmup. The server binds to loopback.

## Connect the robot

From the robot host, keep this SSH tunnel running while the client is active.
Use the SSH address and port for the GPU host.

```bash
ssh -o ExitOnForwardFailure=yes -N -L 7447:127.0.0.1:7447 user@gpu-host
```

Stop recording, teleop, and dashboard or camera processes that own the arm or
cameras before starting the client. Check that `config/cameras.json` points
`wrist` to the close gripper view and `overhead` to the wide workspace view.
Use the follower's existing calibration and confirm that the dataset uses
body joint degrees and the 0–100 gripper convention.

```bash
SUDS_ENABLE_POLICY=1 scripts/run_pi05_dishwashing.sh client
```

The client waits for `/start`, limits the rollout to 30 seconds, and keeps the
rig's existing relative target clamp. Use `/stop` to end the session. Inspect
the rollout logs for turnaround, overlap, and starvation before tuning the
15-step horizon. Add `--dry-run` after any launcher mode to print its command
without opening cameras, connecting the arm or loading the model.
[LeRobot remote inference guide](https://huggingface.co/docs/lerobot/remote_inference)
