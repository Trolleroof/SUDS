# SUDS — Development Environment Setup

Verified on Apple Silicon (arm64), macOS 26.5.1, 2026-08-28.

## Toolchain

| Component | Version |
|---|---|
| Homebrew | 6.0.16 |
| Git | 2.51.0 |
| uv | 0.11.1 |
| Python | 3.12.13 (venv, via uv) |
| ffmpeg | 8.1 (Homebrew) |
| LeRobot | 0.6.2 (editable clone) |
| PyTorch | 2.11.0 (MPS enabled) |
| torchcodec | 0.11.1 |

LeRobot 0.6.2 requires Python >= 3.12. The system Homebrew Python is 3.14,
which is too new for the pinned torch wheels — hence the pinned 3.12 venv.

## Reproducing from scratch

```bash
# 1. Prerequisites (already present on this machine)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git ffmpeg
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Clone LeRobot (gitignored; not a submodule)
cd /Users/nikhi/SUDS
git clone https://github.com/huggingface/lerobot.git

# 3. Create the env and install editable with the extras SUDS needs
uv venv --python 3.12 .venv
VIRTUAL_ENV=$PWD/.venv uv pip install -e "./lerobot[feetech,core_scripts,training]"
```

Extras explained:
- `feetech` — STS3215 servo SDK; the motors in the SO-101.
- `core_scripts` — pulls in `dataset`, `hardware`, `viz`; enables
  `lerobot-record` / `-replay` / `-calibrate` / `-teleoperate`.
- `training` — datasets + `wandb` + `accelerate` for imitation learning.

Add later as needed: `lerobot[smolvla]`, `lerobot[pi]`, `lerobot[diffusion]`
for those policy families; `lerobot[kinematics]` for IK (placo).

## Daily use

```bash
source /Users/nikhi/SUDS/.venv/bin/activate
lerobot-info          # environment report
```

## Verifying the install

```bash
python scripts/verify_env.py
```

Checks Python/arch, MPS matmul, the SO-101 and bimanual classes, the Feetech
bus, cameras, dataset + torchcodec, ACT policy, rerun, and builds a real
12-DoF `BiSOFollower` config (no hardware required).

## Bimanual naming (important)

In LeRobot 0.6.2 the SO-100/SO-101 modules are **unified**. Older tutorials
referencing `lerobot.robots.so101_follower` are out of date. Correct paths:

```python
from lerobot.robots.so_follower     import SO101Follower, SO101FollowerConfig
from lerobot.teleoperators.so_leader import SO101Leader,  SO101LeaderConfig
from lerobot.robots.bi_so_follower      import BiSOFollower, BiSOFollowerConfig
from lerobot.teleoperators.bi_so_leader import BiSOLeader,  BiSOLeaderConfig
```

`BiSOFollowerConfig` takes `left_arm_config=` / `right_arm_config=` (not
`left_arm=`). CLI types are `--robot.type=bi_so_follower` and
`--teleop.type=bi_so_leader`. The bimanual action space is 12 dims:
`{left,right}_` × `{shoulder_pan, shoulder_lift, elbow_flex, wrist_flex,
wrist_roll, gripper}.pos`.

## Next steps (hardware)

Not yet done — requires the arms to be physically connected:

```bash
lerobot-find-port      # run once per arm, unplug when prompted, to get /dev/tty.usbmodem*
lerobot-setup-motors   # assign servo IDs, one motor at a time
lerobot-calibrate      # per arm; record with --robot.id so calibration persists
lerobot-find-cameras   # enumerate camera indices for wrist/overhead views
```

Record each of the four arms' ports; on macOS they appear as
`/dev/tty.usbmodem*` and can change between reboots.

## Simulation (MuJoCo)

```bash
VIRTUAL_ENV=$PWD/.venv uv pip install mujoco          # 3.12.0
git clone --filter=blob:none --sparse --depth 1 \
  https://github.com/TheRobotStudio/SO-ARM100.git
cd SO-ARM100 && git sparse-checkout set Simulation/SO101   # ~21 MB
```

`SO-ARM100/` is gitignored like `lerobot/`. It supplies the SO-101 MJCF and
meshes; it is also the URDF source LeRobot's own `lerobot-find-joint-limits`
points at. The MJCF joint names match LeRobot's motor names 1:1 and in order,
so no remapping is needed.

### mjpython + uv Python: libpython3.12.dylib not loaded

MuJoCo's interactive viewer must run under `mjpython` on macOS. Out of the box
that fails here:

```
Library not loaded: @rpath/libpython3.12.dylib
```

`mjpython` is an app bundle, so it resolves `@rpath` against its own
`Contents/lib`, but uv keeps the dylib in its managed Python install. Nothing
in the search path bridges the two. (The VulkanSDK path that shows up in the
dyld "tried" list is a red herring — it is just the first entry of the
`DYLD_FALLBACK_LIBRARY_PATH` set in the shell profile, and is unrelated.)

Fix, and **re-run this after any `uv pip install` that reinstalls mujoco**:

```bash
UVP=$(.venv/bin/python -c 'import sysconfig;print(sysconfig.get_config_var("installed_base"))')
APP=".venv/lib/python3.12/site-packages/mujoco/MuJoCo_(mjpython).app/Contents"
mkdir -p "$APP/lib"
ln -sf "$UVP/lib/libpython3.12.dylib" "$APP/lib/libpython3.12.dylib"
```

Verify with `.venv/bin/mjpython -c "import mujoco; print('ok')"`.

Per-invocation alternative, if you would rather not touch `site-packages`:

```bash
DYLD_FALLBACK_LIBRARY_PATH="$UVP/lib" mjpython scripts/sim_leader.py
```

## Episode review dashboard

`dashboard/` is a Next.js app that reads a `LeRobotDataset` off disk and lets you
mark each episode pass/fail. See `dashboard/README.md`.

```bash
cd dashboard && npm install && npm run dev   # http://localhost:3117
```

Verdicts land in `datasets/<namespace>__<name>.labels.jsonl`, outside the dataset
directory so they survive a re-record. Generate a synthetic dataset to work
against before the arms exist:

```bash
python scripts/make_stub_dataset.py --repo-id suds/stub --episodes 8
```

Recording is driven from the dashboard by a daemon that owns the arm and the
dataset writer:

```bash
python scripts/record_server.py --repo-id suds/pick_sponge \
    --robot-port /dev/tty.usbmodemXXXX --teleop-port /dev/tty.usbmodemYYYY \
    --camera overhead=0 --camera wrist=1
python scripts/record_server.py --repo-id suds/dev --mock   # no hardware
```

Space starts and stops a take, backspace throws it away, enter commits it early.
Stopping holds the frames unwritten for a few seconds, so deleting a bad take is
free.

If you use `lerobot-record` directly instead, pass
`--dataset.rgb_encoder.vcodec=h264`; LeRobot's AV1 default only plays
in Safari on M3 and newer.

---

## Known benign warnings

- `objc[...]: Class AVFFrameReceiver is implemented in both ... libavdevice`
  — OpenCV, PyAV, and Homebrew ffmpeg each bundle libavdevice. Harmless
  duplicate-class notice on macOS; does not affect encode or decode.
- `[swscaler] No accelerated colorspace conversion found from yuv420p to
  rgb24` — informational; software conversion is used.
