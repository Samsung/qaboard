"""QABoard site defaults for Samsung SIRC."""
import os
import json

defaults = {
    "QABOARD_URL": "https://qa",
    "QABOARD_API_PREFIX": "http://qa:5000",
    # We want to allow users to use the Gitlab API (limited scope: CI statuses) without having to login
    # to stay backward compatible and not have credentials in any repo
    "QA_SECRETS": '/home/ispq/.secrets.yaml' if os.name != 'nt' else '//mars/raid/users/ispq/.secrets.yaml',
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
