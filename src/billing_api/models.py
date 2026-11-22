"""SQLAlchemy ORM models for the `billing` schema (see docs/data-model.md).

Business rules that must never be violated are enforced by the database itself
(UNIQUE / CHECK / FOREIGN KEY constraints), not only by application code.
"""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    MetaData,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Predictable constraint names, so Alembic migrations can refer to them reliably.
NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

MONEY = Numeric(10, 2)


class Base(DeclarativeBase):
    metadata = MetaData(schema="billing", naming_convention=NAMING_CONVENTION)


class UsageType(StrEnum):
    PHONE = "PHONE"
    INTERNET = "INTERNET"


class BillStatus(StrEnum):
    UNPAID = "UNPAID"
    PARTIALLY_PAID = "PARTIALLY_PAID"
    PAID = "PAID"


def _str_enum(enum_cls: type[StrEnum], name: str) -> Enum:
    # Stored as VARCHAR + CHECK constraint rather than a native Postgres ENUM type,
    # which is easier to change in later migrations.
    return Enum(
        enum_cls,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=20,
        values_callable=lambda e: [m.value for m in e],
    )


class Subscriber(Base):
    __tablename__ = "subscribers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    subscriber_no: Mapped[str] = mapped_column(String(20), unique=True)
    full_name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class User(Base):
    """Login identity; exactly one per subscriber. JWT `sub` = subscriber_no."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    subscriber_id: Mapped[int] = mapped_column(
        ForeignKey("subscribers.id", ondelete="CASCADE"), unique=True
    )
    username: Mapped[str] = mapped_column(String(50), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class UsageEvent(Base):
    """One row per Add Usage call: 10 phone minutes or 1 MB of internet."""

    __tablename__ = "usage_events"
    __table_args__ = (
        # Required Idempotency-Key: a retry finds this row instead of adding usage.
        UniqueConstraint("subscriber_id", "idempotency_key"),
        CheckConstraint("period_month BETWEEN 1 AND 12", name="month_range"),
        CheckConstraint("period_year BETWEEN 2000 AND 2100", name="year_range"),
        CheckConstraint("amount > 0", name="amount_positive"),
        # Bill calculation and Query Bill Detailed both filter by subscriber + period.
        Index(None, "subscriber_id", "period_year", "period_month"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    subscriber_id: Mapped[int] = mapped_column(
        ForeignKey("subscribers.id", ondelete="CASCADE")
    )
    period_year: Mapped[int] = mapped_column(SmallInteger)
    period_month: Mapped[int] = mapped_column(SmallInteger)
    usage_type: Mapped[UsageType] = mapped_column(_str_enum(UsageType, "usage_type"))
    amount: Mapped[int]  # minutes for PHONE, MB for INTERNET
    idempotency_key: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Bill(Base):
    """Stored result of Calculate Bill; one per subscriber per month."""

    __tablename__ = "bills"
    __table_args__ = (
        UniqueConstraint("subscriber_id", "period_year", "period_month"),
        CheckConstraint("period_month BETWEEN 1 AND 12", name="month_range"),
        CheckConstraint("period_year BETWEEN 2000 AND 2100", name="year_range"),
        CheckConstraint(
            "phone_minutes >= 0 AND internet_mb >= 0", name="usage_non_negative"
        ),
        CheckConstraint(
            "phone_charge >= 0 AND internet_charge >= 0", name="charges_non_negative"
        ),
        CheckConstraint("total = phone_charge + internet_charge", name="total_sum"),
        # "Preserve balance": paid can never go below 0 or above the total.
        CheckConstraint("paid_amount >= 0 AND paid_amount <= total", name="paid_range"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    subscriber_id: Mapped[int] = mapped_column(
        ForeignKey("subscribers.id", ondelete="CASCADE")
    )
    period_year: Mapped[int] = mapped_column(SmallInteger)
    period_month: Mapped[int] = mapped_column(SmallInteger)
    phone_minutes: Mapped[int]
    internet_mb: Mapped[int]
    phone_charge: Mapped[Decimal] = mapped_column(MONEY)
    internet_charge: Mapped[Decimal] = mapped_column(MONEY)
    total: Mapped[Decimal] = mapped_column(MONEY)
    paid_amount: Mapped[Decimal] = mapped_column(MONEY, server_default="0")
    status: Mapped[BillStatus] = mapped_column(
        _str_enum(BillStatus, "bill_status"), server_default=BillStatus.UNPAID.value
    )
    # Also the bill's issue date for the 15-day dispute window (guide §7.1).
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Payment(Base):
    """One row per accepted Pay Bill call. transaction_id is the idempotency key."""

    __tablename__ = "payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        Index(None, "bill_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("bills.id", ondelete="RESTRICT"))
    transaction_id: Mapped[str] = mapped_column(String(100), unique=True)
    amount: Mapped[Decimal] = mapped_column(MONEY)
    # Snapshot of the result, so a retried transaction_id replays the same response.
    paid_amount_after: Mapped[Decimal] = mapped_column(MONEY)
    remaining_after: Mapped[Decimal] = mapped_column(MONEY)
    status_after: Mapped[BillStatus] = mapped_column(
        _str_enum(BillStatus, "payment_status_after")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
