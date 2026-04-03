from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime, timedelta, timezone
def now_jst():
    """Return current time in Japan Standard Time (UTC+9)."""
    return datetime.now(timezone(timedelta(hours=9)))
from db import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    role = Column(String, default="student")


class Session(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    start_time = Column(DateTime, default=now_jst)
    end_time = Column(DateTime, nullable=True)  # Set explicitly to JST when assigned
    user = relationship("User")


class EmotionLog(Base):
    __tablename__ = "emotion_logs"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    timestamp = Column(DateTime, default=now_jst)
    valence = Column(Float, nullable=False)
    arousal = Column(Float, nullable=False)
    session = relationship("Session")
    user = relationship("User")
