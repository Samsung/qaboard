import os
import requests

# the script assumes you'll work in a git working directory exactly at
repo_path = "/home/ispq" # under "/CDE-Users/HW_ALG"

r = requests.get('http://qa/api/v1/projects')
projects = r.json()
for project, data in projects.items():
    if 'product' not in project:
        continue
    if 'HM1' in project:
        continue
    print(project)
    milestones = data.get('data').get('milestones', {})
    for m in milestones.values():
        commit = m['commit']
        print('>', commit)
        # continue
        os.chdir(f'{repo_path}/{project}')
        os.system(f"git checkout {commit}")
        # exit(0)
        # if not workppace
        os.system("git checkout develop qatools.yaml")
        os.system("qa save-artifacts")
        os.system("git reset --hard")
        os.system("git clean -fd")

