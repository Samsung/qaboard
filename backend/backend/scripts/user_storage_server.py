"""
When running a migration we need to know user quotas, and update them.
Since we need multiple server to make the migration server, we need to sync them somehow...
The IT API is very slow..

Test URLs
- http://qatools01:3001/user/arthurf/storage
- http://qatools01:3001/user/arthurf/storage/project/HP2
- http://qatools01:3001/user/arthurf/storage/project/HP2/add?usage=2
- http://qatools01:3001/user/arthurf/storage

"""
import sys
import json
from pathlib import Path
from copy import deepcopy
from ast import literal_eval

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

missing_quota_info = {"volume": None, "used": 0, "limit": 100*1024*1024}

# NOTE: we assume we run with 1 thread only...
#       otherwise you need a sync: simplest is always writing to disk and reading from disk..
#       or work hard with pythn, or use e.g. redis...

# TODO:
# - we really should return a _list_ of {volume, project, quota}
#   since multiple volumes can refer to a project, and things are mounted at various locations..
#   We could parse mount and get the info...
# - the API to add storage should provide a mount point only and we should figure it out...
# - Then on the frontend it also require a bit of re-work,
#   we could query by project, group by volume/mount-point...  



def fetch_user_quota(username):
    r = requests.get(f"http://itweb01/quota/index.php?username={username}&limit=-1&type=raw")
    usage = {}
    # The response is not an array, but 1 line per record...
    for line in r.text.splitlines():
        # The type is printed between each record...
        if line == 'raw':
            continue
        info = literal_eval(line)
        # info = json.loads(line)  # if only we had JSON
        if 'Project' not in info: # we only care about volumes with Projects
            continue
        usage[info['Project']] = {
            "volume": info['Volume'],
            "used": float(info['Used']),
            "limit": float(info['Limit']) * 1024 * 1024,
        }
    return usage


user_quota_path = Path('user-quotas.json')
if user_quota_path.exists():
    if '--no-cache' in sys.argv:
        user_quota_path.unlink()
    with user_quota_path.open() as f:
        users_quotas = json.load(f)
else:
    users_quotas = {
        # "arthurf": {
        #    "some-volume": {"used": 10, "limit": 1024}
        # }
    }


def write_users_quotas():
    with user_quota_path.open('w') as f:
        json.dump(users_quotas, f)


def user_quota(username):
    if username not in users_quotas:
        quotas = fetch_user_quota(username)
        users_quotas[username] = quotas
        write_users_quotas()
    return users_quotas[username]


@app.route('/user/<user>/storage')
def all_quotas(user):
    return jsonify(users_quotas)

@app.route('/user/<user>/storage')
def all_user_storage(user):
    return jsonify(user_quota(user))


@app.route('/user/<user>/storage/project/<project>')
def user_storage(user, project):
    project_quota = user_quota(user).get(project, deepcopy(missing_quota_info))
    print("[get]", project_quota)
    return jsonify(project_quota)


@app.route('/user/<user>/storage/project/<project>/add')
def add_user_storage(user, project):
    project_quota = user_quota(user).get(project, deepcopy(missing_quota_info))
    project_quota['used'] += float(request.args['usage'])
    write_users_quotas()
    print("[after-add]", project_quota)
    return jsonify(project_quota)

@app.route('/project/<project>')
def project_storage(project):
    return jsonify({
        user: quotas[project] for user, quotas in users_quotas.items() if project in quotas
    })


if __name__ == '__main__':
    # we want to be sure we don't have sync issues between threads...
    # without involving _anything_ complicated
    app.run(
        host='0.0.0.0',
        port=3001,
        debug=None,
        reloader_type='watchdog',
        threaded=False,
    )
