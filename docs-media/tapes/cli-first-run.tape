# project: image-quality
# user: ines
# alt: A terminal runs qa run on the slanted-edge chart: the pipeline logs each ISP stage, prints the run's metrics, then a link to the results in QA-Board.
# caption: qa run runs your code on one input, prints its metrics, and links to the results.
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
Type "qa --share run --input charts/slanted-edge.png"
Sleep 700ms
Enter
# the run takes a few seconds: wait for the prompt to come back
Wait@90s /\$$/
Sleep 4s
