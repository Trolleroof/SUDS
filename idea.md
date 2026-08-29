# SUDS

**System for Unified Dishwashing and Scrubbing**

SUDS is a low-cost bimanual robotics project focused on teaching robots to perform dishwashing tasks through teleoperation, imitation learning, and vision-based control.

The initial system uses two SO-101 robotic arms as a bimanual manipulation platform. The goal is to build a robot capable of interacting with common kitchen objects such as plates, cups, utensils, sponges, and eventually running water.

---

## Project Goal

The long-term goal of SUDS is to create a general-purpose robotic dishwashing system that can:

* Identify dirty dishes and kitchen objects
* Pick up and reposition plates, cups, bowls, and utensils
* Hold objects securely with one arm while cleaning with the other
* Use a sponge or cleaning tool
* Perform scrubbing motions
* Move objects between different regions of a sink
* Place cleaned dishes into a drying area or rack
* Learn new behaviors from human demonstrations
* Recover from small positioning errors
* Eventually perform an entire dishwashing sequence autonomously

SUDS is intended to begin as a research prototype rather than a polished consumer appliance.

---

# Why Dishwashing?

Dishwashing looks simple to humans but combines many difficult robotics problems.

A robot must understand:

* Object position
* Object orientation
* Shape
* Material
* Grip strength
* Contact forces
* Tool usage
* Bimanual coordination
* Collision avoidance
* Visual changes
* Slippery objects
* Unstructured environments

For example, washing a plate could require one arm to securely hold the plate while the second arm moves a sponge across its surface.

That makes dishwashing an interesting test environment for learning general robotic manipulation.

---

# Core Platform

## Robot Arms

The first SUDS prototype uses:

**2 × SO-101 robotic arms**

The two-arm setup allows the robot to perform coordinated manipulation.

Example:

```text
Left arm                  Right arm
   |                          |
   v                          v
Hold plate  <---------->  Scrub plate
```

Other possible combinations include:

```text
Hold cup        +        Move sponge
Hold bowl       +        Scrub interior
Hold utensil    +        Clean utensil
Move dish       +        Stabilize rack
```

---

# System Architecture

The basic architecture is:

```text
                 ┌────────────────────┐
                 │      Cameras       │
                 │                    │
                 │ Overhead / Wrist   │
                 └─────────┬──────────┘
                           │
                           v
                 ┌────────────────────┐
                 │   Robot Computer   │
                 │                    │
                 │      LeRobot       │
                 │   Policy Runtime   │
                 └─────────┬──────────┘
                           │
                ┌──────────┴──────────┐
                │                     │
                v                     v
        ┌──────────────┐      ┌──────────────┐
        │ Left SO-101  │      │ Right SO-101 │
        └──────────────┘      └──────────────┘
```

During data collection, a human operator controls the robot.

```text
Human
  |
  v
Leader Arms
  |
  v
SO-101 Follower Arms
  |
  v
Dishwashing Task
  |
  v
Recorded Dataset
```

The recorded demonstrations can later be used to train a robot policy.

---

# Development Pipeline

SUDS will be developed gradually rather than immediately attempting full autonomous dishwashing.

The general pipeline is:

```text
Build robot
     |
     v
Calibrate arms
     |
     v
Teleoperate
     |
     v
Add cameras
     |
     v
Record demonstrations
     |
     v
Create dataset
     |
     v
Train model
     |
     v
Run autonomous policy
     |
     v
Evaluate
     |
     v
Collect better demonstrations
     |
     └──────────────> Repeat
```

---

# Phase 1: Robot Bring-Up

The first milestone is simply getting both SO-101 arms working reliably.

Tasks include:

* Assemble both SO-101 arms
* Connect servo controllers
* Verify all motors
* Configure servo IDs
* Calibrate joint positions
* Verify joint limits
* Test individual arm movement
* Configure leader/follower teleoperation
* Verify emergency stopping

At this stage, there is no machine learning.

Success means:

> A human can smoothly control both robot arms through teleoperation.

---

# Phase 2: Dry Manipulation

Before using water, SUDS should operate in a completely dry environment.

A fake sink can be created using:

* Plastic tray
* Plastic plates
* Cups
* Bowls
* Utensils
* Sponge
* Drying rack

This reduces the risk of damaging electronics while the robot is still experimental.

Initial manipulation tasks could include:

```text
Reach object
    ↓
Touch object
    ↓
Grasp object
    ↓
Lift object
    ↓
Move object
    ↓
Place object
```

---

# Phase 3: Bimanual Manipulation

Once each arm works individually, SUDS can begin coordinated tasks.

Examples:

### Plate stabilization

```text
LEFT ARM
   ↓
Grasp plate

RIGHT ARM
   ↓
Touch surface
```

### Sponge manipulation

```text
LEFT ARM
   ↓
Hold plate

RIGHT ARM
   ↓
Pick up sponge
   ↓
Move sponge across plate
```

### Handoffs

```text
Left arm
    ↓
Hold object
    ↓
Right arm approaches
    ↓
Both grasp
    ↓
Left releases
    ↓
Right carries object
```

These tasks are useful precursors to full dishwashing.

---

# Phase 4: Vision

Cameras allow the robot to understand its surroundings.

A basic SUDS setup may use:

* One overhead camera
* One front-facing camera
* Optional wrist cameras

Possible camera layout:

```text
             Overhead Camera
                    |
                    v

        ┌─────────────────────┐
        │                     │
        │     Workspace       │
        │                     │
        │  Plate      Sponge  │
        │                     │
        └─────────────────────┘

          /               \
         /                 \
 Left SO-101             Right SO-101
```

Camera observations may eventually allow the policy to infer:

* Object locations
* Arm positions
* Gripper positions
* Task progress
* Object orientation
* Contact state

---

# Phase 5: Demonstration Collection

SUDS will initially learn from human demonstrations.

A human performs the task using teleoperation while the system records:

* Camera frames
* Joint positions
* Joint velocities
* Gripper positions
* Actions
* Timestamps

A dataset could contain hundreds or thousands of demonstrations.

Example dataset:

```text
suds_dataset/
│
├── episode_0001
│   ├── camera
│   ├── robot_state
│   └── actions
│
├── episode_0002
│
├── episode_0003
│
└── ...
```

Each episode represents one attempt at a task.

---

# Example Task Dataset

Instead of immediately recording complete dishwashing sequences, demonstrations should be divided into simpler skills.

## Skill 1

**Pick up sponge**

```text
Observe sponge
      ↓
Move toward sponge
      ↓
Position gripper
      ↓
Close gripper
      ↓
Lift
```

## Skill 2

**Pick up plate**

```text
Observe plate
      ↓
Move to edge
      ↓
Grip
      ↓
Lift
```

## Skill 3

**Scrub plate**

```text
Left arm holds plate

        +

Right arm holds sponge

        ↓

Repeated wiping motion
```

## Skill 4

**Place plate**

```text
Carry plate
     ↓
Align with destination
     ↓
Lower
     ↓
Release
```

Eventually these behaviors can be combined into longer sequences.

---

# Machine Learning

The project may use LeRobot-compatible policies for imitation learning.

The basic idea is:

```text
Human demonstrations
        |
        v
     Dataset
        |
        v
   Neural Network
        |
        v
  Learned Policy
        |
        v
Robot observations
        |
        v
Robot actions
```

The policy attempts to learn the relationship:

```text
camera images + robot state
                ↓
           robot action
```

Instead of explicitly programming every trajectory, the robot learns behavior from examples.

---

# Compute

The main development computer can be a Mac.

The Mac can handle:

* SO-101 control
* Teleoperation
* Dataset recording
* Camera capture
* Dataset inspection
* Development
* Visualization
* Some inference workloads

Large training workloads can be performed using rented cloud GPUs.

Example:

```text
              LOCAL MAC

SO-101 → Collect demonstrations
              |
              v
           Dataset
              |
              v
          Upload
              |
              v

            CLOUD

       NVIDIA GPU Server
              |
              v
          Training
              |
              v
          Checkpoint
              |
              v
          Download

              |
              v

              MAC

      Run trained policy
              |
              v
           SO-101
```

This avoids requiring a dedicated NVIDIA workstation during the early stages of development.

---

# Software Stack

Potential software components include:

### Robot control

* LeRobot
* SO-101 drivers
* Python

### Machine learning

* PyTorch
* LeRobot policies
* Perceptron Isaac
* Other vision-language-action or imitation-learning models

### Development

* Git
* GitHub
* `uv`
* Python

### Training

* Cloud NVIDIA GPUs

Possible providers could include GPU rental services or dedicated cloud compute.

---

# Safety

Dishwashing introduces unusual risks for robotics because water and electronics are located close together.

Early SUDS experiments should therefore remain completely dry.

The progression should be:

```text
Dry table
    ↓
Plastic tray
    ↓
Fake sink
    ↓
Damp sponge
    ↓
Small controlled amount of water
    ↓
Real sink
```

Electronics should remain physically separated from water.

Additional safety mechanisms should eventually include:

* Emergency stop
* Joint limits
* Current limits
* Speed limits
* Workspace boundaries
* Waterproof barriers
* Drip protection
* Cable management
* Fault detection

---

# Hardware Layout

A possible prototype layout:

```text
                 CAMERA
                   |
                   v

        ┌──────────────────────┐
        │                      │
        │      FAKE SINK       │
        │                      │
        │ Plate         Sponge │
        │                      │
        └──────────────────────┘

            ↑              ↑
            |              |

       LEFT ARM        RIGHT ARM
        SO-101           SO-101

            \              /
             \            /
              \          /
               COMPUTER
                  |
                  v
               LeRobot
```

---

# Development Roadmap

## SUDS 0.1

Basic robot platform.

Goals:

* Assemble SO-101s
* Calibrate
* Teleoperate
* Verify reliable operation

---

## SUDS 0.2

Dry manipulation.

Goals:

* Pick up sponge
* Pick up plate
* Move cup
* Place objects
* Perform bimanual grasps

---

## SUDS 0.3

Vision and data collection.

Goals:

* Install cameras
* Record synchronized observations
* Build LeRobot datasets
* Record repeatable demonstrations

---

## SUDS 0.4

Learned manipulation.

Goals:

* Train first imitation-learning policy
* Autonomous sponge pickup
* Autonomous plate manipulation
* Measure success rates

---

## SUDS 0.5

Bimanual learned manipulation.

Goals:

* Hold plate with one arm
* Manipulate sponge with second arm
* Learn basic scrubbing behavior
* Coordinate both arms autonomously

---

## SUDS 0.6

Controlled cleaning environment.

Goals:

* Introduce damp sponge
* Introduce small quantities of water
* Improve gripping on slippery objects
* Add electronics protection

---

## SUDS 1.0

Complete dishwashing prototype.

Target sequence:

```text
Detect dirty dish
       ↓
Pick up dish
       ↓
Position dish
       ↓
Pick up sponge
       ↓
Scrub first side
       ↓
Rotate dish
       ↓
Scrub second side
       ↓
Rinse
       ↓
Place in drying rack
       ↓
Find next dish
```

---

# Evaluation

Every behavior should have measurable success criteria.

For example:

| Task                  | Metric                       |
| --------------------- | ---------------------------- |
| Sponge pickup         | Successful grasps / attempts |
| Plate pickup          | Successful lifts / attempts  |
| Plate placement       | Placement accuracy           |
| Scrubbing             | Surface coverage             |
| Bimanual coordination | Completion rate              |
| Full cleaning cycle   | Successful cycles / attempts |

Other useful metrics include:

* Average completion time
* Number of human interventions
* Number of dropped objects
* Collision frequency
* Policy inference speed
* Recovery success

---

# Initial Experiments

The first useful experiments for SUDS should be intentionally simple.

### Experiment 001

**Move a sponge between two locations**

```text
A → B
```

Goal:

Teach reliable grasping and placement.

### Experiment 002

**Pick up a plate**

Goal:

Learn how different plate positions affect grasping.

### Experiment 003

**Hold plate while second arm touches it**

Goal:

Test bimanual coordination.

### Experiment 004

**Perform repeated sponge motion**

Goal:

Create the basic motion needed for scrubbing.

### Experiment 005

**Learn sponge pickup from demonstrations**

Goal:

Train the first autonomous SUDS policy.

---

# Design Philosophy

SUDS should prioritize:

**Low-cost hardware**

The system should be reproducible without expensive industrial robot arms.

**Learning over hard-coded motion**

Where practical, manipulation behavior should emerge from demonstrations rather than manually programmed trajectories.

**Incremental complexity**

Simple behaviors should work reliably before attempting full dishwashing.

**Reproducibility**

Hardware designs, training configurations, datasets, and experimental results should eventually be documented.

**Real-world usefulness**

The project should ultimately move beyond benchmark manipulation tasks toward genuinely useful household robotics.

---

# Repository Structure

A future repository could look something like:

```text
suds/
│
├── README.md
├── docs/
│   ├── hardware.md
│   ├── calibration.md
│   ├── teleoperation.md
│   └── training.md
│
├── hardware/
│   ├── mounts/
│   ├── camera_mounts/
│   └── waterproofing/
│
├── configs/
│   ├── robots/
│   ├── cameras/
│   └── policies/
│
├── scripts/
│   ├── teleop.py
│   ├── record.py
│   ├── train.py
│   └── evaluate.py
│
├── datasets/
│
├── policies/
│
├── experiments/
│
└── results/
```

---

# Naming

## SUDS

**S**ystem for **U**nified **D**ishwashing and **S**crubbing

Possible version names:

```text
SUDS-0
SUDS-1
SUDS Mini
SUDS Duo
SUDS Research Platform
```

The first bimanual SO-101 prototype could simply be called:

# **SUDS-1**

---

# Immediate Next Steps

Current priority:

```text
SO-101 arms arrive
        ↓
Assembly
        ↓
Servo setup
        ↓
Calibration
        ↓
Teleoperation
        ↓
Dry manipulation
        ↓
Camera setup
        ↓
First demonstrations
        ↓
First dataset
        ↓
First learned policy
```

The most important short-term milestone is not autonomous dishwashing.

It is:

> **Get SUDS-1 reliably performing a simple bimanual manipulation task through human teleoperation.**

Once that works, the same platform can be used to begin collecting the data required for autonomy.

---

# Vision

SUDS begins as two inexpensive robot arms manipulating objects in a plastic tray.

The long-term system could evolve into a robot capable of observing an unfamiliar sink, understanding the objects inside it, manipulating fragile and slippery dishes, selecting appropriate cleaning behaviors, and completing the entire dishwashing process with minimal human assistance.

The broader research question behind SUDS is simple:

> **Can an affordable robot learn complex household manipulation skills from humans instead of requiring every behavior to be explicitly programmed?**
