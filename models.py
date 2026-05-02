from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Boolean, Text
from sqlalchemy.orm import relationship
from datetime import datetime, timezone


def now_utc():
    return datetime.now(timezone.utc)


from db import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, nullable=False, index=True)
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="student")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now_utc)

    consents = relationship("ConsentRecord", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("Session", back_populates="user")
    emotion_logs = relationship("EmotionLog", back_populates="user")
    material_comments = relationship("MaterialComment", back_populates="student")
    material_activities = relationship("MaterialActivity", back_populates="student")


class ConsentRecord(Base):
    __tablename__ = "consent_records"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String, nullable=False)  # accepted | withdrawn
    policy_version = Column(String, nullable=False)
    timestamp = Column(DateTime, default=now_utc, nullable=False)

    user = relationship("User", back_populates="consents")


class LearningMaterial(Base):
    __tablename__ = "learning_materials"
    id = Column(Integer, primary_key=True, index=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String, nullable=False)
    subject = Column(String, nullable=False)
    duration_minutes = Column(Integer, nullable=True)
    file_path = Column(String, nullable=True)
    file_type = Column(String, nullable=False)  # pdf | link | video
    external_url = Column(String, nullable=True)
    instruction = Column(Text, nullable=True)
    created_at = Column(DateTime, default=now_utc)

    teacher = relationship("User")
    assignments = relationship("MaterialAssignment", back_populates="material", cascade="all, delete-orphan")
    comments = relationship("MaterialComment", back_populates="material", cascade="all, delete-orphan")
    activities = relationship("MaterialActivity", back_populates="material", cascade="all, delete-orphan")


class MaterialAssignment(Base):
    __tablename__ = "material_assignments"
    id = Column(Integer, primary_key=True, index=True)
    material_id = Column(Integer, ForeignKey("learning_materials.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    assigned_at = Column(DateTime, default=now_utc)

    material = relationship("LearningMaterial", back_populates="assignments")
    student = relationship("User")


class Session(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    material_id = Column(Integer, ForeignKey("learning_materials.id"), nullable=True)
    start_time = Column(DateTime, default=now_utc)
    end_time = Column(DateTime, nullable=True)
    user = relationship("User", back_populates="sessions")
    material = relationship("LearningMaterial")
    logs = relationship("EmotionLog", back_populates="session")


class EmotionLog(Base):
    __tablename__ = "emotion_logs"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    timestamp = Column(DateTime, default=now_utc)
    client_timestamp = Column(String, nullable=True)
    valence = Column(Float, nullable=False)
    arousal = Column(Float, nullable=False)
    confidence = Column(Float, nullable=True)
    model_version = Column(String, nullable=True)
    source = Column(String, default="client")

    session = relationship("Session", back_populates="logs")
    user = relationship("User", back_populates="emotion_logs")


class MaterialComment(Base):
    __tablename__ = "material_comments"
    id = Column(Integer, primary_key=True, index=True)
    material_id = Column(Integer, ForeignKey("learning_materials.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    parent_comment_id = Column(Integer, ForeignKey("material_comments.id"), nullable=True, index=True)
    comment_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=now_utc, nullable=False)

    material = relationship("LearningMaterial", back_populates="comments")
    student = relationship("User", back_populates="material_comments")


class MaterialActivity(Base):
    __tablename__ = "material_activities"
    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    material_id = Column(Integer, ForeignKey("learning_materials.id"), nullable=False, index=True)
    event_type = Column(String, nullable=False)  # opened | highlighted | commented
    timestamp = Column(DateTime, default=now_utc, nullable=False, index=True)

    student = relationship("User", back_populates="material_activities")
    material = relationship("LearningMaterial", back_populates="activities")


class AdminAuditLog(Base):
    __tablename__ = "admin_audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    actor_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    event_type = Column(String, nullable=False, index=True)
    entity_type = Column(String, nullable=True)
    entity_id = Column(Integer, nullable=True)
    detail = Column(Text, nullable=True)
    timestamp = Column(DateTime, default=now_utc, nullable=False, index=True)

    actor = relationship("User")
