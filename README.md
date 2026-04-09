# learning1-emotion_detection

Prototype web platform for real-time emotion & engagement monitoring using the Arousal–Valence model.

Quick start

1. Create a Python environment (recommended Python 3.10+)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. (Optional but recommended) set JWT secret:

```bash
export JWT_SECRET_KEY="your-strong-secret"
```

3. Run the FastAPI server:

```bash
uvicorn main:app --reload
```

4. Open the frontend: http://localhost:8000/static/index.html

Implemented MVP (phase 1)
- Email/password authentication with JWT (`/auth/register`, `/auth/login`, `/auth/me`)
- Role-aware access control (student/teacher/admin guarded endpoints)
- Consent management (`/consent/accept`, `/consent/withdraw`, `/consent/me`)
- Teacher material upload and assignment (PDF/video)
- Student session lifecycle + protected emotion logging
- Student and teacher dashboard summary endpoints

Notes
- The predictor path currently uses server-side inference fallback (`/predict`) and logs numeric outputs only.
- The system stores data in `emotion.db` (SQLite) and includes lightweight auto-migration for added columns in development.
- Uploaded learning files are saved under `./uploads`.

Files added
- `main.py` — FastAPI app and REST endpoints
- `db.py`, `models.py` — SQLite + SQLAlchemy schema
- `predictor.py` — placeholder predictor (where to plug a real model)
- `static/` — frontend assets (`index.html`, `app.js`, `styles.css`)
- `requirements.txt` — dependencies

Next steps
- Add client-side inference path (ONNX Web) with automatic fallback to `/predict`.
- Add password reset completion flow (email token), CSV export, and richer analytics filters.
- Add formal DB migrations with Alembic for production deployment.

