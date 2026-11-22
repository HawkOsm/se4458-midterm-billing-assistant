"""Database engine (connection pool) and per-request sessions."""

from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from billing_api.config import get_settings


@lru_cache
def get_engine() -> Engine:
    # pool_pre_ping checks a pooled connection is alive before using it
    # (RDS can drop idle connections).
    return create_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed afterwards."""
    with get_session_factory()() as session:
        yield session
