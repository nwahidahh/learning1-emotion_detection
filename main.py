from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from db import init_db, SessionLocal
from models import (
    User,
    Session,
    EmotionLog,
    ConsentRecord,
    LearningMaterial,
    MaterialAssignment,
)
from predictor import load_model, predict_from_image_bytes, NoFaceDetectedError
from sqlalchemy.orm import Session as DBSession
from datetime import datetime, timedelta, timezone
from pydantic import BaseModel, EmailStr
from typing import Optional, List
from jose import JWTError, jwt
import uvicorn
import os
import statistics
import uuid
import hashlib
import hmac
import base64


app = FastAPI(title="Arousal-Valence Learning Platform API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="./static"), name="static")


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

ACCESS_TOKEN_EXPIRE_MINUTES = 8 * 60
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "change-this-in-production")
JWT_ALGORITHM = "HS256"
CONSENT_POLICY_VERSION = "v1.0"
UPLOAD_DIR = "./uploads"
PBKDF2_ITERATIONS = 390000

# init DB
init_db()
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Try to load model if path is set, else auto-use local enet_b0_8_va_mtl.pt if present
DEFAULT_LOCAL_MODEL = "./enet_b0_8_va_mtl.pt"
MODEL_PATH = os.environ.get("MODEL_PATH") or os.environ.get("ONNX_MODEL_PATH")
if not MODEL_PATH and os.path.exists(DEFAULT_LOCAL_MODEL):
    MODEL_PATH = DEFAULT_LOCAL_MODEL

model = None
if MODEL_PATH:
    try:
        model = load_model(MODEL_PATH)
    except Exception as e:
        print(f"Failed to load model from {MODEL_PATH}: {e}")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        algorithm, iterations_str, salt_b64, digest_b64 = hashed_password.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_str)
        salt = base64.b64decode(salt_b64.encode("utf-8"))
        expected_digest = base64.b64decode(digest_b64.encode("utf-8"))
    except Exception:
        return False

    computed_digest = hashlib.pbkdf2_hmac(
        "sha256",
        plain_password.encode("utf-8"),
        salt,
        iterations,
    )
    return hmac.compare_digest(computed_digest, expected_digest)


def get_password_hash(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    salt_b64 = base64.b64encode(salt).decode("utf-8")
    digest_b64 = base64.b64encode(digest).decode("utf-8")
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_b64}${digest_b64}"


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = now_utc() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: DBSession = Depends(get_db),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == int(user_id)).first()
    if not user or not user.is_active:
        raise credentials_exception
    return user


def require_roles(*roles: str):
    def role_dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in roles:
            raise HTTPException(status_code=403, detail="Insufficient role")
        return current_user

    return role_dependency


def user_has_active_consent(db: DBSession, user_id: int) -> bool:
    latest = (
        db.query(ConsentRecord)
        .filter(ConsentRecord.user_id == user_id)
        .order_by(ConsentRecord.timestamp.desc())
        .first()
    )
    return bool(latest and latest.status == "accepted")


class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    role: str = "student"


class TokenResponse(BaseModel):
    access_token: str
    token_type: str


class ConsentResponse(BaseModel):
    status: str
    policy_version: str
    timestamp: datetime


class EmotionLogRequest(BaseModel):
    session_id: Optional[int] = None
    valence: float
    arousal: float
    confidence: Optional[float] = None
    model_version: Optional[str] = None
    client_timestamp: Optional[str] = None
    source: str = "client"


class MaterialResponse(BaseModel):
    id: int
    title: str
    subject: str
    duration_minutes: Optional[int]
    file_type: str
    file_path: str


@app.post("/auth/register", response_model=TokenResponse)
def register(payload: RegisterRequest, db: DBSession = Depends(get_db)):
    allowed_roles = {"student", "teacher"}
    if payload.role not in allowed_roles:
        raise HTTPException(status_code=400, detail="Invalid role")
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(
        name=payload.name,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
        role=payload.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token({"sub": str(user.id), "role": user.role})
    return {"access_token": token, "token_type": "bearer"}


@app.post("/auth/login", response_model=TokenResponse)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: DBSession = Depends(get_db)):
    user = db.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = create_access_token({"sub": str(user.id), "role": user.role})
    return {"access_token": token, "token_type": "bearer"}


@app.get("/auth/me")
def me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "name": current_user.name,
        "email": current_user.email,
        "role": current_user.role,
        "is_active": current_user.is_active,
    }


@app.post("/auth/password-reset-request")
def password_reset_request(email: EmailStr, db: DBSession = Depends(get_db)):
    user = db.query(User).filter(User.email == email).first()
    if not user:
        return {"status": "ok"}
    return {"status": "ok", "message": "Reset flow is not configured in MVP"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if model is None:
        raise HTTPException(status_code=503, detail="No model loaded. Set MODEL_PATH (or ONNX_MODEL_PATH) to a .onnx/.pt/.pth file.")
    data = await file.read()
    try:
        out = predict_from_image_bytes(data, model=model)
    except NoFaceDetectedError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"timestamp": now_utc().isoformat(), "user_id": current_user.id, **out}


@app.get("/consent/me", response_model=Optional[ConsentResponse])
def consent_me(current_user: User = Depends(get_current_user), db: DBSession = Depends(get_db)):
    consent = (
        db.query(ConsentRecord)
        .filter(ConsentRecord.user_id == current_user.id)
        .order_by(ConsentRecord.timestamp.desc())
        .first()
    )
    if not consent:
        return None
    return {
        "status": consent.status,
        "policy_version": consent.policy_version,
        "timestamp": consent.timestamp,
    }


@app.post("/consent/accept", response_model=ConsentResponse)
def consent_accept(current_user: User = Depends(get_current_user), db: DBSession = Depends(get_db)):
    record = ConsentRecord(
        user_id=current_user.id,
        status="accepted",
        policy_version=CONSENT_POLICY_VERSION,
        timestamp=now_utc(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {
        "status": record.status,
        "policy_version": record.policy_version,
        "timestamp": record.timestamp,
    }


@app.post("/consent/withdraw", response_model=ConsentResponse)
def consent_withdraw(current_user: User = Depends(get_current_user), db: DBSession = Depends(get_db)):
    record = ConsentRecord(
        user_id=current_user.id,
        status="withdrawn",
        policy_version=CONSENT_POLICY_VERSION,
        timestamp=now_utc(),
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {
        "status": record.status,
        "policy_version": record.policy_version,
        "timestamp": record.timestamp,
    }


@app.post("/emotion/log")
def emotion_log(
    payload: EmotionLogRequest,
    current_user: User = Depends(require_roles("student")),
    db: DBSession = Depends(get_db),
):
    now = now_utc()
    latest_query = db.query(EmotionLog).filter(EmotionLog.student_id == current_user.id)
    if payload.session_id is None:
        latest_query = latest_query.filter(EmotionLog.session_id.is_(None))
    else:
        latest_query = latest_query.filter(EmotionLog.session_id == payload.session_id)
    latest_log = latest_query.order_by(EmotionLog.timestamp.desc()).first()

    interval_seconds = 10
    if latest_log and (now - latest_log.timestamp) < timedelta(seconds=interval_seconds):
        remaining = interval_seconds - int((now - latest_log.timestamp).total_seconds())
        return {
            "status": "skipped",
            "reason": "interval_not_reached",
            "next_capture_in_seconds": max(remaining, 0),
            "last_log_id": latest_log.id,
        }

    if payload.session_id is not None:
        session = (
            db.query(Session)
            .filter(Session.id == payload.session_id, Session.student_id == current_user.id)
            .first()
        )
        if not session:
            raise HTTPException(status_code=404, detail="Session not found for this student")

    log = EmotionLog(
        student_id=current_user.id,
        session_id=payload.session_id,
        valence=payload.valence,
        arousal=payload.arousal,
        confidence=payload.confidence,
        model_version=payload.model_version,
        client_timestamp=payload.client_timestamp,
        source=payload.source,
        timestamp=now,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return {"status": "ok", "id": log.id}


@app.post("/materials/upload", response_model=MaterialResponse)
async def materials_upload(
    title: str = Form(...),
    subject: str = Form(...),
    duration_minutes: Optional[int] = Form(None),
    file: UploadFile = File(...),
    current_user: User = Depends(require_roles("teacher", "admin")),
    db: DBSession = Depends(get_db),
):
    allowed_types = {
        "application/pdf": "pdf",
        "video/mp4": "video",
        "video/webm": "video",
    }
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    extension = os.path.splitext(file.filename or "")[1] or ".bin"
    saved_name = f"{uuid.uuid4().hex}{extension}"
    saved_path = os.path.join(UPLOAD_DIR, saved_name)

    content = await file.read()
    if len(content) > 200 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds max size (200MB)")

    with open(saved_path, "wb") as output_file:
        output_file.write(content)

    material = LearningMaterial(
        teacher_id=current_user.id,
        title=title,
        subject=subject,
        duration_minutes=duration_minutes,
        file_path=saved_path,
        file_type=allowed_types[file.content_type],
    )
    db.add(material)
    db.commit()
    db.refresh(material)

    return {
        "id": material.id,
        "title": material.title,
        "subject": material.subject,
        "duration_minutes": material.duration_minutes,
        "file_type": material.file_type,
        "file_path": material.file_path,
    }


@app.post("/materials/{material_id}/assign")
def materials_assign(
    material_id: int,
    student_id: int = Form(...),
    current_user: User = Depends(require_roles("teacher", "admin")),
    db: DBSession = Depends(get_db),
):
    material = db.query(LearningMaterial).filter(LearningMaterial.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if current_user.role == "teacher" and material.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not allowed to assign this material")

    student = db.query(User).filter(User.id == student_id, User.role == "student").first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    existing = (
        db.query(MaterialAssignment)
        .filter(MaterialAssignment.material_id == material_id, MaterialAssignment.student_id == student_id)
        .first()
    )
    if existing:
        return {"status": "ok", "assignment_id": existing.id, "already_assigned": True}

    assignment = MaterialAssignment(material_id=material_id, student_id=student_id)
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    return {"status": "ok", "assignment_id": assignment.id, "already_assigned": False}


@app.get("/materials", response_model=List[MaterialResponse])
def materials_list(
    current_user: User = Depends(get_current_user),
    db: DBSession = Depends(get_db),
):
    if current_user.role in {"teacher", "admin"}:
        query = db.query(LearningMaterial)
        if current_user.role == "teacher":
            query = query.filter(LearningMaterial.teacher_id == current_user.id)
        materials = query.order_by(LearningMaterial.created_at.desc()).all()
    else:
        materials = (
            db.query(LearningMaterial)
            .join(MaterialAssignment, MaterialAssignment.material_id == LearningMaterial.id)
            .filter(MaterialAssignment.student_id == current_user.id)
            .order_by(LearningMaterial.created_at.desc())
            .all()
        )

    return [
        {
            "id": m.id,
            "title": m.title,
            "subject": m.subject,
            "duration_minutes": m.duration_minutes,
            "file_type": m.file_type,
            "file_path": m.file_path,
        }
        for m in materials
    ]


@app.post("/session/start")
def session_start(
    material_id: Optional[int] = None,
    current_user: User = Depends(require_roles("student")),
    db: DBSession = Depends(get_db),
):
    if not user_has_active_consent(db, current_user.id):
        raise HTTPException(status_code=403, detail="Consent is required before starting a session")

    if material_id is not None:
        assignment = (
            db.query(MaterialAssignment)
            .filter(MaterialAssignment.material_id == material_id, MaterialAssignment.student_id == current_user.id)
            .first()
        )
        if not assignment:
            raise HTTPException(status_code=403, detail="Material is not assigned to this student")

    s = Session(student_id=current_user.id, material_id=material_id, start_time=now_utc())
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"status": "started", "session_id": s.id, "student_id": current_user.id}


@app.post("/session/stop")
def session_stop(
    session_id: int,
    current_user: User = Depends(require_roles("student")),
    db: DBSession = Depends(get_db),
):
    s = db.query(Session).filter(Session.id == session_id, Session.student_id == current_user.id).first()
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    s.end_time = now_utc()
    db.commit()
    return {"status": "stopped", "session_id": s.id}


@app.get("/student/dashboard")
def student_dashboard(
    student_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: DBSession = Depends(get_db),
):
    target_student_id = current_user.id
    if student_id is not None:
        if current_user.role not in {"teacher", "admin"}:
            raise HTTPException(status_code=403, detail="Not allowed")
        target_student_id = student_id

    logs = db.query(EmotionLog).filter(EmotionLog.student_id == target_student_id).order_by(EmotionLog.timestamp).all()
    # produce simple aggregates
    times = [l.timestamp.isoformat() for l in logs]
    valences = [l.valence for l in logs]
    arousals = [l.arousal for l in logs]
    focused = sum(1 for v,a in zip(valences, arousals) if a>0.4 and v>-0.2)
    total = len(logs)
    focus_ratio = focused / total if total>0 else 0.0
    return {"student_id": target_student_id, "times": times, "valences": valences, "arousals": arousals, "focus_ratio": focus_ratio}


@app.get("/teacher/dashboard")
def teacher_dashboard(
    student_id: Optional[int] = None,
    material_id: Optional[int] = None,
    current_user: User = Depends(require_roles("teacher", "admin")),
    db: DBSession = Depends(get_db),
):
    query = db.query(EmotionLog)
    if current_user.role == "teacher":
        assigned_student_ids = (
            db.query(MaterialAssignment.student_id)
            .join(LearningMaterial, LearningMaterial.id == MaterialAssignment.material_id)
            .filter(LearningMaterial.teacher_id == current_user.id)
            .distinct()
            .all()
        )
        allowed_ids = [row[0] for row in assigned_student_ids]
        if not allowed_ids:
            return {
                "count": 0,
                "valence_mean": 0.0,
                "arousal_mean": 0.0,
                "student_ids": [],
                "material_id": material_id,
            }
        query = query.filter(EmotionLog.student_id.in_(allowed_ids))

    if student_id is not None:
        query = query.filter(EmotionLog.student_id == student_id)

    if material_id is not None:
        query = query.join(Session, Session.id == EmotionLog.session_id).filter(Session.material_id == material_id)

    logs = query.all()
    v = [l.valence for l in logs]
    a = [l.arousal for l in logs]
    return {
        "count": len(logs),
        "valence_mean": statistics.mean(v) if v else 0.0,
        "arousal_mean": statistics.mean(a) if a else 0.0,
        "student_ids": sorted(list({l.student_id for l in logs})),
        "material_id": material_id,
    }


@app.get("/teacher/{teacher_id}/class_report")
def class_report_compat(
    teacher_id: int,
    current_user: User = Depends(require_roles("teacher", "admin")),
):
    if current_user.role == "teacher" and current_user.id != teacher_id:
        raise HTTPException(status_code=403, detail="Not allowed")
    return {"status": "moved", "detail": "Use /teacher/dashboard"}


@app.get("/")
def root():
    return FileResponse("./static/login.html")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
