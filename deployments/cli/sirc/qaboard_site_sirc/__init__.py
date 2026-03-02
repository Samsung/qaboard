"""QABoard site defaults for Samsung SIRC."""
import os

defaults = {
    "QABOARD_URL": "https://qa",
    "QABOARD_API_PREFIX": "http://qa:5000",
    # We want to allow users to use the Gitlab API (limited scope: CI statuses) without having to login
    # to stay backward compatible and not have credentials in any repo
    "QA_SECRETS": '/home/ispq/.secrets.yaml' if os.name != 'nt' else '//mars/raid/users/ispq/.secrets.yaml',
}
