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

3. (Optional) seed an admin account via environment variables:

```bash
export ADMIN_SEED_EMAIL="admin@example.com"
export ADMIN_SEED_PASSWORD="change-me-strong-password"
export ADMIN_SEED_NAME="System Admin"
```

4. Run the FastAPI server:

```bash
uvicorn main:app --reload
```

5. Open the frontend: http://localhost:8000/static/login.html

Role pages
- Student: http://localhost:8000/static/student.html
- Teacher: http://localhost:8000/static/teacher.html
- Admin: http://localhost:8000/static/admin.html
- Login/register automatically redirect to the correct role page after successful auth.
- If a user opens the wrong role page, the frontend auto-redirects to their own role page.

Implemented MVP (phase 1)
- Email/password authentication with JWT (`/auth/register`, `/auth/login`, `/auth/me`)
- Role-aware access control (student/teacher/admin guarded endpoints)
- Consent management (`/consent/accept`, `/consent/withdraw`, `/consent/me`)
- Teacher material upload and assignment (PDF/video)
- Student session lifecycle + protected emotion logging
- Student and teacher dashboard summary endpoints

Implemented role split + learning interaction MVP (phase 2)
- Dedicated role pages (`student.html`, `teacher.html`, `admin.html`)
- Teacher material upload now supports PDF and external links
- Teacher metadata/instruction edit (`PUT /materials/{id}`)
- Material comments/questions (`POST/GET /materials/{id}/comments`)
- Student material open tracking + last opened (`POST /materials/{id}/open`, `GET /materials/last-opened`)
- Admin activity feed, stats, user maintenance toggle, and CSV export:
	- `GET /admin/activity`
	- `GET /admin/stats`
	- `PATCH /admin/users/{id}/active`
	- `GET /admin/export.csv`

Notes
- The predictor path currently uses server-side inference fallback (`/predict`) and logs numeric outputs only.
- The system stores data in `emotion.db` (SQLite) and includes lightweight auto-migration for added columns in development.
- Uploaded learning files are saved under `./uploads`.
- Registration remains limited to `student` and `teacher`; admin is provisioned from seed data (environment variables) or direct DB promotion.

Files added
- `main.py` — FastAPI app and REST endpoints
- `db.py`, `models.py` — SQLite + SQLAlchemy schema
- `predictor.py` — placeholder predictor (where to plug a real model)
- `static/` — frontend assets (`login.html`, `register.html`, `student.html`, `teacher.html`, `admin.html`, `app.js`, `styles.css`)
- `requirements.txt` — dependencies

DB migration notes (SQLite dev mode)
- This project uses additive startup migration only (`db.py`): missing columns are added safely if table already exists.
- New tables are created by SQLAlchemy metadata on startup.
- Current additive updates include:
	- `learning_materials.external_url`
	- `learning_materials.instruction`
	- new tables `material_comments`, `material_activities`, `admin_audit_logs`
- For production, use formal migrations (Alembic) before destructive schema changes.

Manual test checklist

Student
- Register/login as student and verify redirect to `/static/student.html`.
- Verify assigned materials list loads PDF/link records from `/materials`.
- Open a material with "Open/Visit Material" and confirm `last opened` updates.
- Add a comment/question and verify it appears in list (`POST/GET /materials/{id}/comments`).
- Accept consent, start session, and confirm emotion logging continues to work.

Teacher
- Register/login as teacher and verify redirect to `/static/teacher.html`.
- Upload PDF material and link material using `/materials/upload`.
- Edit title/subject/instruction/url via `/materials/{id}` and confirm persistence.
- Assign material to a student via `/materials/{id}/assign`.
- View material comments from students via `/materials/{id}/comments`.

Admin
- Login with seeded admin account and verify redirect to `/static/admin.html`.
- Refresh activity feed (`/admin/activity`) and stats (`/admin/stats`).
- Toggle a user active status (`PATCH /admin/users/{id}/active`).
- Download export from `/admin/export.csv` and confirm it contains both raw rows and summary section.

Role routing and compatibility
- Login and register pages continue to work.
- Opening the wrong role page should auto-redirect to the correct page.
- Existing auth/session/emotion endpoints remain available.

Next steps
- Add client-side inference path (ONNX Web) with automatic fallback to `/predict`.
- Add password reset completion flow (email token), CSV export, and richer analytics filters.
- Add formal DB migrations with Alembic for production deployment.

