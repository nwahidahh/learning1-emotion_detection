# learning1-emotion_detection

Prototype web platform for real-time emotion & engagement monitoring using the Arousal–Valence model.

Quick start

1. Create a Python environment (recommended Python 3.10+)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Run the FastAPI server:

```bash
uvicorn main:app --reload
```

3. Open the frontend: http://localhost:8000/static/index.html

Notes
- The backend includes a small `predictor.py` stub — replace with a trained arousal/valence regression model (ONNX/PyTorch/TensorFlow) for research or deployment.
- The system stores only numeric emotion logs in `emotion.db` (SQLite). No raw video is saved.
- For research-quality experiments, replace the heuristic predictor and add model versioning, calibration, and IRB-approved consent flows.

Files added
- `main.py` — FastAPI app and REST endpoints
- `db.py`, `models.py` — SQLite + SQLAlchemy schema
- `predictor.py` — placeholder predictor (where to plug a real model)
- `static/` — frontend assets (`index.html`, `app.js`, `styles.css`)
- `requirements.txt` — dependencies

Next steps
- Swap the predictor with a trained arousal–valence model; example model loading is noted in `predictor.py`.
- Add authentication, teacher/student management UIs, and group session support.
- Optionally replace REST polling with WebSocket for lower-latency streaming.

