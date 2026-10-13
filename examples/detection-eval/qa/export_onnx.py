# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["torch==2.14.1", "torchvision==0.29.1", "onnx==1.23.2", "numpy"]
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# torchvision = { index = "pytorch-cpu" }
# ///
"""
Exports torchvision's SSDlite320 MobileNetV3-Large (COCO weights) to ONNX at an input size: the backbone and the
detection head only, returning each anchor's box deltas and class logits. The anchors for that size are saved next
to it: qa/detector.py decodes the boxes and runs NMS in numpy.

    uv run qa/export_onnx.py --weights models/ssdlite320_mobilenet_v3_large_coco-a79551df.pth --out models --size 320

qa/models.py runs it when a model is missing. PyTorch is only needed here (CPU wheels, ~200 MB, in uv's cache).
"""
import argparse
from pathlib import Path

import numpy as np
import torch
import torchvision
from torchvision.models.detection.image_list import ImageList


class Network(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.backbone, self.head = model.backbone, model.head

    def forward(self, image):
        features = list(self.backbone(image).values())
        outputs = self.head(features)
        return outputs['bbox_regression'], outputs['cls_logits']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--weights', required=True, help='the .pth file of the COCO weights')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--size', type=int, action='append', required=True)
    args = parser.parse_args()
    torch.manual_seed(0)
    torch.set_num_threads(1)
    model = torchvision.models.detection.ssdlite320_mobilenet_v3_large(weights=None, weights_backbone=None, num_classes=91)
    model.load_state_dict(torch.load(args.weights, map_location='cpu', weights_only=True))
    model.eval()
    network = Network(model).eval()
    args.out.mkdir(parents=True, exist_ok=True)
    for size in args.size:
        image = torch.zeros(1, 3, size, size)
        with torch.no_grad():
            features = list(model.backbone(image).values())
            anchors = model.anchor_generator(ImageList(image, [(size, size)]), features)[0]
        model_path, anchors_path = args.out / f'fp32-{size}.onnx', args.out / f'anchors-{size}.npy'
        tmp = model_path.with_name(model_path.name + '.tmp')
        with torch.no_grad():
            torch.onnx.export(network, (image,), str(tmp), input_names=['image'], output_names=['deltas', 'logits'],
                              opset_version=17, dynamo=False)
        np.save(anchors_path, anchors.numpy().astype(np.float32))
        tmp.replace(model_path)
        print(f'{model_path.name}: {len(anchors)} anchors, feature maps {", ".join(f"{f.shape[-1]}x{f.shape[-2]}" for f in features)}')


if __name__ == '__main__':
    import warnings
    warnings.filterwarnings('ignore', category=DeprecationWarning)
    main()
