"""No-motion RPC check using recorded SO-101 observations on the GPU host."""
import argparse
import math
import pickle
import time

import grpc
import torch

from lerobot.async_inference.helpers import RemotePolicyConfig, TimedObservation
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from lerobot.transport import services_pb2 as pb, services_pb2_grpc
from lerobot.transport.utils import send_bytes_in_chunks

from lawam_handoff import handoff_weights


def report_handoff(previous, current, delay_steps, handoff_steps):
    """Compare arm target jumps between two predictions from one episode."""
    previous_index, previous_actions = previous
    current_index, current_actions = current
    first_step = current_index + delay_steps
    old_end = previous_index + len(previous_actions)
    new_end = current_index + len(current_actions)
    overlap = min(old_end, new_end) - first_step
    if overlap <= 0:
        print(f"HANDOFF frame={current_index} delay_steps={delay_steps} overlap=0", flush=True)
        return

    weights = handoff_weights(range(first_step, old_end), range(first_step, new_end), handoff_steps)
    # The SO-101 dataset stores the five arm joints followed by the gripper.
    old = previous_actions[first_step - previous_index : first_step - previous_index + overlap, :5]
    new = current_actions[delay_steps : delay_steps + overlap, :5]
    blend = new.new_tensor([weights.get(step, 1.0) for step in range(first_step, first_step + overlap)])
    prefix = previous_actions[first_step - previous_index - 1, :5].unsqueeze(0)
    tail = current_actions[delay_steps + overlap : delay_steps + overlap + 1, :5]
    legacy = torch.cat((prefix, torch.lerp(old, new, 0.7), tail))
    handoff = torch.cat((prefix, torch.lerp(old, new, blend[:, None]), tail))
    print(
        f"HANDOFF frame={current_index} delay_steps={delay_steps} overlap={overlap} "
        f"peak_joint_step_deg legacy={legacy.diff(dim=0).abs().max().item():.3f} "
        f"handoff={handoff.diff(dim=0).abs().max().item():.3f}",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--handoff-replay", action="store_true",
                        help="Compare handoffs using overlapping predictions and measured RPC latency")
    args = parser.parse_args()
    dataset = LeRobotDataset(
        "suds/live_2", root="/workspace/datasets/suds_live_2_canonical_20260917",
        video_backend="pyav",
    )
    roles = {"image": "overhead", "image2": "wrist"}
    features = {"observation.state": dataset.features["observation.state"]}
    for key, role in roles.items():
        features[f"observation.images.{key}"] = {
            **dataset.features[f"observation.images.{role}"], "dtype": "image",
        }
    stub = services_pb2_grpc.AsyncInferenceStub(grpc.insecure_channel("127.0.0.1:8080"))
    stub.Ready(pb.Empty(), timeout=10)
    spec = RemotePolicyConfig("lawam", "/workspace/outputs/lawam_so101_h24/checkpoints/020000/pretrained_model", features, 24, "cuda")
    started = time.perf_counter()
    stub.SendPolicyInstructions(pb.PolicySetup(data=pickle.dumps(spec)), timeout=180)
    print(f"READY in {time.perf_counter() - started:.2f}s", flush=True)
    previous = None
    previous_episode = None
    for index in ((0, 8, 16) if args.handoff_replay else (0, 30, 60)):
        sample = dataset[index]
        raw = dict(zip(features["observation.state"]["names"], sample["observation.state"].tolist()))
        raw["task"] = sample["task"]
        for key, role in roles.items():
            raw[key] = (sample[f"observation.images.{role}"].permute(1, 2, 0) * 255).round().byte().numpy()
        obs = TimedObservation(time.time(), index, raw, must_go=True)
        started = time.perf_counter()
        stub.SendObservations(send_bytes_in_chunks(pickle.dumps(obs), pb.Observation, silent=True), timeout=15)
        result = stub.GetActions(pb.Empty(), timeout=60)
        assert result.data, "Server returned no actions"
        actions = torch.stack([a.get_action() for a in pickle.loads(result.data)])
        latency = time.perf_counter() - started
        assert actions.shape == (24, 6), actions.shape
        assert torch.isfinite(actions).all(), "Non-finite actions"
        print(f"PASS frame={index} shape={tuple(actions.shape)} latency={latency:.3f}s range=[{actions.min():.3f}, {actions.max():.3f}]", flush=True)
        episode = int(sample["episode_index"])
        if args.handoff_replay and previous_episode == episode:
            report_handoff(previous, (index, actions), math.ceil(latency * dataset.fps), handoff_steps=6)
        previous, previous_episode = (index, actions), episode
        # Diagnostic agreement with this demonstration, not a success metric:
        # another valid trajectory can differ. Stay within the same episode.
        reference = [dataset[offset] for offset in range(index, min(index + len(actions), len(dataset)))]
        if len(reference) == len(actions) and all(int(s["episode_index"]) == episode for s in reference):
            target = torch.stack([s["action"] for s in reference]).to(actions)
            mae = (actions - target).abs().mean(dim=0).tolist()
            print("DEMO_MAE " + str(dict(zip(features["observation.state"]["names"], mae))), flush=True)
            print(f"FIRST predicted={actions[0].tolist()} demonstrated={target[0].tolist()}", flush=True)


if __name__ == "__main__":
    main()
