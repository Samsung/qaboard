"""QABoard site defaults for Samsung SIRC."""
import os
import json
from pathlib import Path

defaults = {
    "QABOARD_URL": "https://qa",
    # The server shows these avatars for GitLab users who didn't upload one (except LDAP guests)
    "QABOARD_AVATAR_URL": "https://dag.sirc.co.il:8081/{user_name}.jpg",
    # Talk to the API on https://qa without checking its certificate, instead of a dedicated http port
    "QABOARD_API_VERIFY": "false",
    # Errors of `qa` in CI are reported to Sentry
    "QABOARD_SENTRY_DSN": "https://09ed52c49322629052df6b6e6cf334c5@sentry.transchip.com/30",
    "QABOARD_SENTRY_VERIFY": "false",
    # We want to allow users to use the Gitlab API (limited scope: CI statuses) without having to login
    # to stay backward compatible and not have credentials in any repo
    "QA_SECRETS": '/home/ispq/.secrets.yaml' if os.name != 'nt' else '//mars/raid/users/ispq/.secrets.yaml',
    "QABOARD_UPGRADE_COMMAND": "pip install --upgrade git+ssh://git@gitlab-srv/common-infrastructure/qaboard",
    # Base qaboard.yaml for all projects: they are merged on top of it
    "QABOARD_SITE_CONFIG": str(Path(__file__).with_name("qaboard.yaml")),
    # When IDB updates fail, we save them here to retry later
    "QABOARD_IDB_BACKLOG_DIR": "/home/ispq/idb_backlog",
    "QABOARD_PATH_MAPPINGS": json.dumps([
        ["\\\\netapp\\algo_data", "/stage/algo_data"],
        ["\\\\netapp2\\algo_data", "/stage/algo_data"],
        ["\\\\netapp\\algo-datasets", "/stage/algo-datasets"],
        ["\\\\f2\\algo_archive", "/stage/algo_archive"],
        ["\\\\mars\\stage\\jenkins_ws", "/stage/jenkins_ws"],
        ["\\\\mars\\stage\\algo_jenkins_ws", "/stage/algo_jenkins_ws"],
        ["\\\\mars\\raid\\data\\DATASYNC", "/raid/data/DATASYNC"],
        ["\\\\netapp\\algo_ws", "/algo/ws"],
        ["\\\\netapp\\vol23_algo", "/algo"],
        ["\\\\netapp\\vol24_algo", "/algo"],
        ["\\\\mars\\algo", "/algo"],
        ["\\\\mars\\raid\\algo", "/algo"],
        ["\\\\mars\\raid", "/raid"],
        ["\\\\mars\\stage\\algo_db", "/stage/algo_db"],
        ["\\\\netapp\\raid\\users", "/home"],
        ["\\\\netapp\\QA-Data", "/stage/qa_data"],
        ["\\\\f2\\algo-datasets", "/stage/algo-datasets"],
        ["\\\\mars\\data", "/data"],
        ["\\\\netapp\\Joint", "/net/netapp/vol/home_nt/Joint"],
        ["\\\\mars\\sim", "/sim"],
        ["\\\\mars\\stage", "/stage"],
        ["\\\\netapp\\vol19_data", "/net/netapp/vol/vol19_data"],
    ]),
}
