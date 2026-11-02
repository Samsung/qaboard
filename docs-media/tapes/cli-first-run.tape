# project: image-quality
# user: ines
# alt: A terminal runs qa run on the slanted-edge chart: qa prints where the outputs go, the pipeline logs each ISP stage and its time, then the run's metrics.
# caption: qa run runs your code on one input, saves its outputs and prints its metrics.
# poster: last
# dedupe_mask: 410,146,75,120 795,264,485,24 278,312,1002,24
# dedupe_tolerance: 0.001
#
# cli/first-run (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only cli/first-run
# The times are measured, so they change with every run (README.md#determinism): dedupe_mask hides from publish.py's
# comparison the stages' times, the runtime on the metrics line, and the end of the metrics printed below it.
# The dedupe tolerance: VHS types in real time, a character can show a frame later (0.06% of a frame).
Source "tapes/_settings.tape"
Output out/cli/first-run/tape.mp4
Output out/cli/first-run/tape.webm

Hide
Type "cd ~/kitefin/camera-isp && clear"
Enter
Show

Sleep 800ms
# a local run: without --share, nothing is sent to the demo server
Type "qa run --input charts/slanted-edge.png"
Sleep 700ms
Enter
# the run takes a few seconds, more or less: its output appears at once when it's done
Hide
Wait@90s /\$$/
Show
Sleep 4s
