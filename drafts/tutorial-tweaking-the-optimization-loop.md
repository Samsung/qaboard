
## Working on the optimization loop
1. it's easier to reproduce a real tuning
   https://qa/CDE-Users/HW_ALG/CIS/tests/products/HM3/commit/1e357ad1fffbfaf2a172f01646417e1dce25650f?batch=auto_tuning_try_4&reference=1e357ad1fffbfaf2a172f01646417e1dce25650f&selected_views=logs&selected_metric=objective&aggregation=media

2. get the script that start the tuning
   https://qa/s/stage/algo_data/ci/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/output/auto-tuning-try-4/qa_batch.sh
   (there used to be a direct link in the UI...)


3. Go to your VDI, and open a bash shell on LSF:
   bsub -Is bash

4. Clone:
      git clone git@gitlab-srv/common-infrastructure/qaboard
5. Install the qaboard CLI locally:
      pip install --editable '.[optimize]'

6. Go to HW_ALG
     git checkout 1e357ad1fffbfaf2a172f01646417e1dce25650f
     git submodule update --remote
     cd CIS
     make
     cd tests/products/HM3

7. Make sure you use your own "qa", not the one from the CI, e.g.
   export PATH=/home/arthurf/anaconda3/bin:$PATH

7. qa --share --label tuning-test optimize --batches-file "/algo/CIS_artifacts/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/tests_nxtc.yaml" --batches-file "/algo/CIS_artifacts/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/tests.yaml" --batches-file "/home/ispq/qaboard_data_prod/shared/CDE-Users/HW_ALG/CIS/tests/products/HM3/extra-batches.yml" --config-file '/stage/algo_data/ci/CDE-Users/HW_ALG/1e/357ad1fffbfaf2/CIS/tests/products/HM3/output/auto-tuning-try-4/optim-config.yaml' --batch HM3_Nona_ISP_ONLY

8. Edit qaboard/optimize.py#L42-L44


It’s possible to parallelize the runs. We could run 20 at a time on LSF….
https://scikit-optimize.github.io/stable/auto_examples/parallel-optimization.html

Concretely, in our code we could
-	Read from the user-supplied config how parallel we can be…
-	Replace this
  https://github.com/Samsung/qaboard/blob/master/qaboard/optimize.py#L42-L44
with something that works exactly like the 1st example here:
  https://scikit-optimize.github.io/stable/auto_examples/parallel-optimization.html#example
If you want to try it, I can help you run the optimization loop locally:
-	Edit & Run the tuning CLI command (copy-paste it from the logs from the web application)

