# user: ines
# passenv: QABOARD_IMAGE QABOARD_VERSION
# alt: A terminal creates a kind cluster with QA-Board's kind.yaml and installs the Helm chart with the quickstart values, which prints how to open QA-Board. Through a port-forward on 5151, the health check answers ok and the projects API lists the Kitefin demo projects.
# caption: helm install waits until QA-Board is ready and prints how to open it; through the port-forward, it answers with the demo projects.
# poster: last
# timeout: 1800
# dedupe_mask: 0,50,320,26 180,74,300,26 0,380,1280,26
# dedupe_tolerance: 0.002
#
# quickstart/kind (docs-media/shots.yaml). Recorded by: uv run docs-media/tapes/record.py --only quickstart/kind
# The Kubernetes quickstart (website/docs/get-started/quickstart.mdx), the commands of CI's helm-e2e job
# (.github/workflows/ci.yaml), from the repository's root. Needs kind, kubectl, helm, jq and about 8 GB of disk.
# - It answers on port 5151, the demo stack's: stop the demo stack first (docs-media.yml records it last, once the
#   demo stack is stopped). The cluster is deleted at the end.
# - The images are this checkout's, QABOARD_IMAGE and QABOARD_VERSION (passenv; QABOARD_IMAGE must name a registry,
#   e.g. ghcr.io/<owner>/qaboard or localhost/qaboard), with the demo-data image built from the snapshot
#   (`snapshot.py image --tag $QABOARD_IMAGE:demo-data-$QABOARD_VERSION`). Out of the video, they're loaded in the
#   node under the names the chart uses by default (ghcr.io/samsung/qaboard:<service>), so the visible commands are
#   the page's. Without QABOARD_IMAGE, the cluster pulls the published images.
# - The waits are cut: creating the cluster, loading the images, helm install (a few minutes).
# - dedupe_mask hides from publish.py's comparison what changes from one recording to the next: the port-forward's job
#   id and PID (line 2 of the last screen), when helm deployed (line 3), and kind's closing line, picked at random
#   (line 16). These positions are computed from the line height (23.6 px from y=28), not yet checked on a recording.
# The dedupe tolerance: VHS types in real time, a character can show a frame later (up to 0.1% of a frame).
Source "tapes/_settings.tape"
Output out/quickstart/kind/tape.mp4
Output out/quickstart/kind/tape.webm

Hide
Type "cd .. && set +m && kind delete cluster --name qaboard > /dev/null 2>&1; clear"
Enter
Wait@120s /\$$/
Show

Sleep 800ms
Type "# in a clone of QA-Board's repository"
Enter
Type "mkdir -p /tmp/qaboard"
Enter
Type "kind create cluster --name qaboard --config charts/qaboard/kind.yaml"
Sleep 700ms
Enter
Hide
Wait@600s /\$$/
Show
Sleep 3s

# This checkout's images, under the chart's default names
Hide
Type `if [ -n "$QABOARD_IMAGE" ]; then services="backend frontend website proxy cantaloupe demo-data"; images=$(for s in $services; do echo $QABOARD_IMAGE:$s${QABOARD_VERSION:+-$QABOARD_VERSION}; done); kind load docker-image --name qaboard $images && for s in $services; do docker exec qaboard-control-plane ctr -n k8s.io images tag --force $QABOARD_IMAGE:$s${QABOARD_VERSION:+-$QABOARD_VERSION} ghcr.io/samsung/qaboard:$s; done; fi > /tmp/qaboard-kind-load.log 2>&1; clear`
Enter
Wait@900s /\$$/
Show

Sleep 600ms
Type "helm install qaboard charts/qaboard -f charts/qaboard/quickstart.yaml --wait --timeout 15m"
Sleep 700ms
Enter
Hide
Wait@1200s /\$$/
Show
Sleep 6s

Hide
Type "clear"
Enter
Wait@10s /\$$/
Show
Sleep 600ms
Type "kubectl port-forward svc/qaboard-proxy 5151:80 > /dev/null &"
Enter
# Until the port-forward answers, then the command's line is erased
Hide
Type `until curl -so /dev/null localhost:5151/api/v1/health; do sleep 0.5; done; printf '\e[1A\e[2K'`
Enter
Wait@60s /\$$/
Show
Sleep 1s
Type "curl -s localhost:5151/api/v1/health"
Enter
Sleep 1500ms
Type "curl -s localhost:5151/api/v1/projects | jq 'map_values(.total_commits)'"
Enter
Sleep 2500ms
Type "# open http://localhost:5151"
Enter
Sleep 3s

Hide
Type "kill $!; kind delete cluster --name qaboard > /dev/null 2>&1; clear"
Enter
Wait@300s /\$$/
