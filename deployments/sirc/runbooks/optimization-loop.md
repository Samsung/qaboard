# Working on the optimization loop (`qa optimize`)
Notes to reproduce and debug a tuning run of SIRC's projects (formerly `drafts/`).

1. it's easier to reproduce a real tuning
   https://qa/CDE-Users/HW_ALG/CIS/tests/products/HM3/commit/1e357ad1fffbfaf2a172f01646417e1dce25650f?batch=auto_tuning_try_4&reference=1e357ad1fffbfaf2a172f01646417e1dce25650f&selected_views=logs&selected_metric=objective&aggregation=media

2. get the script that start the tuning
   https://qa/s/stage/algo_data/ci/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/output/auto-tuning-try-4/qa_batch.sh
   (there used to be a direct link in the UI...)


3. Go to your VDI, and open a bash shell on LSF:
   bsub -Is bash

4. Clone:
      git clone git@gitlab-srv/common-infrastructure/qaboard
5. Install the qaboard CLI locally (Optuna is a dependency, it needs Python 3.9 or later):
      pip install --editable .

6. Go to HW_ALG
     git checkout 1e357ad1fffbfaf2a172f01646417e1dce25650f
     git submodule update --remote
     cd CIS
     make
     cd tests/products/HM3

7. Make sure you use your own "qa", not the one from the CI, e.g.
   export PATH=/home/arthurf/anaconda3/bin:$PATH

7. qa --share --label tuning-test optimize --batches-file "/algo/CIS_artifacts/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/tests_nxtc.yaml" --batches-file "/algo/CIS_artifacts/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/tests.yaml" --batches-file "/home/ispq/qaboard_data_prod/shared/CDE-Users/HW_ALG/CIS/tests/products/HM3/extra-batches.yml" --config-file '/stage/algo_data/ci/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/output/auto-tuning-try-4/optim-config.yaml' --batch HM3_Nona_ISP_ONLY

   The search is saved after each evaluation in optuna-journal.log, in the experiment's batch directory (or where
   `--checkpoint` says: commands copied from the web app's logs pass the same path). Running the same command again,
   with the same label, resumes it. To start over, use another `--label`, or `resume: false` in the config.
   Configs from before Optuna, like the optim-config.yaml above, may have old `solver` keys (`base_estimator`,
   `n_initial_points`, `random_state`, `acq_func`...): `qa optimize` refuses them and says what to write instead,
   see https://samsung.github.io/qaboard/docs/auto-optimization#scikit-optimize

8. Edit the code:
   - qaboard/optimization.py: the search loop, `run_optimization` (scheduling, early stopping, reporting each
     evaluation in order), and the samplers, `make_sampler`.
     https://github.com/Samsung/qaboard/blob/master/qaboard/optimization.py
   - qaboard/optimize.py: the `qa optimize` CLI, and `objective()` in `init_optimization`, which runs `qa batch` for
     each evaluation and computes its loss.
     https://github.com/Samsung/qaboard/blob/master/qaboard/optimize.py


Evaluations can run in parallel, e.g. 20 at a time on LSF: `parallel_sampling: 20` in the config, or
`--parallel-param-sampling 20`. Scheduling is completion-driven: a new evaluation starts as soon as one ends, so a
slow one doesn't hold the other slots. With the TPE sampler, `constant_liar` keeps evaluations that run at the same
time from all trying the same parameters. See `run_optimization` in qaboard/optimization.py.

To run the optimization loop locally:
-	Edit & Run the tuning CLI command (copy-paste it from the logs from the web application)

