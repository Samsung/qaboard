import os
import sys

import pandas as pd
import matplotlib
matplotlib.use('Agg')
# matplotlib.use('GTKAgg') 
import matplotlib.pyplot as plt


def read_poses(output_dir):
    return pd.read_csv(
        str(output_dir/'camera_poses_debug.csv'),
        sep='\t', header=None, index_col=6, 
        names=['a','b','c','x','y','z','t','confidence','is_tracking_good'],
    )


def create_curves_comparaison_image(output_dir_ref, output_dir_new, commit_id_ref, overwrite=False):
    image_f = output_dir_new/f"curves_vs_{commit_id_ref}.jpg"
    if overwrite and image_f.exists():
        image_f.unlink()
    if not image_f.exists():
        poses_ref = read_poses(output_dir_ref)
        poses_new = read_poses(output_dir_new)
        poses_ref.index = poses_ref.index - poses_ref.index[0] + poses_new.index[0]
        # todo: ideally, plot the ref in light grey, then the other one on top with slight transparency and regular colors
        axes = poses_ref.tail(-1).plot(subplots=True, sharex=True, figsize=(6, 15), marker='o',  markersize=2);
        for i, ax in enumerate(axes):
            poses_new.tail(-1)[[i]].plot(ax=ax,  marker='o', markersize=2, alpha=0.8)
        plt.legend(loc='upper right')
        plt.savefig(str(image_f), bbox_inches='tight', pad_inches=0)
        # plt.show()
        sys.stdout.write('.')
