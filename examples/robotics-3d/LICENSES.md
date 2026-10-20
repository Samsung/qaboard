# Inputs, code and their licenses

## Inputs
None downloaded. Each sequence's `inputs/sequences/<name>/sequence.yaml` names a path and a seed; `qa/make_sequences.py`
generates the warehouse, the robot's true trajectory and the depth camera's noiseless images from them (`truth.npz`,
not committed), and the runs simulate the sensors' noise. They are ours, under the repository's license (Apache-2.0).

Public datasets (TUM RGB-D, EuRoC, KITTI...) are not used: their licenses are CC BY or non-commercial.

## Python dependencies
NumPy and SciPy (BSD-3-Clause), Pillow (MIT-CMU), PyYAML (MIT). Videos are encoded by FFmpeg's libvpx-vp9 (BSD-3-Clause),
which must be installed: `apt-get install ffmpeg`.
