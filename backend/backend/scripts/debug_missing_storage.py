import json
from datetime import datetime
from pathlib import Path

from backend.models import Output
from backend.database import db_session, Session

user = 'itamarp'
user = 'omera'

# find /algo/HM6/outputs -user itamarp > itamarp.txt
owned_files_path = Path(f'/home/arthurf/qaboard/{user}.txt')
owned_files_info_path = owned_files_path.with_suffix('.info.txt')

# NFS used 65536 blocks, but empty blocks don't count in the quotas
# so we can use the underlying FS block size
f_frsize = 4096

def update():
    nb_folders = 0
    nb_files = 0
    total_size = 0
    total_storage = 0
    files = []
    for line in owned_files_path.read_text().splitlines():
        nb_files += 1
        path = Path(line.strip())
        if not path.exists():
            print("missing", path)
            continue
        if path.is_dir():
            nb_folders += 1
            continue
        size = path.stat().st_size
        total_size += size
        storage = (size // f_frsize) * f_frsize +  f_frsize if size % f_frsize != 0 else 0
        total_storage += storage
        files.append((str(path), size, storage))
    print(f"total_size {total_size/1024/1024:.3f}MB ({total_size})")
    print(f"storage {total_storage/1024/1024:.3f}MB ({total_storage})")
    print("nb_folders", nb_folders)
    print("nb_files", nb_files)
    total_size += nb_folders * 8 * 1024
    total_storage += nb_folders * 8 * 1024
    # total_storage += (nb_files - nb_folders) * 4096
    # inode?
    print(f"total_size {total_size/1024/1024:.3f}MB ({total_size})")
    print(f"storage {total_storage/1024/1024:.3f}MB ({total_storage})")
    with owned_files_info_path.open('w') as f:
        json.dump(files, f)

refresh = False
# refresh = True
if not owned_files_info_path.exists() or refresh:
    update()
with owned_files_info_path.open() as f:
    files = json.load(f)
files_info = [(Path(path), size, storage) for path, size, storage in files]

def filter_files(filter):
    import re
    files = [(path, size, storage) for path, size, storage in files_info if re.search(filter, str(path))]
    total_storage = 0
    # files.sort(key=lambda x: -x[1])
    for path, size, storage in files[:50]:
        print(f"{storage/1024/1024:.2f}MB", path)
        total_storage += storage
    print(f"filtered {filter} storage {total_storage/1024/1024:.3f}MB ({total_storage})")
# filter_files('(log(.lsf)?.txt|manifest)')
# filter_files('/share/') # 12G
# exit(0)

# todo: check for files 1 parent is a dir with manifest.outputs.json


files = [path for path, size, storage in files_info]
# the manifest output files may end up owned by arthurf
output_dirs = set([path.parent for path in files if path.name == 'run.json'])

def is_in_output_dirs(path):
    return any([parent in output_dirs for parent in path.parents])

# for file in files:
#     if file.is_file() and not is_in_output_dirs(file):
#         # when tuning those files are created
#         is_batch_related = file.name in ['start.sh', 'log.txt', 'qa_batch.sh']
#         is_from_export = '/share/' in str(file)
#         if not is_batch_related and not is_from_export:
#             print(file)
#             exit(0)


print(len(output_dirs), "output directories")
max_ctime = 0
output_dirs_missing = []
for output_dir in output_dirs:
    # find all run.json, check parentin 
    output = db_session.query(Output).filter(Output.output_dir_override==str(output_dir)).one_or_none()
    if not output:
        output_dirs_missing.append(output_dir)
        ctime = output_dir.stat().st_ctime
        print(datetime.fromtimestamp(ctime))
        if ctime > max_ctime:
            max_ctime = ctime
        print(output_dir)
        # exit(0)


print(len(output_dirs), "output directories on disk")
print(len(output_dirs_missing), "missing in QA-Board - seems fine to delete")
print(max_ctime, "latest")
print(datetime.datetime.fromtimestamp(max_ctime))
# TODO: check in DB wtf where is it? like dir ...