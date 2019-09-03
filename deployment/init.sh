#!/usr/bin/env bash
# todo: https://github.com/Yelp/dumb-init
# todo: https://docs.docker.com/compose/overview/

set -evx
export LC_ALL=C.UTF-8
export LANG=C.UTF-8

echo 'starting'

echo '...preparing ssh-agent'
export SSH_ASKPASS=$HOME/askpass
echo -e '#!/usr/bin/env bash\necho "${SSH_PASSPHRASE}"' > $SSH_ASKPASS; chmod +x $SSH_ASKPASS
eval `ssh-agent`
DISPLAY= setsid ssh-add $HOME/.ssh/id_rsa
# now that we use arthurf as user, we may not need this...
# TODO: clean this...
# ssh-keyscan gitlab-srv >> $HOME/.ssh/known_hosts

# TODO: Maybe this can be removed once the old volumes
# are owned by arthurf and not root 
# sudo chown -R arthurf:uucp /var/slamvizapp


sudo nginx &

echo '...starting the database'
# initdb -D /usr/local/pgsql/data
# pg_createcluster
sudo /etc/init.d/postgresql start &
sleep 10

# the first time you may need to
# #docker run --entrypoint /bin/bash --rm -it  --volume=slamvizapp-postgresql-production:/etc/postgresql --volume=slamvizapp-postgresql-log-production:/var/log/postgresql --volume=slamvizapp-postgresql-lib-production:/var/lib/postgresql  gitlab-srv.transchip.com:4567/dvs/slamvizapp:production

# sudo pg_createcluster 10 main

# sudo -u postgres /usr/lib/postgresql/9.6/bin/postgres \
#   -D /var/lib/postgresql/9.6/main \
#   -c config_file=/etc/postgresql/9.6/main/postgresql.conf &
# sudo su postgres
# psql -d slamvizapp
# \dt
# select count(*) from outputs;
# alter table outputs rename to outputs_backup;
# alembic stamp f6a4bc0b55f8
# alembic upgrade +1
# alembic stamp head
# drop table..
# EXPLAIN ANALYZE SELECT ci_commits.id AS ci_commits_id, ci_commits.project_id AS ci_commits_project_id, ci_commits.authored_datetime AS ci_commits_authored_datetime, ci_commits.branch AS ci_commits_branch, ci_commits.committer_name AS ci_commits_committer_name, ci_commits.message AS ci_commits_message, ci_commits.commit_dir_override AS ci_commits_commit_dir_override, ci_commits.commit_type AS ci_commits_commit_type, ci_commits.time_of_last_batch AS ci_commits_time_of_last_batch, ci_commits.latest_gitlab_pipeline AS ci_commits_latest_gitlab_pipeline, test_inputs_1.id AS test_inputs_1_id, test_inputs_1.path AS test_inputs_1_path, test_inputs_1.database AS test_inputs_1_database, test_inputs_1.data AS test_inputs_1_data, test_inputs_1.stereo_baseline AS test_inputs_1_stereo_baseline, test_inputs_1.is_wide_angle AS test_inputs_1_is_wide_angle, test_inputs_1.duration AS test_inputs_1_duration, test_inputs_1.is_dynamic AS test_inputs_1_is_dynamic, test_inputs_1.is_static AS test_inputs_1_is_static, test_inputs_1.is_calibration AS test_inputs_1_is_calibration, test_inputs_1.is_low_light AS test_inputs_1_is_low_light, test_inputs_1.is_flickering AS test_inputs_1_is_flickering, test_inputs_1.is_hdr AS test_inputs_1_is_hdr, test_inputs_1.motion_is_translation AS test_inputs_1_motion_is_translation, test_inputs_1.motion_is_rotation AS test_inputs_1_motion_is_rotation, test_inputs_1.motion_axis AS test_inputs_1_motion_axis, test_inputs_1.motion_speed AS test_inputs_1_motion_speed, outputs_1.id AS outputs_1_id, outputs_1.batch_id AS outputs_1_batch_id, outputs_1.created_date AS outputs_1_created_date, outputs_1.output_dir_override AS outputs_1_output_dir_override, outputs_1.output_type AS outputs_1_output_type, outputs_1.test_input_id AS outputs_1_test_input_id, outputs_1.platform AS outputs_1_platform, outputs_1.configuration AS outputs_1_configuration, outputs_1.extra_parameters AS outputs_1_extra_parameters, outputs_1.is_pending AS outputs_1_is_pending, outputs_1.is_running AS outputs_1_is_running, outputs_1.is_failed AS outputs_1_is_failed, outputs_1.metrics AS outputs_1_metrics, outputs_1.data AS outputs_1_data, batches_1.id AS batches_1_id, batches_1.created_date AS batches_1_created_date, batches_1.ci_commit_id AS batches_1_ci_commit_id, batches_1.label AS batches_1_label FROM ci_commits LEFT OUTER JOIN batches AS batches_1 ON ci_commits.id = batches_1.ci_commit_id LEFT OUTER JOIN outputs AS outputs_1 ON batches_1.id = outputs_1.batch_id LEFT OUTER JOIN test_inputs AS test_inputs_1 ON test_inputs_1.id = outputs_1.test_input_id WHERE ci_commits.project_id = 'dvs/psp_swip' AND ci_commits.authored_datetime <= '2018-07-02 13:16:10+00' AND ci_commits.authored_datetime >= '2018-06-28 13:16:10+00' ORDER BY ci_commits.authored_datetime DESC, batches_1.created_date;


echo '...applying database migrations'
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
cd /slamvizapp/slamvizapp
alembic upgrade head || alembic downgrade head || alembic stamp head

# echo '...executing as...'
# useradd -u 11611 -g 10 arthurf -s /usr/bin/zsh
# su arthurf
# runuser -u arthurf -- *

# echo '...initializing the database'
# sleep 1800 && slamvizapp_init_database --scrap-from slam --loop &
# slamvizapp_init_database --scrap-from cis --loop &
# slamvizapp_init_database --verbose

echo '...starting the application'
sleep 2
sudo chmod 777 /slamvizapp/deployment/
cd /slamvizapp && sudo -E /opt/anaconda3/bin/uwsgi --ini /slamvizapp/deployment/slamvizapp.ini &

# export LC_ALL=C.UTF-8
# export LANG=C.UTF-8
cd /slamvizapp && SLAMVIZAPP_DB_ECHO=True FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads --port 5002 &

# command
# status=$?
# if [ $status -ne 0 ]; then
#   echo "Failed to start my_first_process: $status"
#   exit $status
# fi


# on the server there is a crontab that does every night
#    slamvizapp_clean

while sleep 43200; do
  echo OK
  # slamvizapp_clean dvs/psp_swip --protected-branch "origin/develop" --protected-branch "origin/Release/AugustDemo"
  # slamvizapp_clean tof/swip_tof --protected-branch "origin/develop" --days 30
done



# pg_dump --dbname=slamvizapp --username=ci --password -h localhost -Fc > ~/dvs/slamvizapp/data/backup/$(date --rfc-3339=date).dump

# quid: check access permissions
# https://gist.github.com/d11wtq/8699521
# eval "$(ssh-agent -s)"
# ssh-add ~/.ssh/id_rsa
# ssh -o StrictHostKeyChecking=no git@gitlab-srv:dvs/psp_swip
# git clone git@gitlab-srv:dvs/psp_swip
exec "${@}"
