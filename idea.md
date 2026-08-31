# SUDS

**Sim-to-real data efficiency for SO-101 dish rinsing.**

SUDS asks one concrete question:

> Can a rough MuJoCo clone plus simulated data reduce the number of physical
> dish-rinsing demonstrations required to fine-tune GROOT for the real SO-101?

Teleoperation is not the end product. It is the controlled source of scarce,
high-quality real data used to answer that question.

## First task

One arm rinses one marked dish in a dry sink/tray mock-up. The dish starts in a
fixed holder; a trial succeeds when the end effector visits every marked rinse
region, avoids the tray and dish holder, and reaches the rest pose. Water stays
out of the first study: it is not needed to measure visual-motor data
efficiency, and it adds an uncontrolled safety and sensing variable.

The task may become bimanual later, but the first result uses one arm and one
repeatable success test.

## The experiment

Fine-tune the same GROOT base checkpoint in every condition. Keep model
selection, camera input, action representation, training budget, and physical
test protocol fixed.

| Condition | Real demonstrations | Simulated demonstrations |
| --- | ---: | ---: |
| real-only baseline | 5, 10, 20, 40 | 0 |
| sim + real | 5, 10, 20, 40 | randomized twin rollouts |

Each trained policy gets the same number of unseen physical trials. The primary
result is a curve: **physical success rate versus real demonstrations**.

The desired, falsifiable claim is: “sim + 10 real demonstrations matched the
physical success of real-only fine-tuning with 40.” A negative result is still
useful if it identifies the mismatch that prevented transfer.

Record and report success, collision, time-to-completion, and failure category.
Only physical held-out trials support the headline. Simulation data may train a
policy and help choose variants; it must never enter the physical evaluation
set.

## Real data

The existing LeRobot recorder and dashboard are the source of truth for real
episodes:

1. Calibrate the follower and camera; lock the tray, dish holder, and camera.
2. Teleoperate clean rinse trajectories and review each take pass/fail.
3. Save a frozen real training pool, then create deterministic 5/10/20/40-demo
   subsets.
4. Reserve separate, never-trained-on physical placements for evaluation.

The recorded camera feature names are part of the model contract. Do not rename
an established dataset’s observation fields when switching between recording,
simulation, and GROOT fine-tuning.

## Rough digital twin

The twin needs only the things that can change the policy outcome:

- the supplied SO-101 MJCF and joint limits;
- tray, dish holder, dish, and rinse-region geometry;
- the overhead camera’s pose and intrinsics;
- approximate masses, contact friction, actuator response, and rest pose.

It deliberately does **not** model water or cleaning chemistry in the first
study. Use domain randomization around the measured scene: dish/holder pose,
camera pose, lighting/background, friction, object mass, motor response, and
joint zero offsets. The purpose is not a photorealistic kitchen; it is a policy
that tolerates the errors the real cell has.

## Bringing the real cell into MuJoCo

1. Put an AprilTag or checkerboard on the tray and a fixed coordinate marker on
   the robot base. Measure the tray, holder, dish, and marker once with a tape
   measure or calipers.
2. With the physical arm parked at its known rest pose, capture an overhead
   image. Set the MuJoCo camera so its rendered marker/dish alignment matches
   that image. Save camera pose, intrinsics, and object poses in one versioned
   scene file.
3. Replay a small set of recorded joint trajectories in MuJoCo. Compare the
   rendered end-effector/dish motion to the real videos; tune only obvious
   offsets, actuator gains, and contact friction.
4. Validate on held-out physical trajectories and placements. If the twin is
   wrong, widen the corresponding randomization range rather than hiding the
   mismatch with hand-picked simulated examples.

The twin is validated by its predictive usefulness: do policy rankings in sim
correlate with rankings on the physical SO-101? Report that correlation next to
the success curve.

## Milestones

1. **Cell and task:** repeatable dry rinse task, physical success rubric, 20
   reviewed real demonstrations.
2. **Twin:** calibrated MuJoCo scene and replay comparison for a few held-out
   trajectories.
3. **Pilot:** real-only 10 demos versus sim + real 10 demos, each on 20 unseen
   physical trials.
4. **Curve:** 5/10/20/40 real-demo experiment, public plots, videos, configs,
   seeds, and failure analysis.

Do not move to full dishwashing until the curve is credible. One maintained,
open study with an honest negative or positive result is the project.
