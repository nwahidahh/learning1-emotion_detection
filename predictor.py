"""
Simple, replaceable emotion predictor module.

Currently uses a lightweight heuristic on an input image to produce
valence (range -1..1) and arousal (0..1). Replace `load_model` and
`predict_from_image` implementation with a trained regression model
(PyTorch/ONNX/TensorFlow) for production or research experiments.
"""
from io import BytesIO
from PIL import Image
import numpy as np
import time


def load_model(path: str = None):
    """Placeholder loader for a trained model. If `path` is provided,
    load the model; otherwise operate in dummy mode.
    """
    # TODO: load actual model here (ONNX/Torch/TF)
    return {"mode": "dummy", "loaded_at": time.time()}


def predict_from_image_bytes(image_bytes: bytes, model=None):
    """Return a dict {'valence': float, 'arousal': float}.

    Heuristic: mean brightness -> arousal, mean green-blue difference -> valence.
    This is only a stand-in for a learned model.
    """
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    mean = arr.mean()
    # arousal: brighter frames -> higher arousal (0..1)
    arousal = float(np.clip((mean - 0.3) / 0.7, 0.0, 1.0))
    # valence proxy: green minus blue average -> [-1,1]
    gb = arr[:, :, 1].mean() - arr[:, :, 2].mean()
    valence = float(np.clip(gb * 3.0, -1.0, 1.0))
    return {"valence": valence, "arousal": arousal}


if __name__ == "__main__":
    print("predictor module loaded (dummy). Replace with real model for research.)")
