import platform, sys
print(f"python  {sys.version.split()[0]}  {platform.machine()}")

import torch
print(f"torch   {torch.__version__}   mps={torch.backends.mps.is_available()}")
x = torch.randn(512, 512, device="mps") @ torch.randn(512, 512, device="mps")
print(f"        mps matmul ok -> {tuple(x.shape)} on {x.device}")

import lerobot
print(f"lerobot {lerobot.__version__}")

from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig
print("so101   SO101Follower + SO101Leader ok")

from lerobot.robots.bi_so_follower import BiSOFollower, BiSOFollowerConfig
from lerobot.teleoperators.bi_so_leader import BiSOLeader, BiSOLeaderConfig
print("bimanual BiSOFollower + BiSOLeader ok  <-- SUDS target")

from lerobot.motors.feetech import FeetechMotorsBus
print("motors  FeetechMotorsBus (STS3215) ok")

from lerobot.cameras.opencv import OpenCVCamera, OpenCVCameraConfig
print("cameras OpenCVCamera ok")

from lerobot.datasets.lerobot_dataset import LeRobotDataset
import torchcodec
print(f"data    LeRobotDataset ok, torchcodec {torchcodec.__version__}")

from lerobot.policies.act.modeling_act import ACTPolicy
print("policy  ACTPolicy ok")

import rerun
print(f"viz     rerun {rerun.__version__}")

# Instantiate a real bimanual config (no hardware touched)
cfg = BiSOFollowerConfig(
    left_arm_config=SO101FollowerConfig(port="/dev/tty.usbmodem-LEFT", id="suds_left"),
    right_arm_config=SO101FollowerConfig(port="/dev/tty.usbmodem-RIGHT", id="suds_right"),
    id="suds_bimanual",
)
robot = BiSOFollower(cfg)
print(f"\nconfig  BiSOFollower built: {len(robot.action_features)} action dims")
print(f"        actions: {list(robot.action_features)}")
