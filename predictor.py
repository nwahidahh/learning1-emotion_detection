"""
Simple, replaceable emotion predictor module.

Currently uses a lightweight heuristic on an input image to produce
valence (range -1..1) and arousal (0..1). Replace `load_model` and
`predict_from_image` implementation with a trained regression model
(PyTorch/ONNX/TensorFlow) for production or research experiments.
"""
from io import BytesIO
import os
from PIL import Image
import numpy as np
import time
import mediapipe as mp

try:
    import cv2
except Exception:
    cv2 = None

try:
    import onnxruntime as ort
except Exception:
    ort = None

try:
    import torch
except Exception:
    torch = None


class NoFaceDetectedError(RuntimeError):
    """Raised when no face ROI is found in input image."""


_MP_FACE_DETECTOR = None
_MP_TASKS_FACE_DETECTOR = None


def _resolve_face_task_model_path():
    env_path = os.environ.get("MP_FACE_MODEL_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    candidates = [
        "./face_detector.task",
        "./models/face_detector.task",
        "./assets/face_detector.task",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _get_mediapipe_tasks_face_detector():
    global _MP_TASKS_FACE_DETECTOR
    if _MP_TASKS_FACE_DETECTOR is not None:
        return _MP_TASKS_FACE_DETECTOR

    model_path = _resolve_face_task_model_path()
    if not model_path:
        return None

    if not hasattr(mp, "tasks"):
        return None

    try:
        base_options = mp.tasks.BaseOptions(model_asset_path=model_path)
        vision = mp.tasks.vision
        options = vision.FaceDetectorOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.IMAGE,
        )
        _MP_TASKS_FACE_DETECTOR = vision.FaceDetector.create_from_options(options)
    except Exception:
        _MP_TASKS_FACE_DETECTOR = None

    return _MP_TASKS_FACE_DETECTOR


def _get_mediapipe_face_detector():
    global _MP_FACE_DETECTOR
    if _MP_FACE_DETECTOR is None:
        _MP_FACE_DETECTOR = mp.solutions.face_detection.FaceDetection(
            model_selection=0,
            min_detection_confidence=0.35,
        )
    return _MP_FACE_DETECTOR


def _detect_face_bbox(img_np: np.ndarray):
    """Detect a face bbox in absolute pixel coordinates. Returns None if not found."""
    H, W, _ = img_np.shape

    # 0) MediaPipe Tasks detector (if face_detector.task is available)
    tasks_detector = _get_mediapipe_tasks_face_detector()
    if tasks_detector is not None:
        try:
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_np)
            detection_result = tasks_detector.detect(mp_image)
            if detection_result and detection_result.detections:
                faces = []
                for det in detection_result.detections:
                    bb = det.bounding_box
                    x1 = max(int(bb.origin_x), 0)
                    y1 = max(int(bb.origin_y), 0)
                    x2 = min(int(bb.origin_x + bb.width), W)
                    y2 = min(int(bb.origin_y + bb.height), H)
                    area = max(x2 - x1, 0) * max(y2 - y1, 0)
                    faces.append((area, x1, y1, x2, y2))
                if faces:
                    faces.sort(reverse=True)
                    _, x1, y1, x2, y2 = faces[0]
                    if x2 > x1 and y2 > y1:
                        return {
                            "x": x1,
                            "y": y1,
                            "width": x2 - x1,
                            "height": y2 - y1,
                            "source": "mediapipe_tasks",
                        }
        except Exception:
            pass

    # 1) MediaPipe detection on RGB image
    detector = _get_mediapipe_face_detector()
    results = detector.process(img_np)
    if results.detections:
        faces = []
        for det in results.detections:
            rel = det.location_data.relative_bounding_box
            x1 = max(int(rel.xmin * W), 0)
            y1 = max(int(rel.ymin * H), 0)
            x2 = min(int((rel.xmin + rel.width) * W), W)
            y2 = min(int((rel.ymin + rel.height) * H), H)
            area = max(x2 - x1, 0) * max(y2 - y1, 0)
            faces.append((area, x1, y1, x2, y2))
        faces.sort(reverse=True)
        _, x1, y1, x2, y2 = faces[0]
        if x2 > x1 and y2 > y1:
            return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1, "source": "mediapipe"}

    # 2) OpenCV Haar fallback (if available)
    if cv2 is not None:
        gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        detector_cv = cv2.CascadeClassifier(cascade_path)
        detected = detector_cv.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        if len(detected) > 0:
            x, y, w, h = max(detected, key=lambda r: r[2] * r[3])
            return {"x": int(x), "y": int(y), "width": int(w), "height": int(h), "source": "opencv"}

    return None


def _apply_timm_compat_fixes(model_obj):
    """Patch known missing attrs on older timm modules loaded via torch.load."""
    if torch is None or model_obj is None or not hasattr(model_obj, "modules"):
        return
    efficientnet_block_types = {"DepthwiseSeparableConv", "InvertedResidual"}
    for module in model_obj.modules():
        if module.__class__.__name__ in efficientnet_block_types:
            if not hasattr(module, "conv_s2d"):
                module.conv_s2d = None
            if not hasattr(module, "bn_s2d"):
                module.bn_s2d = torch.nn.Identity()
            if not hasattr(module, "aa"):
                module.aa = torch.nn.Identity()
            if not hasattr(module, "drop_path"):
                module.drop_path = torch.nn.Identity()


def load_model(path: str = None):
    """Load a model for arousal-valence regression (.onnx, .pt, .pth)."""
    if not path:
        raise ValueError("Model path must be provided.")
    if not os.path.exists(path):
        raise ValueError(f"Model file not found: {path}")

    ext = os.path.splitext(path)[1].lower()
    if ext == ".onnx":
        if ort is None:
            raise RuntimeError(
                "onnxruntime is not available in this environment. "
                "Install a compatible version or use a .pt/.pth model."
            )
        session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        return {"mode": "onnx", "session": session, "loaded_at": time.time(), "path": path}

    if ext in {".pt", ".pth"}:
        if torch is None:
            raise RuntimeError("PyTorch is required to load .pt/.pth models. Please install torch.")

        device = "cpu"
        try:
            jit_model = torch.jit.load(path, map_location=device)
            jit_model.eval()
            return {"mode": "torchscript", "session": jit_model, "loaded_at": time.time(), "path": path}
        except Exception:
            loaded_obj = torch.load(path, map_location=device)
            if hasattr(loaded_obj, "eval"):
                _apply_timm_compat_fixes(loaded_obj)
                loaded_obj.eval()
                return {"mode": "torch", "session": loaded_obj, "loaded_at": time.time(), "path": path}
            raise ValueError(
                "Loaded .pt file is not a TorchScript/module object. "
                "If this file is only a state_dict, load it with the original model class then export to ONNX or TorchScript."
            )

    raise ValueError("Unsupported model format. Use .onnx, .pt, or .pth")


def predict_from_image_bytes(image_bytes: bytes, model=None):
    """Return {'valence': float, 'arousal': float} using ONNX or PyTorch model with MediaPipe face detection."""
    if not model or "mode" not in model:
        raise RuntimeError("Model must be loaded with load_model(path) before prediction.")
    session = model["session"]
    # Load image
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    img_np = np.array(img)
    frame_height, frame_width, _ = img_np.shape
    bbox = _detect_face_bbox(img_np)
    print(bbox)
    if bbox is None:
        model_path_hint = _resolve_face_task_model_path()
        if model_path_hint:
            raise NoFaceDetectedError("No face detected in frame. Move closer to camera and improve lighting.")
        raise NoFaceDetectedError(
            "No face detected in frame. Move closer to camera and improve lighting. "
            "Optional: set MP_FACE_MODEL_PATH to a valid face_detector.task for MediaPipe Tasks detector."
        )

    x1 = int(bbox["x"])
    y1 = int(bbox["y"])
    x2 = int(bbox["x"] + bbox["width"])
    y2 = int(bbox["y"] + bbox["height"])
    face_img = img_np[y1:y2, x1:x2]
    if face_img.size == 0:
        raise NoFaceDetectedError("Face ROI invalid after detection.")

    # Resize to model input size
    face_img = Image.fromarray(face_img).resize((224, 224))
    arr = np.array(face_img).astype(np.float32) / 255.0
    arr = np.transpose(arr, (2, 0, 1))[None, ...]  # (1,3,224,224)

    if model["mode"] == "onnx":
        input_name = session.get_inputs()[0].name
        outputs = session.run(None, {input_name: arr})
        out = outputs[0]
    elif model["mode"] in {"torch", "torchscript"}:
        if torch is None:
            raise RuntimeError("PyTorch is not available for .pt inference.")
        tensor = torch.from_numpy(arr).to(torch.float32)
        with torch.no_grad():
            out = session(tensor)
        if isinstance(out, (list, tuple)):
            out = out[0]
        if hasattr(out, "detach"):
            out = out.detach().cpu().numpy()
    else:
        raise RuntimeError(f"Unsupported loaded model mode: {model['mode']}")

    flat = np.array(out).reshape(-1)
    if flat.size < 2:
        raise RuntimeError("Model output must contain at least 2 values: [valence, arousal].")

    valence = float(np.clip(flat[0], -1.0, 1.0))
    raw_arousal = float(flat[1])
    arousal = float(np.clip((raw_arousal + 1.0) / 2.0, 0.0, 1.0)) if raw_arousal < 0 else float(np.clip(raw_arousal, 0.0, 1.0))
    return {
        "valence": valence,
        "arousal": arousal,
        "bbox": bbox,
        "frame_width": int(frame_width),
        "frame_height": int(frame_height),
    }


if __name__ == "__main__":
    print("predictor module loaded (dummy). Replace with real model for research.)")
