# project: image-quality
# user: ines
# alt: A terminal runs qa run on the slanted-edge chart: qa prints where the outputs go, the pipeline logs each ISP stage and its time, then the run's metrics.
# caption: qa run runs your code on one input, saves its outputs and prints its metrics.
# poster: last
#
# cli/first-run (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only cli/first-run
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
# the run takes a few seconds: wait for the prompt to come back
Wait@90s /\$$/
Sleep 4s
