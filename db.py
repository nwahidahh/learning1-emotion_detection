from sqlalchemy import create_engine
from sqlalchemy import text
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = "sqlite:///./emotion.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def _table_columns(conn, table_name: str):
    rows = conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    return {row[1] for row in rows}


def _ensure_column(conn, table_name: str, column_name: str, ddl: str):
    if column_name not in _table_columns(conn, table_name):
        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {ddl}"))


def _migrate_sqlite_schema(engine):
    with engine.begin() as conn:
        existing_tables = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            ).fetchall()
        }

        if "users" in existing_tables:
            _ensure_column(conn, "users", "email", "email VARCHAR")
            _ensure_column(conn, "users", "hashed_password", "hashed_password VARCHAR")
            _ensure_column(conn, "users", "is_active", "is_active BOOLEAN DEFAULT 1")
            _ensure_column(conn, "users", "created_at", "created_at DATETIME")

        if "sessions" in existing_tables:
            _ensure_column(conn, "sessions", "material_id", "material_id INTEGER")

        if "emotion_logs" in existing_tables:
            _ensure_column(conn, "emotion_logs", "client_timestamp", "client_timestamp VARCHAR")
            _ensure_column(conn, "emotion_logs", "confidence", "confidence FLOAT")
            _ensure_column(conn, "emotion_logs", "model_version", "model_version VARCHAR")
            _ensure_column(conn, "emotion_logs", "source", "source VARCHAR DEFAULT 'client'")

        if "learning_materials" in existing_tables:
            _ensure_column(conn, "learning_materials", "external_url", "external_url VARCHAR")
            _ensure_column(conn, "learning_materials", "instruction", "instruction TEXT")

        if "material_comments" in existing_tables:
            _ensure_column(conn, "material_comments", "parent_comment_id", "parent_comment_id INTEGER")

        if "admin_audit_logs" in existing_tables:
            _ensure_column(conn, "admin_audit_logs", "entity_type", "entity_type VARCHAR")
            _ensure_column(conn, "admin_audit_logs", "entity_id", "entity_id INTEGER")
            _ensure_column(conn, "admin_audit_logs", "detail", "detail TEXT")


def init_db(engine=engine):
    Base.metadata.create_all(bind=engine)
    _migrate_sqlite_schema(engine)
