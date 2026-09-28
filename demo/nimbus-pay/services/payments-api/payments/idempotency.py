"""Idempotency keys for POST /v1/charges, stored in Redis."""

from payments import settings
from payments.redis_pool import client


def idempotency_key(merchant_id: str, request_id: str) -> str:
    return f"idem:{merchant_id}:{request_id}"


def get_idempotency_key(merchant_id: str, request_id: str) -> str | None:
    value = client().get(idempotency_key(merchant_id, request_id))
    return value.decode() if value else None


def store_idempotency_key(merchant_id: str, request_id: str, charge_id: str) -> None:
    client().set(idempotency_key(merchant_id, request_id), charge_id, ex=settings.IDEMPOTENCY_TTL_SECONDS)
