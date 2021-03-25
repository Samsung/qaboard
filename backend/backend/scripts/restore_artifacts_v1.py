"""
If there is no more space on the shared storage, we often end up with missing artifacts.
The script will restore them...
"""
import os

repo_dir = "/home/arthurf/CDE-Users/HW_ALG"
project = "CIS"
milestones = [
    ('HM1', '2a94c7e9'),
    ('HM1', '6682ed2a'),
    ('HM1', 'fbe9233c'),
    ('HM1', '107f2531'),
    ('HM1', '041a1e18'),
    ('HM1', 'fc337ff4'),
    ('HM1', 'b185f7d0'),
    ('HM1', '3d129470'),
    ('HM1', '70826d69'),
    ('HM1', '747a162d'),
    ('HM1', '934e18c7'),
    ('HM1', '747a162d'),
    ('HM1', '747a162d'),
]

for product, commit in milestones:
    print(product, commit)
    os.chdir(f'{repo_dir}/{project}/tests/products/{product}')
    os.system(f"git checkout {commit}")
    os.system("git checkout develop qatools.yaml")
    os.system("qa save-artifacts")
    os.system("git reset --hard")
