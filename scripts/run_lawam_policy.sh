#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
variant="${1:-finetuned}"
dashboard_url="${SUDS_DASHBOARD_URL:-http://127.0.0.1:3117}"
gpu_host="${SUDS_GPU_HOST:-195.26.233.70}"
gpu_port="${SUDS_GPU_PORT:-48659}"
case "$variant" in
  finetuned) default_checkpoint="/workspace/outputs/lawam_so101_h24/checkpoints/020000/pretrained_model" ;;
  base) default_checkpoint="jialei02/lawam-pretrain-lerobot" ;;
  *) echo "Unknown policy variant: $variant"; exit 2 ;;
esac
checkpoint="${SUDS_LAWAM_CHECKPOINT:-$default_checkpoint}"
follower_port="${SUDS_FOLLOWER_PORT:-$(jq -r '.follower' "$repo_root/config/arms.json")}"
tunnel_pid=""

if [[ "${SUDS_ENABLE_POLICY:-0}" != "1" ]]; then
  echo "Refusing physical policy motion. Re-run with SUDS_ENABLE_POLICY=1 after clearing the workspace and reaching the e-stop."
  exit 2
fi

cleanup() {
  if [[ -n "$tunnel_pid" ]]; then
    kill "$tunnel_pid" 2>/dev/null || true
    wait "$tunnel_pid" 2>/dev/null || true
  fi
  curl -fsS -X POST "$dashboard_url/api/health/release" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

[[ -e "$follower_port" ]] || { echo "Follower port is missing: $follower_port"; exit 1; }
curl -fsS -X POST "$dashboard_url/api/health/claim" >/dev/null

ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  -o StrictHostKeyChecking=no \
  -N -L 8080:localhost:8080 \
  -p "$gpu_port" "root@$gpu_host" \
  >/tmp/suds-lawam-tunnel.log 2>&1 &
tunnel_pid=$!

for _ in {1..50}; do
  nc -z 127.0.0.1 8080 2>/dev/null && break
  kill -0 "$tunnel_pid" 2>/dev/null || { cat /tmp/suds-lawam-tunnel.log; exit 1; }
  sleep 0.1
done
nc -z 127.0.0.1 8080 2>/dev/null || { echo "GPU tunnel did not open"; exit 1; }

for _ in {1..150}; do
  curl -fsS http://127.0.0.1:8614/status 2>/dev/null \
    | jq -e '.cameras | length > 0 and all(.streaming)' >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS http://127.0.0.1:8614/status 2>/dev/null \
  | jq -e '.cameras | length > 0 and all(.streaming)' >/dev/null \
  || { echo "Cameras did not become ready"; exit 1; }

# The checkpoint was trained on the recorder contract: `wrist` is the close
# gripper view and `overhead` the wide workspace view. The OpenCV index behind
# each label lives in config/cameras.json -- read it rather than repeating it,
# because indices can change. This checks config consistency, not physical
# identity: inspect the three saved policy-input frames before judging a run.
expected_cameras="$(jq -cS . "$repo_root/config/cameras.json")"
curl -fsS http://127.0.0.1:8614/status 2>/dev/null \
  | jq -e --argjson want "$expected_cameras" '([.cameras[] | {(.name): .index}] | add) == $want' >/dev/null \
  || {
    echo "Camera schema does not match config/cameras.json (expected $expected_cameras):"
    curl -fsS http://127.0.0.1:8614/status | jq -c '[.cameras[] | {name, index}]'
    exit 1
  }

cd "$repo_root"
exec </dev/null
"${SUDS_PYTHON:-$repo_root/.venv/bin/python}" "$repo_root/scripts/lawam_robot_client.py" \
  --server_address=127.0.0.1:8080 \
  --robot.type=so101_follower \
  --robot.port="$follower_port" \
  --robot.id=follower \
  --robot.max_relative_target=5 \
  --robot.cameras='{image: {type: zmq, server_address: 127.0.0.1, port: 5555, camera_name: overhead, width: 640, height: 480, fps: 30}, image2: {type: zmq, server_address: 127.0.0.1, port: 5555, camera_name: wrist, width: 640, height: 480, fps: 30}}' \
  --task='Pick up the yellow scrub sponge, scrub the inside of the orange bowl, put the sponge down, pick up the orange bowl, and place it in the sink.' \
  --policy_type=lawam \
  --pretrained_name_or_path="$checkpoint" \
  --policy_device=cuda \
  --actions_per_chunk=24 \
  --chunk_size_threshold=0.875 \
  --action_stall_timeout_s=2 \
  --aggregate_fn_name=weighted_average \
  --debug_visualize_queue_size=false
