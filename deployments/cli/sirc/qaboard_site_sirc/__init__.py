"""QABoard site defaults for Samsung SIRC."""

defaults = {
    "QABOARD_URL": "https://qa",
    "QATOOLS_DB_PROTOCOL": "http",
    "QATOOLS_DB_HOST": "qa",
    "QATOOLS_DB_PORT": "5000",
    "QABOARD_API_PORT": "5000",
    # TODO: remove hardcoded SIRC fallback
    "QA_SECRETS": "/home/ispq/.secrets.yaml",
}
