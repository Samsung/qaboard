# project: image-quality
# user: ines
# env: QA_BATCH_QUIET=1 QA_BATCH_CONCURRENCY=1
# alt: A terminal runs qa --share batch ci on the camera pipeline: qa prints the link to the results, then the runs start one after the other, each printing its image, the ISP stages and their times.
# caption: qa batch runs your code on each input and configuration of a batch; with --share, it prints the link to the results.
# poster: last
# dedupe_mask: 0,76,1280,644
# dedupe_tolerance: 0.001
#
# cli/batch (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only cli/batch
# The camera ISP's ci batch (examples/image-quality/qa/batches.yaml: 9 images in 2 configurations), shared with the demo
# stack on the head of main at T0, in a batch of its own (--label), which the hidden teardown deletes: it isn't part of
# the demo snapshot, and other shots capture that commit.
# qa prints the link first, then the runs' logs (QA_BATCH_QUIET: without the list of the runs' commands, and one run at
# a time: their logs would scroll the link away). The tape ends while the runs run: their logs and times change with every recording, so
# dedupe_mask hides them from publish.py's comparison; the teardown waits for the runs, then deletes the batch.
Source "tapes/_settings.tape"
Output out/cli/batch/tape.mp4
Output out/cli/batch/tape.webm

# drop: deletes the batch this tape shares (and a leftover from a failed recording), its runs and their outputs
Hide
Type `drop() { curl -sf -c /tmp/qa-tape-cookies -d username=$QA_USER -d password=kitefin-demo $QABOARD_URL/api/v1/user/auth/ >/dev/null && id=$(curl -sf "$QABOARD_URL/api/v1/commit/$SHA?project=kitefin/camera-isp" | python -c 'import json, sys; print(next((b["id"] for label, b in json.load(sys.stdin)["batches"].items() if label.endswith("my-batch")), ""))') && if [ -n "$id" ]; then curl -sf -b /tmp/qa-tape-cookies -X DELETE $QABOARD_URL/api/v1/batch/$id/ >/dev/null; fi; rm -rf /mnt/qaboard/kitefin/camera-isp/${SHA:0:2}/${SHA:2:14}/output/$QA_USER-my-batch; }`
Enter
Type "cd ~/kitefin/camera-isp && SHA=$(cat .git/refs/heads/main) && drop && clear"
Enter
Wait@60s /\$$/
Show

Sleep 800ms
Type "qa --share --label my-batch batch ci"
Sleep 700ms
Enter
# qa notifies QA-Board of each run, then prints the link
Hide
Wait+Screen@60s /Results:/
Show
Sleep 3s

# the runs take about a minute
Hide
Wait@300s /\$$/
Type "drop && clear"
Enter
Wait@60s /\$$/
