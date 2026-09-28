"""Shared Redis connection pool for payments-api workers."""

import redis

from payments import settings

pool = redis.ConnectionPool.from_url(
    settings.REDIS_URL,
    max_connections=settings.REDIS_MAX_POOL,
    socket_timeout=settings.REDIS_SOCKET_TIMEOUT_MS / 1000,
)


def client() -> redis.Redis:
    # redis-py raises ConnectionError("Too many connections") when every pooled connection is checked out.
    return redis.Redis(connection_pool=pool)
