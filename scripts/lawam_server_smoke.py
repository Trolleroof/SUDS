"""No-motion RPC check using recorded SO-101 observations on the GPU host."""
import pickle
import time

import grpc
import torch

from lerobot.async_inference.helpers import RemotePolicyConfig, TimedObservation
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from lerobot.transport import services_pb2 as pb, services_pb2_grpc
from lerobot.transport.utils import send_bytes_in_chunks


def main():
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
    for index in (0, 30, 60):
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
        assert actions.shape == (24, 6), actions.shape
        assert torch.isfinite(actions).all(), "Non-finite actions"
        print(f"PASS frame={index} shape={tuple(actions.shape)} latency={time.perf_counter() - started:.3f}s range=[{actions.min():.3f}, {actions.max():.3f}]", flush=True)
        # Diagnostic agreement with this demonstration, not a success metric:
        # another valid trajectory can differ. Stay within the same episode.
        reference = [dataset[index + offset] for offset in range(len(actions))]
        if all(int(s["episode_index"]) == int(sample["episode_index"]) for s in reference):
            target = torch.stack([s["action"] for s in reference]).to(actions)
            mae = (actions - target).abs().mean(dim=0).tolist()
            print("DEMO_MAE " + str(dict(zip(features["observation.state"]["names"], mae))), flush=True)
            print(f"FIRST predicted={actions[0].tolist()} demonstrated={target[0].tolist()}", flush=True)


if __name__ == "__main__":
    main()
