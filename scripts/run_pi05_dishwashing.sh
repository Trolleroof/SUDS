#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$repo_root/datasets/suds__live_2.policy_train.json"
mode="${1:-}"
if [[ "$#" -eq 0 || "$#" -gt 2 || ( "$#" -eq 2 && "$2" != "--dry-run" ) ]]; then
  echo "Usage: $0 {train|server|client} [--dry-run]" >&2
  exit 2
fi
dry_run="${2:-}"
lerobot_bin="${SUDS_PI05_BIN:-$repo_root/.venv-pi05/bin}"

case "$mode" in
  train)
    dataset_root="${SUDS_PI05_DATASET_ROOT:-$HOME/.cache/huggingface/lerobot/suds/live_2_corrected}"
    episodes="$(jq -ce '.episodes | select(length > 0)' "$manifest")"
    if [[ -z "$dry_run" ]]; then
      if [[ ! -f "$dataset_root/meta/info.json" || ! -f "$dataset_root/meta/stats.json" ]]; then
        echo "Corrected dataset metadata is missing at $dataset_root. Set SUDS_PI05_DATASET_ROOT." >&2
        exit 2
      fi
      python3 "$repo_root/scripts/preflight.py" --policy pi05 --root "$dataset_root"
    fi
    args=("$lerobot_bin/lerobot-train"
      --dataset.repo_id=suds/live_2_corrected
      --dataset.root="$dataset_root"
      --dataset.episodes="$episodes"
      --dataset.video_backend=pyav
      --policy.type=pi05
      --policy.pretrained_path=lerobot/pi05_base
      --policy.use_relative_actions=false
      --policy.gradient_checkpointing=true
      --policy.dtype=bfloat16
      --policy.device=cuda
      --policy.push_to_hub=false
      --steps="${SUDS_PI05_STEPS:-20000}"
      --batch_size="${SUDS_PI05_BATCH_SIZE:-4}"
      --save_freq=5000
      --output_dir="${SUDS_PI05_OUTPUT_DIR:-$repo_root/outputs/train/pi05_dishwashing}"
      --job_name=pi05_dishwashing)
    ;;
  server)
    checkpoint="${SUDS_PI05_CHECKPOINT:-}"
    if [[ -z "$checkpoint" ]]; then
      echo "Set SUDS_PI05_CHECKPOINT to the fine-tuned π₀.₅ pretrained_model directory or Hub ID." >&2
      exit 2
    fi
    args=("$lerobot_bin/lerobot-policy-server"
      --config_path="$repo_root/config/pi05_dishwashing_server.yaml"
      --model.repo_or_path="$checkpoint")
    if [[ -n "${SUDS_PI05_CHECKPOINT_REVISION:-}" ]]; then
      args+=(--model.revision="$SUDS_PI05_CHECKPOINT_REVISION")
    fi
    ;;
  client)
    if [[ -z "$dry_run" && "${SUDS_ENABLE_POLICY:-0}" != "1" ]]; then
      echo "Set SUDS_ENABLE_POLICY=1 after clearing the workspace and reaching the e-stop." >&2
      exit 2
    fi
    follower_port="${SUDS_FOLLOWER_PORT:-$(jq -er '.follower' "$repo_root/config/arms.json")}"
    cameras="$(jq -ce '
      {wrist, overhead}
      | select(all(.[]; type == "number" and . >= 0 and floor == .) and .wrist != .overhead)
      | map_values({type:"opencv", index_or_path:., width:640, height:480, fps:30, color_mode:"rgb"})
    ' "$repo_root/config/cameras.json")"
    task="$(jq -er '.task' "$manifest")"
    args=("$lerobot_bin/lerobot-rollout"
      --strategy.type=base
      --inference.type=remote
      --inference.endpoint=tcp/127.0.0.1:7447
      --inference.deployment=suds-pi05
      --inference.mode=rtc_guided
      --inference.semantics=so101-degrees-gripper-percent-v1
      --robot.type=so101_follower
      --robot.port="$follower_port"
      --robot.id=follower
      --robot.use_degrees=true
      --robot.max_relative_target=5
      --robot.cameras="$cameras"
      --fps=30
      --task="$task"
      --duration=30
      --interactive=true)
    ;;
  *)
    echo "Unknown mode: $mode. Use train, server, or client." >&2
    exit 2
    ;;
esac

if [[ -n "$dry_run" ]]; then
  printf '%q ' "${args[@]}"
  printf '\n'
else
  exec "${args[@]}"
fi
