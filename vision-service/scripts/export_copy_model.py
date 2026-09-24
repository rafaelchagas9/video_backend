"""Export the official SSCD TorchScript model once; production uses ONNX Runtime.

Run in an isolated environment with torch==2.9.1 (CPU), onnx==1.20.1, numpy==1.26.4.
The input must be the trusted official Meta model, never a user upload.
"""

import argparse
import hashlib
import json
from pathlib import Path

import onnx
import torch

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
source_digest = hashlib.sha256(args.source.read_bytes()).hexdigest()
if source_digest != "9f26bd4c848cc19b73d2ae92eea6e04886f61a7b764ceb7a13aeee62e6a6db56":
    raise ValueError("Expected the official, pinned sscd_disc_mixup TorchScript artifact")
args.destination.parent.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(2)
model = torch.jit.load(str(args.source), map_location="cpu").eval()
example = torch.zeros(8, 3, 288, 288)
with torch.inference_mode():
    torch.onnx.export(
        model,
        example,
        str(args.destination),
        input_names=["images"],
        output_names=["embeddings"],
        opset_version=17,
        dynamo=False,
    )
onnx.checker.check_model(str(args.destination))
manifest = {
    "model": "sscd_disc_mixup",
    "license": "MIT",
    "source_url": "https://dl.fbaipublicfiles.com/sscd-copy-detection/sscd_disc_mixup.torchscript.pt",
    "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
    "onnx_sha256": hashlib.sha256(args.destination.read_bytes()).hexdigest(),
    "input_shape": [8, 3, 288, 288],
    "dimensions": 512,
    "opset": 17,
    "torch_version": torch.__version__,
    "onnx_version": onnx.__version__,
    "normalization": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
}
args.destination.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest))
