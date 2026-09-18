# Fine-tuning runbook: GR00T N1.7

The base checkpoint for every SUDS condition is
[`nvidia/GR00T-N1.7-3B`](https://huggingface.co/nvidia/GR00T-N1.7-3B) (3.1B
parameters), fine-tuned through `lerobot-train` with `--policy.type=groot`.

Hold it fixed across all eight conditions. The data-efficiency curve in
[`idea.md`](../idea.md) only means something if the base, camera inputs, action
representation, and training budget are identical between budgets.

## Why GR00T

`embodiment_tag` defaults to `new_embodiment`, the path for arms the model was
never trained on — and LeRobot's own GR00T docs name SO-101 as the example for
that flag. Three consequences that make this simpler than the alternatives:

- **No joint-convention remap.** GR00T normalizes state and action internally
  (min/max with q01/q99 percentiles, per embodiment) from *this* dataset's
  statistics. There is no pretrained joint frame to reconcile against.
- **No camera slot contract.** Image sizing is handled by the Qwen3-VL backbone's
  own image processor. No renaming to fixed `top`/`side` slots, no letterboxing.
- **Backbone frozen by default.** `tune_llm=False` and `tune_visual=False`; only
  the projector and the flow-matching diffusion head train
  (`tune_projector=True`, `tune_diffusion_model=True`).

State and action are padded into a fixed 132-dim vector, so the 6-dim SO-101
layout needs no adaptation.

### Rejected alternatives

**Isaac 0.5** cannot be fine-tuned for SO-101 at all. Its LeRobot integration
contains an `so100_so101` profile, but the released weights do not carry the
sidecars it needs: `policy_inference_recipe.json` has zero `so100`/`so101`
entries, and of the 737 datasets in `policy_state_contracts.json` only
`molmoact2_bimanualyam` and `libero` are deployment profiles — none 6-dim.
`lerobot-isaac-import` hard-validates an exact
`(policy_state_dataset, normalization_scope, objective)` match against those
hash-bound files, and there is no new-embodiment path anywhere in the package.

**MolmoAct2-SO100_101** (5.44B) is the fallback. It is the only base with
SO-101-native weights, but it needs the joint-convention adapter
(`signs=[1,-1,1,1,1,1]`, `offsets=[0,90,90,0,0,0]`), fixed `top`/`side` camera
slots, and the released `norm_stats.json`. Run `scripts/preflight.py --policy
molmoact2` before considering it — that mode compares this dataset's joint ranges
against the base's training distribution.

## Hardware

One NVIDIA GPU. Apple Silicon is not an option — the policy is CUDA-only.

LeRobot publishes no VRAM figure for GR00T N1.7, so this was measured directly
on an A100-SXM4-40GB (vast.ai, $0.75/hr) with the sanity config below:

| batch | peak VRAM | throughput |
| ----: | --------: | ---------- |
| 4     | **35.9 GB** of 40 | 2.86 step/s, 12 samples/s |

Batch 4 leaves 4GB of headroom, so **40GB caps this config at batch 4**. At that
rate a 20,000-step run takes about 1.9 hours.

The docs' own SO-101 example uses batch 64, and LeRobot's guidance for small
real-world datasets is a global batch of 16-32 — so batch 4 is below the
intended range. Two ways up:

- **An 80GB card** (~$1.06/hr) fits a larger batch natively. Roughly $17 for all
  eight conditions at ~2h each, versus $12 on 40GB at batch 4.
- **Gradient accumulation** on the 40GB card
  (`--accelerator.gradient_accumulation.steps=4` for an effective batch of 16)
  costs no extra memory but multiplies wall-clock time by about 4.

The 80GB card is both faster and barely more expensive. Whichever you pick,
measure the real ceiling once and then keep that batch size identical across all
eight conditions.

### Environment gotchas (both hit on a clean box)

- The `vastai/pytorch` image ships **Python 3.10**; lerobot 0.6.2 requires
  **>=3.12**. Build a separate venv: `uv venv --python 3.12 /root/lr`.
- GR00T N1.7's backbone is **`nvidia/Cosmos-Reason2-2B`**, named in the
  checkpoint's own `config.json` (`model_name`). It is a **gated** repo: accept
  the licence on its model page, then `hf auth login --token ...` on the box, or
  the policy fails to load after the 3B download has already succeeded.

## 1. Prepare the data (already done, local)

```bash
python scripts/preflight.py  # checks suds/live_2_corrected by default
```

The corrected snapshot retains the 46 passed episodes, fixes the switched camera
labels, and uses the task `pick up the yellow sponge`. The exact pool is stored in
`datasets/suds__live_2.policy_train.json`.

`preflight.py` currently passes every check with no warnings.

## 2. Set up the GPU box

```bash
pip install "lerobot[groot]" "lerobot[training]"
hf auth login
wandb login
```

Copy the dataset to the box at `~/.cache/huggingface/lerobot/suds/live_2_corrected`, or
point `--dataset.root` wherever it lands.

GR00T N1.5 is **removed** from LeRobot; N1.5 checkpoints and configs are rejected
with a migration note. Use N1.7.

## 3. Sanity run first (20 steps)

Same precision and batch size as the real run. This catches feature, decoder and
memory errors in minutes instead of hours.

```bash
lerobot-train \
  --dataset.repo_id=suds/live_2 \
  --dataset.root=$HOME/.cache/huggingface/lerobot/suds/live_2_corrected \
  --dataset.episodes='[19,22,24,39,45]' \
  --dataset.image_transforms.enable=true \
  --policy.type=groot \
  --policy.device=cuda \
  --policy.base_model_path=nvidia/GR00T-N1.7-3B \
  --policy.embodiment_tag=new_embodiment \
  --policy.chunk_size=16 \
  --policy.n_action_steps=16 \
  --policy.use_relative_actions=true \
  --policy.relative_exclude_joints='["gripper"]' \
  --policy.use_bf16=true \
  --policy.push_to_hub=false \
  --seed=42 \
  --batch_size=16 \
  --steps=20 \
  --save_checkpoint=false \
  --env_eval_freq=0 --eval_steps=0 --log_freq=1 \
  --output_dir=outputs/train/groot_sanity \
  --job_name=groot_sanity
```

If the GPU has headroom at batch 16, raise it before the real run — and then keep
that value identical across all eight conditions.

## 4. Real run, per condition

For the next full-data policy, train on all 46 corrected, accepted episodes:

```bash
  --dataset.root=$HOME/.cache/huggingface/lerobot/suds/live_2_corrected \
  --dataset.episodes='[1,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,24,25,28,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,51,52,53]' \
  --steps=20000 \
  --batch_size=32 \
  --save_checkpoint=true --save_freq=5000 \
  --use_policy_training_preset=true \
  --wandb.enable=true --wandb.disable_artifact=true \
  --output_dir=outputs/train/groot_real46 \
  --job_name=groot_real46
```

For the data-scaling experiment, swap `--dataset.episodes` for a frozen subset:

```bash
  --dataset.episodes='[1,5,6,12,15,16,19,20,21,22,24,31,33,37,39,42,43,45,47,48]' \
  --steps=20000 \
  --batch_size=32 \
  --save_checkpoint=true --save_freq=5000 \
  --use_policy_training_preset=true \
  --wandb.enable=true --wandb.disable_artifact=true \
  --output_dir=outputs/train/groot_real20 \
  --job_name=groot_real20
```

`use_relative_actions=true` with the gripper excluded is what LeRobot's SO-101
example uses: arm joints are predicted as deltas, the gripper as an absolute
position. Keep it identical across conditions — switching action representation
mid-study invalidates the curve.

Run `--steps` identically across every condition. A budget comparison where the
40-demo run also trained longer measures nothing.

The 5-demo condition trains on roughly 3,600 frames. Expect it to be weak; that
is the point of the curve, not a bug to tune away.

## 5. Run a trained policy on the arm

GR00T is CUDA-only, so the policy cannot run on the Mac the arm is plugged into.
LeRobot's async inference splits it: a **policy server** holds the model on the
GPU box, a **robot client** on the Mac owns the serial port and the cameras, and
they exchange observations and action chunks over gRPC.

The vast.ai instance exposes only SSH, so tunnel the gRPC port rather than
opening a new one.

**Safety first.** The arm moves on its own from the first chunk. Clear the
workspace, keep a hand on the e-stop, and start with the arm already near its
rest pose.

```bash
# 1. on the GPU box: install the async extra, then serve
ssh -p <port> root@<ip> '/root/lr/bin/python -m uv pip install "lerobot[async]"'
ssh -p <port> root@<ip> '/root/lr/bin/python -m lerobot.async_inference.policy_server \
    --host=127.0.0.1 --port=8080'

# 2. on the Mac: tunnel 8080 to the box (leave running)
ssh -N -L 8080:127.0.0.1:8080 -p <port> root@<ip>

# 3. on the Mac: install async deps once
VIRTUAL_ENV=$PWD/.venv uv pip install "lerobot[async]"

# 4. on the Mac: start the robot client
.venv/bin/python -m lerobot.async_inference.robot_client \
  --server_address=127.0.0.1:8080 \
  --robot.type=so_follower \
  --robot.port=/dev/tty.usbmodem5C821094831 \
  --robot.id=follower \
  --robot.cameras="{ wrist: {type: opencv, index_or_path: 1, width: 640, height: 480, fps: 30}, overhead: {type: opencv, index_or_path: 0, width: 640, height: 480, fps: 30}}" \
  --task="pick up block" \
  --policy_type=groot \
  --pretrained_name_or_path=/root/outputs/train/groot_real20/checkpoints/020000/pretrained_model \
  --policy_device=cuda \
  --actions_per_chunk=16 \
  --chunk_size_threshold=0.5 \
  --aggregate_fn_name=weighted_average \
  --debug_visualize_queue_size=True
```

The values above are this cell's, not placeholders: `so_follower` is the robot
type in lerobot 0.6.2 (it unified SO-100/SO-101), `follower` is the calibration
id under `calibration/robots/so_follower/`, the port comes from
`config/arms.json`, the camera indices from `config/cameras.json`, and the task
string is the one recorded in the dataset's `tasks.parquet`.

Camera **keys** must match the dataset feature names — `wrist` and `overhead`
map to `observation.images.wrist` / `observation.images.overhead`. Renaming them
here silently feeds the policy its cameras in the wrong slots.

### Latency is the real constraint

Measured round trip from this cell to the Slovenia box: **~390 ms**.

A 16-action chunk at 30fps is 533 ms of motion. With
`chunk_size_threshold=0.5` the client requests the next chunk when ~266 ms of
buffer remain — less than one round trip, before GR00T's own inference time. The
arm will run its queue dry and stutter between chunks.

That is fine for the first functional test (does the policy reach for the right
thing?) but it corrupts **time-to-completion**, which `idea.md` records as a
scored metric. Options, in order of preference:

1. A local NVIDIA GPU on the same LAN as the arm — removes the problem.
2. A rented GPU in the nearest region, re-measuring RTT before trusting it.
3. Raising `--chunk_size_threshold` toward 0.9 so the client asks earlier. This
   buys buffer but increases the overlap that `aggregate_fn_name` has to blend.

Watch `--debug_visualize_queue_size=True`: if the queue repeatedly hits zero,
the policy is starved and any timing measurement from that session is invalid.

## 6. Evaluate

Training loss is not a success metric. The headline number comes only from unseen
physical trials on placements never trained on, scored with the rubric in
`idea.md`: every marked rinse region visited, no tray or holder contact, rest
pose reached. Record success, collision, time-to-completion and failure category.
Simulated data may train a policy and help pick variants; it never enters the
physical evaluation set.

## UMI-style passive gripper capture

Keep handheld captures in a new dataset; do not append them directly to
`suds/live_2_corrected`. That dataset's GR00T contract is two 30 FPS camera
streams plus the six SO-101 values named in `scripts/preflight.py`.

The offline conversion path is:

```text
wrist video -> ORB-SLAM3 camera_trajectory.csv -> scripts/umi_slam_sidecar.py
jaw ArUco markers -> scripts/gripper_vision.py -> open/closed/unknown
TCP pose + gripper state -> SO-101 inverse kinematics -> six joint/gripper values
six values + wrist/overhead frames -> LeRobot v3 dataset -> scripts/preflight.py
```

Use the official UMI ORB-SLAM3 pipeline to produce `camera_trajectory.csv`.
`umi_slam_sidecar.py` applies measured `base_from_slam` and `camera_to_tcp`
transforms and emits metric TCP position plus rotation-vector columns. Raw SLAM
coordinates are diagnostic sidecar data, not GR00T state/action values.

The conversion is trainable only after every TCP pose has a continuous,
in-bounds SO-101 IK solution. Write those solved values under the existing names:

```text
shoulder_pan.pos, shoulder_lift.pos, elbow_flex.pos,
wrist_flex.pos, wrist_roll.pos, gripper.pos
```

Then retain the current GR00T options: `new_embodiment`, 30 FPS,
`use_relative_actions=true`, and `relative_exclude_joints=["gripper"]`.
`scripts/preflight.py` remains the final format gate.

Physical calibration still required: camera intrinsics, a fixed metric world
marker for `base_from_slam`, the measured camera-to-gripper-tip transform, and
two jaw markers visible in fully-open and fully-closed reference frames. A
monocular camera without a metric marker or IMU has unknown translation scale
and cannot safely generate SO-101 joint targets.
