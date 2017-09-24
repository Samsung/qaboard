# Visualization of SLAM results
Debug SLAM results faster.

## How to run
Install `python3` with [annaconda](https://www.continuum.io/downloads), and run:
```bash
python server.py`
```
Change the `config.py` if needed.

## Expected directory structure
SLAM outputs (metrics, curves, videos…) are expected to be organized like:
```
$ci_commits_directory/                                      # from config.py
    %Y-%m-%d_%H-%M-%S__local__$user/                        # identifies the code version.
        mono_slam/params_linux.json
        tests/config.py                                     # specifies which movies where run
        output/
            my/recording1/                                  # from $recordings_directory/my/recording1.bin
                        poses.txt                           # abcxyzt
                        poses_debug.csv                     # abcxyzt + more
                        curves.jpg                          # plots of xyzt...
                        results.realtime.mp4                # teapot rendering
                        lost-metrics.json                   # drift_pc, compute_time, lost_pc, jitter...
```

## How to edit
The application is written as a [Flask](https://flask.pocoo.org) server.
- `server.py` specified the endpoints, which return directly HTML...
- ...using the templates defined in `/templates/`...
- ...and the classes in `models.py`.

## Endpoints
- `/?search=XXX`
- `/commit/$ID`
- `/commit/latest`
- `/compare?reference=$REF_ID&new=$NEW_ID`

## TODO
- show the history for each metric and movie
- VR and nicer 6dof rendering