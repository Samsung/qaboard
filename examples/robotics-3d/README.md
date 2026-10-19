# Odometry and mapping: a QA-Board example

The odometry of a (fictional) warehouse robot, wrapped with QA-Board: `qa/main.py` simulates a robot driving through
a warehouse, its depth camera and its IMU, then estimates its trajectory from them with point-to-plane ICP, keyframes
and loop closures, and compares it with the true one. Each run saves the trajectories, a video of the depth camera next
to the path so far, the error over time, the map it built (an image from above, and point clouds), and the metrics.
[`SPEC.md`](SPEC.md) describes everything it computes; `story.yaml` is the six weeks of history the QA-Board docs show:
loop closures that pay off, then a change that makes fast turns drift, found in History and fixed.

## Run it

```bash
pip install qaboard -r requirements.txt     # numpy scipy pillow pyyaml; videos also need ffmpeg
cd examples/robotics-3d

qa batch ci                                  # the 6 sequences
qa run --input sequences/figure8-fast
python qa/main.py figure8-fast               # without QA-Board: the outputs go to output/figure8-fast/
qa batch sweep-keyframes --tuning-search '{"search_type": "grid", "parameter_search": {"keyframe_dist": [0.3, 0.6], "imu_weight": [0.2, 0.6]}}'
```

- The first time `qa` imports `qa/main.py`, it generates the sequences' ground truth (`qa/make_sequences.py`, about
  20 s): the warehouse, the true trajectory and the noiseless depth images, in `inputs/sequences/*/truth.npz`.
- A run takes 15-40 s. Runs are memoized in `.cache/runs/` (`$SLAM_CACHE_DIR`) by everything they depend on (the code,
  the flags, the sequence and the seed): running the same code again reuses the results, time per frame included.
- Without `--share` or a CI, results are saved in `output/`. To see them in QA-Board, start a server
  ([quickstart](https://samsung.github.io/qaboard/docs/get-started/quickstart)), and use `qa --share` or run in CI.

## How it's wired

| File | What it does |
|---|---|
| `qaboard.yaml` | Project name, inputs (each sequence is a folder with its `sequence.yaml`), visualizations, the quality gate |
| `qa/main.py` | `run(context)`: simulates, estimates, evaluates, saves the outputs and returns the metrics; memoizes runs |
| `qa/world.py`, `qa/trajectory.py` | The warehouses (boxes: shelves, pallets, pillars, walls) and the robot's paths |
| `qa/sensors.py` | The depth camera (160x120, 15 fps, ray-cast, 1% depth noise, dropouts at edges) and the IMU (200 Hz, biases) |
| `qa/odometry.py` | IMU prediction, point-to-plane ICP to the last keyframe, degenerate directions, keyframes |
| `qa/loop_closure.py` | Revisits: candidates, ICP verification and overlap, the keyframes' pose graph |
| `qa/evaluate.py` | ATE after alignment, RPE over 1 m, drift at the end |
| `qa/outputs.py` | Trajectory files, the video, the error plot, the map image and point clouds |
| `qa/metrics.yaml`, `qa/batches.yaml` | Metrics (labels, units, targets) and batches (`ci`, `sweep-keyframes`) |

**Flags** describe the code's choices (keyframes, the IMU's weight, loop closures): `qa/main.py` reads them from
`build/flags.json`, over its defaults, and tuning parameters override them:

```bash
echo '{"imu_weight": 0.2}' > build/flags.json
qa run --input sequences/figure8-fast       # the fast figure-8 drifts: ICP alone slips in fast turns
```

**Determinism:** the sensors' noise is seeded by the sequence and `$QA_SEED`, so runs give the same trajectories and
metrics from one run to the next on a machine. Other CPUs can change the last digits. Time per frame is measured.

## Inputs

Everything is simulated, so the ground truth is exact; see [`LICENSES.md`](LICENSES.md).

| Sequence | What it stresses |
|---|---|
| `aisle-sweep` | long straight aisles between shelves, U-turns: ICP can't tell how far along an aisle the robot moved |
| `loop` | a closed loop around a block of shelves: loop closure |
| `figure8` | a figure-8 around two blocks of shelves, crossing in the middle (it doesn't come back to its start in 40 s) |
| `figure8-fast` | the same at twice the speed, more than two laps: fast turns, and loop closures |
| `docking` | a slow approach to the charging dock, turns in place |
| `long-corridor` | flat walls along the direction of travel: degenerate for ICP, the IMU carries the robot |
