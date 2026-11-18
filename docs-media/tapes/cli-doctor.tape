# project: image-quality
# user: ines
# alt: A terminal runs qa doctor in the camera ISP's folder: every check passes, for the project, the server, the results storage and the local runner. Then qa doctor --runner lsf fails: bsub isn't on the PATH, followed by how to fix it.
# caption: qa doctor checks what a batch needs, in order, and prints how to fix each problem it finds.
# poster: last
# dedupe_mask: 945,406,155,24 390,525,600,24 945,359,155,24
# dedupe_tolerance: 0.001
#
# cli/doctor (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only cli/doctor
# The camera ISP's workspace against the demo stack, with its local runner: every check passes (not signed in is fine
# for the demo stack, which accepts unverified results). Then the LSF runner, which the workspace doesn't have: the
# check fails with its fix. Both outputs are taller than the terminal: they scroll, and end on their summary.
# Measured, so they change from one recording or machine to the next (README.md#determinism): the free space of the
# results storage and the number of CPUs, which dedupe_mask hides from publish.py's comparison, where the two outputs
# show them.
# The dedupe tolerance: VHS types in real time, a character can show a frame later (0.06% of a frame).
Source "tapes/_settings.tape"
Output out/cli/doctor/tape.mp4
Output out/cli/doctor/tape.webm

Hide
Type "cd ~/kitefin/camera-isp && clear"
Enter
Show

Sleep 800ms
# the project's default runner: local
Type "qa doctor"
Sleep 700ms
Enter
Hide
Wait@60s /\$$/
Show
Sleep 7s

# another runner, before switching to it
Hide
Type "clear"
Enter
Show
Sleep 600ms
Type "qa doctor --runner lsf"
Sleep 700ms
Enter
Hide
Wait@60s /\$$/
Show
Sleep 8s
