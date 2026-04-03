from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from db import init_db, SessionLocal
from models import User, Session, EmotionLog
from predictor import load_model, predict_from_image_bytes, NoFaceDetectedError
from sqlalchemy.orm import Session as DBSession
from datetime import datetime, timedelta
import uvicorn


app = FastAPI(title="Arousal-Valence Learning Platform API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="./static"), name="static")


# init DB
init_db()
import os

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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    if model is None:
        raise HTTPException(status_code=503, detail="No model loaded. Set MODEL_PATH (or ONNX_MODEL_PATH) to a .onnx/.pt/.pth file.")
    data = await file.read()
    try:
        out = predict_from_image_bytes(data, model=model)
    except NoFaceDetectedError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"timestamp": datetime.utcnow().isoformat(), **out}


@app.post("/emotion/log")
async def emotion_log(student_id: int = Form(...), session_id: int = Form(None), valence: float = Form(...), arousal: float = Form(...)):
    db = next(get_db())
    now = datetime.utcnow()
    latest_query = db.query(EmotionLog).filter(EmotionLog.student_id == student_id)
    if session_id is None:
        latest_query = latest_query.filter(EmotionLog.session_id.is_(None))
    else:
        latest_query = latest_query.filter(EmotionLog.session_id == session_id)
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

    log = EmotionLog(student_id=student_id, session_id=session_id, valence=valence, arousal=arousal, timestamp=now)
    db.add(log)
    db.commit()
    db.refresh(log)
    return {"status": "ok", "id": log.id}


@app.post("/session/start")
async def session_start(student_id: int = Form(...)):
    db = next(get_db())
    # ensure user exists (create if missing)
    user = db.query(User).filter(User.id == student_id).first()
    if not user:
        user = User(id=student_id, name=f"Student {student_id}")
        db.add(user)
        db.commit()
        db.refresh(user)
    s = Session(student_id=student_id, start_time=datetime.utcnow())
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"status": "started", "session_id": s.id}


@app.post("/session/stop")
async def session_stop(session_id: int = Form(...)):
    db = next(get_db())
    s = db.query(Session).filter(Session.id == session_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    s.end_time = datetime.utcnow()
    db.commit()
    return {"status": "stopped", "session_id": s.id}


@app.get("/student/{student_id}/dashboard")
def student_dashboard(student_id: int):
    db = next(get_db())
    logs = db.query(EmotionLog).filter(EmotionLog.student_id == student_id).order_by(EmotionLog.timestamp).all()
    # produce simple aggregates
    times = [l.timestamp.isoformat() for l in logs]
    valences = [l.valence for l in logs]
    arousals = [l.arousal for l in logs]
    focused = sum(1 for v,a in zip(valences, arousals) if a>0.4 and v>-0.2)
    total = len(logs)
    focus_ratio = focused / total if total>0 else 0.0
    return {"times": times, "valences": valences, "arousals": arousals, "focus_ratio": focus_ratio}


@app.get("/teacher/{teacher_id}/class_report")
def class_report(teacher_id: int):
    db = next(get_db())
    # naive: return aggregate over all logs
    logs = db.query(EmotionLog).all()
    v = [l.valence for l in logs]
    a = [l.arousal for l in logs]
    import statistics
    return {
        "count": len(logs),
        "valence_mean": statistics.mean(v) if v else 0.0,
        "arousal_mean": statistics.mean(a) if a else 0.0,
    }


@app.get("/")
def root():
    return FileResponse("./static/index.html")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
