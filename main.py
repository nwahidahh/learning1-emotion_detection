from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from db import init_db, SessionLocal
from models import (
    User,
    Session,
    EmotionLog,
    ConsentRecord,
    LearningMaterial,
    MaterialAssignment,
    MaterialComment,
    MaterialActivity,
    AdminAuditLog,
)
from predictor import load_model, predict_from_image_bytes, NoFaceDetectedError
from sqlalchemy.orm import Session as DBSession
from sqlalchemy import func
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
import csv
import io
from urllib.parse import urlparse


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
MAX_COMMENT_LENGTH = 1000
MAX_INSTRUCTION_LENGTH = 4000
ADMIN_SEED_EMAIL = os.getenv("ADMIN_SEED_EMAIL")
ADMIN_SEED_PASSWORD = os.getenv("ADMIN_SEED_PASSWORD")
ADMIN_SEED_NAME = os.getenv("ADMIN_SEED_NAME", "Admin")

# init DB
init_db()
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

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


def ensure_seed_admin():
    if not ADMIN_SEED_EMAIL or not ADMIN_SEED_PASSWORD:
        return
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == ADMIN_SEED_EMAIL).first()
        if existing:
            if existing.role != "admin":
                existing.role = "admin"
                existing.is_active = True
                db.commit()
            return

        admin = User(
            name=ADMIN_SEED_NAME,
            email=ADMIN_SEED_EMAIL,
            hashed_password=get_password_hash(ADMIN_SEED_PASSWORD),
            role="admin",
            is_active=True,
            created_at=now_utc(),
        )
        db.add(admin)
        db.commit()
    finally:
        db.close()


ensure_seed_admin()


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
    file_path: Optional[str]
    external_url: Optional[str]
    instruction: Optional[str]


class MaterialUpdateRequest(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    duration_minutes: Optional[int] = None
    instruction: Optional[str] = None
    external_url: Optional[str] = None


class MaterialCommentRequest(BaseModel):
    comment_text: str
    parent_comment_id: Optional[int] = None


class MaterialCommentResponse(BaseModel):
    id: int
    material_id: int
    user_id: int
    user_role: str
    user_name: str
    parent_comment_id: Optional[int]
    comment_text: str
    created_at: datetime


def _clean_text(text: Optional[str], max_len: int, field_name: str) -> Optional[str]:
    if text is None:
        return None
    cleaned = text.strip()
    if not cleaned:
        return None
    if len(cleaned) > max_len:
        raise HTTPException(status_code=400, detail=f"{field_name} too long")
    return cleaned


def _validate_http_url(url: Optional[str]) -> Optional[str]:
    if url is None:
        return None
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid URL")
    return url.strip()


def log_audit(
    db: DBSession,
    actor_user_id: Optional[int],
    event_type: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    detail: Optional[str] = None,
):
    entry = AdminAuditLog(
        actor_user_id=actor_user_id,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        detail=detail,
        timestamp=now_utc(),
    )
    db.add(entry)


def _can_view_material_comments(db: DBSession, material: LearningMaterial, current_user: User) -> bool:
    if current_user.role == "admin":
        return True
    if current_user.role == "teacher" and material.teacher_id == current_user.id:
        return True
    if current_user.role == "student":
        assignment = (
            db.query(MaterialAssignment)
            .filter(
                MaterialAssignment.material_id == material.id,
                MaterialAssignment.student_id == current_user.id,
            )
            .first()
        )
        return assignment is not None
    return False


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
    material_type: str = Form("pdf"),
    external_url: Optional[str] = Form(None),
    instruction: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    current_user: User = Depends(require_roles("teacher", "admin")),
    db: DBSession = Depends(get_db),
):
    normalized_type = (material_type or "pdf").strip().lower()
    cleaned_instruction = _clean_text(instruction, MAX_INSTRUCTION_LENGTH, "instruction")
    cleaned_title = _clean_text(title, 250, "title")
    cleaned_subject = _clean_text(subject, 150, "subject")
    if not cleaned_title or not cleaned_subject:
        raise HTTPException(status_code=400, detail="title and subject are required")

    saved_path = None
    validated_url = None
    final_type = normalized_type

    if normalized_type == "link":
        validated_url = _validate_http_url(external_url)
        if not validated_url:
            raise HTTPException(status_code=400, detail="external_url is required for link material")
    else:
        if file is None:
            raise HTTPException(status_code=400, detail="file is required for file material")
        allowed_types = {
            "application/pdf": "pdf",
            "video/mp4": "video",
            "video/webm": "video",
        }
        if file.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail="Unsupported file type")
        final_type = allowed_types[file.content_type] if normalized_type not in {"pdf", "video"} else normalized_type
        if final_type == "pdf" and file.content_type != "application/pdf":
            raise HTTPException(status_code=400, detail="PDF content-type required for pdf material")

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
        title=cleaned_title,
        subject=cleaned_subject,
        duration_minutes=duration_minutes,
        file_path=saved_path,
        file_type=final_type,
        external_url=validated_url,
        instruction=cleaned_instruction,
    )
    db.add(material)
    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="material_uploaded",
        entity_type="learning_material",
        entity_id=None,
        detail=f"title={material.title}",
    )
    db.commit()
    db.refresh(material)

    return {
        "id": material.id,
        "title": material.title,
        "subject": material.subject,
        "duration_minutes": material.duration_minutes,
        "file_type": material.file_type,
        "file_path": material.file_path,
        "external_url": material.external_url,
        "instruction": material.instruction,
    }


@app.put("/materials/{material_id}", response_model=MaterialResponse)
def materials_update(
    material_id: int,
    payload: MaterialUpdateRequest,
    current_user: User = Depends(require_roles("teacher", "admin")),
    db: DBSession = Depends(get_db),
):
    material = db.query(LearningMaterial).filter(LearningMaterial.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if current_user.role == "teacher" and material.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not allowed to edit this material")

    if payload.title is not None:
        cleaned = _clean_text(payload.title, 250, "title")
        if not cleaned:
            raise HTTPException(status_code=400, detail="title cannot be empty")
        material.title = cleaned
    if payload.subject is not None:
        cleaned = _clean_text(payload.subject, 150, "subject")
        if not cleaned:
            raise HTTPException(status_code=400, detail="subject cannot be empty")
        material.subject = cleaned
    if payload.duration_minutes is not None:
        material.duration_minutes = payload.duration_minutes
    if payload.instruction is not None:
        material.instruction = _clean_text(payload.instruction, MAX_INSTRUCTION_LENGTH, "instruction")
    if payload.external_url is not None:
        material.external_url = _validate_http_url(payload.external_url)
        if material.external_url:
            material.file_type = "link"
            material.file_path = None

    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="material_edited",
        entity_type="learning_material",
        entity_id=material.id,
        detail=f"title={material.title}",
    )
    db.commit()
    db.refresh(material)

    return {
        "id": material.id,
        "title": material.title,
        "subject": material.subject,
        "duration_minutes": material.duration_minutes,
        "file_type": material.file_type,
        "file_path": material.file_path,
        "external_url": material.external_url,
        "instruction": material.instruction,
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
    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="material_assigned",
        entity_type="material_assignment",
        entity_id=None,
        detail=f"material_id={material_id};student_id={student_id}",
    )
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
            "external_url": m.external_url,
            "instruction": m.instruction,
        }
        for m in materials
    ]


@app.post("/materials/{material_id}/comments", response_model=MaterialCommentResponse)
def materials_comment_create(
    material_id: int,
    payload: MaterialCommentRequest,
    current_user: User = Depends(require_roles("student", "teacher")),
    db: DBSession = Depends(get_db),
):
    material = db.query(LearningMaterial).filter(LearningMaterial.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")

    if current_user.role == "student":
        assignment = (
            db.query(MaterialAssignment)
            .filter(
                MaterialAssignment.material_id == material_id,
                MaterialAssignment.student_id == current_user.id,
            )
            .first()
        )
        if not assignment:
            raise HTTPException(status_code=403, detail="Material is not assigned to this student")
    elif current_user.role == "teacher" and material.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not allowed to comment on this material")

    comment_text = _clean_text(payload.comment_text, MAX_COMMENT_LENGTH, "comment_text")
    if not comment_text:
        raise HTTPException(status_code=400, detail="comment_text is required")

    if payload.parent_comment_id is not None:
        parent = (
            db.query(MaterialComment)
            .filter(
                MaterialComment.id == payload.parent_comment_id,
                MaterialComment.material_id == material_id,
            )
            .first()
        )
        if not parent:
            raise HTTPException(status_code=404, detail="Parent comment not found")

    created_at = now_utc()
    comment = MaterialComment(
        material_id=material_id,
        student_id=current_user.id,
        parent_comment_id=payload.parent_comment_id,
        comment_text=comment_text,
        created_at=created_at,
    )
    db.add(comment)

    activity = MaterialActivity(
        student_id=current_user.id,
        material_id=material_id,
        event_type="commented",
        timestamp=created_at,
    )
    db.add(activity)

    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="material_commented",
        entity_type="material_comment",
        entity_id=None,
        detail=f"material_id={material_id}",
    )

    db.commit()
    db.refresh(comment)

    return {
        "id": comment.id,
        "material_id": comment.material_id,
        "user_id": current_user.id,
        "user_role": current_user.role,
        "user_name": current_user.name,
        "parent_comment_id": comment.parent_comment_id,
        "comment_text": comment.comment_text,
        "created_at": comment.created_at,
    }


@app.get("/materials/{material_id}/comments", response_model=List[MaterialCommentResponse])
def materials_comments_list(
    material_id: int,
    current_user: User = Depends(get_current_user),
    db: DBSession = Depends(get_db),
):
    material = db.query(LearningMaterial).filter(LearningMaterial.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")

    if not _can_view_material_comments(db, material, current_user):
        raise HTTPException(status_code=403, detail="Not allowed")

    rows = (
        db.query(MaterialComment, User)
        .join(User, User.id == MaterialComment.student_id)
        .filter(MaterialComment.material_id == material_id)
        .order_by(MaterialComment.created_at.asc())
        .all()
    )
    return [
        {
            "id": comment.id,
            "material_id": comment.material_id,
            "user_id": author.id,
            "user_role": author.role,
            "user_name": author.name,
            "parent_comment_id": comment.parent_comment_id,
            "comment_text": comment.comment_text,
            "created_at": comment.created_at,
        }
        for comment, author in rows
    ]


@app.post("/materials/{material_id}/open")
def materials_open(
    material_id: int,
    current_user: User = Depends(require_roles("student")),
    db: DBSession = Depends(get_db),
):
    material = db.query(LearningMaterial).filter(LearningMaterial.id == material_id).first()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")

    assignment = (
        db.query(MaterialAssignment)
        .filter(
            MaterialAssignment.material_id == material_id,
            MaterialAssignment.student_id == current_user.id,
        )
        .first()
    )
    if not assignment:
        raise HTTPException(status_code=403, detail="Material is not assigned to this student")

    event_time = now_utc()
    db.add(MaterialActivity(
        student_id=current_user.id,
        material_id=material_id,
        event_type="opened",
        timestamp=event_time,
    ))
    db.add(MaterialActivity(
        student_id=current_user.id,
        material_id=material_id,
        event_type="highlighted",
        timestamp=event_time,
    ))
    db.commit()
    return {"status": "ok", "material_id": material_id, "timestamp": event_time.isoformat()}


@app.get("/materials/last-opened")
def materials_last_opened(
    current_user: User = Depends(require_roles("student")),
    db: DBSession = Depends(get_db),
):
    activity = (
        db.query(MaterialActivity)
        .filter(
            MaterialActivity.student_id == current_user.id,
            MaterialActivity.event_type.in_(["opened", "highlighted"]),
        )
        .order_by(MaterialActivity.timestamp.desc())
        .first()
    )
    if not activity:
        return None

    material = db.query(LearningMaterial).filter(LearningMaterial.id == activity.material_id).first()
    if not material:
        return None

    return {
        "material_id": material.id,
        "title": material.title,
        "subject": material.subject,
        "file_type": material.file_type,
        "file_path": material.file_path,
        "external_url": material.external_url,
        "instruction": material.instruction,
        "opened_at": activity.timestamp,
    }


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
    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="session_started",
        entity_type="session",
        entity_id=None,
        detail=f"material_id={material_id}",
    )
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
    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="session_stopped",
        entity_type="session",
        entity_id=s.id,
        detail=f"material_id={s.material_id}",
    )
    db.commit()
    return {"status": "stopped", "session_id": s.id}


@app.get("/admin/activity")
def admin_activity(
    limit: int = 100,
    current_user: User = Depends(require_roles("admin")),
    db: DBSession = Depends(get_db),
):
    safe_limit = max(1, min(limit, 500))

    audit_rows = (
        db.query(AdminAuditLog, User)
        .outerjoin(User, User.id == AdminAuditLog.actor_user_id)
        .order_by(AdminAuditLog.timestamp.desc())
        .limit(safe_limit)
        .all()
    )

    activity_items = [
        {
            "source": "audit",
            "timestamp": log.timestamp,
            "event_type": log.event_type,
            "entity_type": log.entity_type,
            "entity_id": log.entity_id,
            "actor_user_id": actor.id if actor else log.actor_user_id,
            "actor_name": actor.name if actor else None,
            "actor_role": actor.role if actor else None,
            "detail": log.detail,
        }
        for log, actor in audit_rows
    ]

    session_rows = (
        db.query(Session, User, LearningMaterial)
        .join(User, User.id == Session.student_id)
        .outerjoin(LearningMaterial, LearningMaterial.id == Session.material_id)
        .order_by(Session.start_time.desc())
        .limit(max(10, safe_limit // 2))
        .all()
    )
    for session, student, material in session_rows:
        activity_items.append(
            {
                "source": "session",
                "timestamp": session.start_time,
                "event_type": "session_started",
                "entity_type": "session",
                "entity_id": session.id,
                "actor_user_id": student.id,
                "actor_name": student.name,
                "actor_role": student.role,
                "detail": f"material_id={material.id if material else None}",
            }
        )
        if session.end_time:
            activity_items.append(
                {
                    "source": "session",
                    "timestamp": session.end_time,
                    "event_type": "session_stopped",
                    "entity_type": "session",
                    "entity_id": session.id,
                    "actor_user_id": student.id,
                    "actor_name": student.name,
                    "actor_role": student.role,
                    "detail": f"material_id={material.id if material else None}",
                }
            )

    summary_row = db.query(
        func.count(EmotionLog.id),
        func.avg(EmotionLog.valence),
        func.avg(EmotionLog.arousal),
    ).first()
    activity_items.append(
        {
            "source": "summary",
            "timestamp": now_utc(),
            "event_type": "emotion_log_summary",
            "entity_type": "emotion_logs",
            "entity_id": None,
            "actor_user_id": None,
            "actor_name": None,
            "actor_role": None,
            "detail": f"count={summary_row[0] or 0};avg_valence={summary_row[1] or 0.0:.4f};avg_arousal={summary_row[2] or 0.0:.4f}",
        }
    )

    activity_items.sort(key=lambda item: item["timestamp"], reverse=True)
    return {"items": activity_items[:safe_limit]}


@app.get("/admin/stats")
def admin_stats(
    current_user: User = Depends(require_roles("admin")),
    db: DBSession = Depends(get_db),
):
    users_total = db.query(func.count(User.id)).scalar() or 0
    users_active = db.query(func.count(User.id)).filter(User.is_active.is_(True)).scalar() or 0
    materials_total = db.query(func.count(LearningMaterial.id)).scalar() or 0
    comments_total = db.query(func.count(MaterialComment.id)).scalar() or 0
    logs_total = db.query(func.count(EmotionLog.id)).scalar() or 0
    sessions_total = db.query(func.count(Session.id)).scalar() or 0
    assignments_total = db.query(func.count(MaterialAssignment.id)).scalar() or 0
    return {
        "users_total": users_total,
        "users_active": users_active,
        "materials_total": materials_total,
        "comments_total": comments_total,
        "logs_total": logs_total,
        "sessions_total": sessions_total,
        "assignments_total": assignments_total,
    }


@app.patch("/admin/users/{user_id}/active")
def admin_toggle_user_active(
    user_id: int,
    is_active: bool,
    current_user: User = Depends(require_roles("admin")),
    db: DBSession = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_active = is_active
    log_audit(
        db,
        actor_user_id=current_user.id,
        event_type="user_active_toggled",
        entity_type="user",
        entity_id=user.id,
        detail=f"is_active={is_active}",
    )
    db.commit()
    return {"status": "ok", "user_id": user.id, "is_active": user.is_active}


@app.get("/admin/export.csv")
def admin_export_csv(
    current_user: User = Depends(require_roles("admin")),
    db: DBSession = Depends(get_db),
):
    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "section",
        "log_id",
        "session_id",
        "student_id",
        "student_name",
        "student_email",
        "material_id",
        "material_title",
        "material_subject",
        "material_type",
        "material_external_url",
        "timestamp",
        "client_timestamp",
        "valence",
        "arousal",
        "confidence",
        "source",
        "comment_count_for_material",
        "activity_open_count_for_material",
    ])

    raw_rows = (
        db.query(EmotionLog, Session, User, LearningMaterial)
        .outerjoin(Session, Session.id == EmotionLog.session_id)
        .join(User, User.id == EmotionLog.student_id)
        .outerjoin(LearningMaterial, LearningMaterial.id == Session.material_id)
        .order_by(EmotionLog.timestamp.asc())
        .all()
    )

    material_comment_counts = {
        material_id: count
        for material_id, count in db.query(
            MaterialComment.material_id,
            func.count(MaterialComment.id),
        ).group_by(MaterialComment.material_id).all()
    }
    material_open_counts = {
        material_id: count
        for material_id, count in db.query(
            MaterialActivity.material_id,
            func.count(MaterialActivity.id),
        ).filter(MaterialActivity.event_type == "opened").group_by(MaterialActivity.material_id).all()
    }

    for log, session, student, material in raw_rows:
        writer.writerow([
            "raw",
            log.id,
            log.session_id,
            student.id,
            student.name,
            student.email,
            material.id if material else None,
            material.title if material else None,
            material.subject if material else None,
            material.file_type if material else None,
            material.external_url if material else None,
            log.timestamp.isoformat() if log.timestamp else None,
            log.client_timestamp,
            log.valence,
            log.arousal,
            log.confidence,
            log.source,
            material_comment_counts.get(material.id, 0) if material else 0,
            material_open_counts.get(material.id, 0) if material else 0,
        ])

    writer.writerow([])
    writer.writerow(["section", "metric", "value"])
    writer.writerow(["summary", "users_total", db.query(func.count(User.id)).scalar() or 0])
    writer.writerow(["summary", "materials_total", db.query(func.count(LearningMaterial.id)).scalar() or 0])
    writer.writerow(["summary", "comments_total", db.query(func.count(MaterialComment.id)).scalar() or 0])
    writer.writerow(["summary", "sessions_total", db.query(func.count(Session.id)).scalar() or 0])
    writer.writerow(["summary", "emotion_logs_total", db.query(func.count(EmotionLog.id)).scalar() or 0])
    writer.writerow([
        "summary",
        "emotion_valence_avg",
        float(db.query(func.avg(EmotionLog.valence)).scalar() or 0.0),
    ])
    writer.writerow([
        "summary",
        "emotion_arousal_avg",
        float(db.query(func.avg(EmotionLog.arousal)).scalar() or 0.0),
    ])

    csv_body = output.getvalue()
    output.close()
    return Response(
        content=csv_body,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="research_export.csv"'},
    )


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


@app.get("/student")
def student_page():
    return FileResponse("./static/student.html")


@app.get("/teacher")
def teacher_page():
    return FileResponse("./static/teacher.html")


@app.get("/")
def root():
    return FileResponse("./static/login.html")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
