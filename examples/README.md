# The demo world

The projects in this folder are real, runnable QA-Board projects. Their history is replayed into a QA-Board server
from each project's `story.yaml` ([format](STORY.md)), and that server is what the docs' screenshots, the local
quickstarts and the Kubernetes CI test show. This file is the bible of that world: who works there, on what, and how
they write. Each project's `SPEC.md` says what its code computes.

**All the data is synthetic, but really computed.** The company, people, commit history and messages are fiction.
Every metric, image, plot, flame graph and log line comes from running the project's code on its inputs, with the
flags its story sets at that commit. The only templated outputs are what needs infrastructure the demo doesn't have:
links to CI jobs, and LSF job reports, whose numbers are still the run's measured ones.

## Kitefin Robotics (working name)

Kitefin builds camera-equipped mobile robots: the **K3** drives warehouse aisles and back rooms, counts stock with a
12 MP camera and avoids obstacles with a depth camera. Robots run small models on board and call the fleet backend for
heavier ones, through an inference gateway. Operators manage the fleet with an assistant that answers questions and
acts through tools.

About 40 people, remote-first. Six of them, and one bot, commit to the demo projects. Nobody in this world is real:
the names were checked against web searches for well-known people (October 2026).

## People

Story times are UTC. Each persona works on weekdays within the hours given, in UTC.

| Handle | Name (`committer_name`) | Team, role | Projects (main, also) | Works (UTC) |
|---|---|---|---|---|
| `ines` | Ines Marchetti | Imaging, lead imaging scientist | `camera-isp` | 07:00-16:00 |
| `tobias` | Tobias M. Wendt | Imaging, fixed-point and silicon bring-up | `camera-isp` | 06:30-15:30 |
| `arjun` | Arjun Sethuraman | Perception, ML engineer: detection, quantization | `detector`; `slam`, `fleet-assistant` | 13:00-22:00 |
| `mira` | Mira Kowalczyk | Perception, robotics engineer: odometry, sensor fusion | `slam`; `detector` | 07:00-16:00 |
| `adaeze` | Adaeze Nwankwo | Fleet platform, tech lead | `inference-gateway` | 08:00-17:00 |
| `kaito` | Kaito Nishimaki | Fleet platform, performance engineer | `inference-gateway`; `fleet-assistant` | 00:00-09:00 |
| `agent` | Kitefin Coding Agent | A coding agent account the platform team assigns tasks to | `inference-gateway`, `fleet-assistant` | any time |

Emails are `<handle>@kitefin.example`. CI runs are started by the user `ci`.

### Voices
Commit subjects stay under 72 characters, in English, imperative mood. Bodies, when there are any, say why.

- **Ines:** a stage prefix, the effect with numbers. `denoise: bilateral 7x7 on luma (+0.4 dB PSNR in low light)`,
  `sharpen: clamp the boost near strong edges (halos)`.
- **Tobias:** terse, `fxp:` prefix, bit widths. `fxp: round half to even in sharpen`, `fxp: 2 guard bits in bilateral LUT`.
- **Arjun:** conventional commits. `feat(quant): static int8 with minmax calibration`, `fix(eval): count crowd boxes once`.
- **Mira:** lowercase, names the sequence it fixes. `loop closure: reject matches under 30 inliers (fixes long-corridor)`.
- **Adaeze:** `gateway:` prefix, a body that explains the trade-off.
  `gateway: shard the result cache by key hash` / "One mutex for the whole cache serialized every worker under load."
- **Kaito:** perf numbers in the subject. `batcher: reuse the batch buffer (-8% CPU at 6k rps)`.
- **Kitefin Coding Agent:** plain descriptive subjects, a body with what it measured and who asked.
  `Add a shared result cache for repeated requests` / "Requested by Kaito. p50 at 4k rps: 3.1 ms -> 2.2 ms."

### Avatars
No photos. Commits from the demo stack have no avatar URL (no GitLab token, no GitHub webhook), so the web app draws its
fallback: the person's initials in white on a color derived from the name, the same everywhere
(`avatarColor()` in `webapp/src/components/avatars.tsx`: 12 Blueprint colors, all >= 4.5:1 with white text).
That function is the source of truth: when seeding, check that people who share a project get different colors, and
change a persona's display name (not the function) if two collide. `seed.py` checks it: "Tobias M. Wendt" and "Kitefin
Coding Agent" have their middle initial and "Coding" so that they don't share Ines's and Kaito's colors.

Never connect the demo projects to GitHub (webhook or `hosting_type: github`): the backend then searches GitHub users
by committer name for avatars, and could show a real person's photo next to a fictional name.

## Projects

The home page shows each project's id as its title, and its description below. Ids are `project.name` in each
example's *qaboard.yaml*. Today a card shows the description only when the git hosting provided one
(`webapp/src/ProjectsList.jsx`): a phase-0 fix should show `project.description` on its own.

| Example | Project id | Description (`project.description`) | Reference branch | Phase |
|---|---|---|---|---|
| [`image-quality`](image-quality/SPEC.md) | `kitefin/camera-isp` | Image pipeline of the K3 camera, from raw sensor data to the displayed image, in float and in the fixed-point model of the camera chip. | `main` | 1 |
| [`serving-latency`](serving-latency/SPEC.md) | `kitefin/inference-gateway` | The fleet's inference gateway: request queue, dynamic batching and CPU workers for the models robots call. | `main` | 2 |
| [`detection-eval`](detection-eval/SPEC.md) | `kitefin/detector` | Object detector of the K3 robots, evaluated in fp32 and int8 at several input sizes. | `main` | 2 |
| [`robotics-3d`](robotics-3d/SPEC.md) | `kitefin/slam` | Odometry and mapping from the K3's depth camera and IMU, against ground-truth trajectories. | `main` | 3 |
| [`agent-evals`](agent-evals/SPEC.md) | `kitefin/fleet-assistant` | The operators' assistant: answers questions and acts on the fleet through tools, scored on scripted tasks. | `main` | 3 |

In prose, call them by their role: "the camera ISP project", "the inference gateway".

`project.url` is `https://git.kitefin.example/<project id>`. The demo uses the reserved `.example` domain
(RFC 2606) for every URL and email: nothing resolves, nothing belongs to anyone.

## Conventions

### Time
- **T0** is the seed date: the instant the demo is "now". It is always a **Thursday at 16:00 UTC**, picked when the
  stories are seeded (by default the last Thursday before seeding) and stored in the snapshot. Captures freeze the
  browser clock at T0.
- Stories give every time as an offset from T0 ([format](STORY.md#time-offsets)). With T0 on a Thursday, `-4d` and
  `-5d` are the weekend: the seeder warns about commits there.
- Each project's history spans about 6 weeks before T0, mostly on weekdays, within the authors' hours.
- The newest finished results are at least 10 minutes before T0; one batch per project is still running at T0.
- The quickstart's demo-data image shifts all dates on restore so that T0 becomes the restore time.

### Branches
- `main` is the reference branch everywhere, set explicitly in *qaboard.yaml*.
- Feature branches are `<area>/<topic>` in kebab-case. Areas: `isp/`, `fxp/` (camera ISP), `gateway/`, `perf/`
  (gateway), `det/`, `quant/` (detector), `slam/`, `assistant/`, and `agent/` for the Kitefin Coding Agent's branches.
- 3-4 feature branches per project, merged with `Merge branch '<branch>'` by the branch's author, or abandoned.
  No pull request numbers or ticket ids in messages.

### Milestones
Two per project, named like releases, created as **shared** milestones by the team lead (the label is the release
name, the notes one short sentence). A story may also list a release branch in *qaboard.yaml*'s `project.milestones`,
which the web app treats as a branch name:

| Project | Milestones (label: notes) |
|---|---|
| `kitefin/camera-isp` | `isp-4.1`: Shipped with K3 firmware 26.08 · `isp-4.2`: Bilateral denoise with halo clamp |
| `kitefin/inference-gateway` | `v2.3.0`: Dynamic batching · `v2.4.0`: Sharded result cache |
| `kitefin/detector` | `kd-1.2`: fp32, 320 px · `kd-1.3`: int8, per-channel, recalibrated |
| `kitefin/slam` | `fw-26.08`: Frame-to-frame ICP · `fw-26.09`: Loop closure |
| `kitefin/fleet-assistant` | `assistant-0.4`: Tool calling · `assistant-0.5`: Confirmation before actions |

### Batches, platforms, users
- The CI batch has the label `default` (shown as **CI**). Tuning batches are labeled `tune-<what>` (`tune-batching`),
  local runs `<handle>-<what>`.
- The platform is `linux`; the camera ISP adds `hw-model` (the fixed-point model of the camera chip).
- Runs started from the web app or by a person show that persona as the user; CI runs show `ci`.

## Layout of an example

Each example is self-contained, so `qa init --template <example>` can copy it alone:

```
examples/<name>/
  SPEC.md            # what it computes, metrics, visualizations, batches, story, budgets, shots
  README.md          # run it yourself
  LICENSES.md        # every input: source, author, license, retrieval date
  qaboard.yaml       # project.name = the project id above, reference_branch: main
  qa/main.py         # run() and postprocess()
  qa/metrics.yaml    # metrics, see SPEC.md
  qa/batches.yaml    # the tests
  inputs.lock.yaml   # inputs fetched at first run: path, url, sha256, bytes, license
  story.yaml         # the history, see STORY.md
  story_checks.py    # optional custom assertions for the story
```

- **Flags:** what a story commit changes in the code (an algorithm, a default, a bug) is read by the code from
  `build/flags.json` in the project root. The seeder writes it for each commit; `qa save-artifacts` saves it
  (`artifacts.build.glob: build/flags.json`), so **Artifacts & Configs** shows each commit's change as a diff. Without
  the file, the code uses its own defaults, which match the head of `main` at T0.
- **Inputs:** generated by the project's code, or released under CC0 or in the public domain. Large files are
  downloaded from their original public URL and checked against `inputs.lock.yaml` (SHA-256); CI uses a mirror in R2.
  No identifiable people as the subject of a photo, no prominent logos.
- **Determinism:** random generators are seeded from the input and the story's seed. Timings, profiles and anything
  measured on the machine vary between seeds; that's why captures use a snapshot.
- **Budget:** a project's CI batch fits in a few minutes on a 4-CPU runner; each `SPEC.md` gives its numbers.
