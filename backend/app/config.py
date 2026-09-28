"""Application settings, loaded from the repo-root .env file and the environment."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    HINDSIGHT_BASE_URL: str
    HINDSIGHT_API_KEY: str
    HINDSIGHT_BANK_ID: str = "nimbus-oncall"

    OPENROUTER_API_KEY: str
    OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"
    LLM_MODEL_PRIMARY: str = "nvidia/nemotron-3-super-120b-a12b:free"
    LLM_MODEL_FALLBACK: str = "nvidia/nemotron-3-ultra-550b-a55b:free"
    LLM_MODEL_VISION: str = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    LLM_MODEL_VISION_FALLBACK: str = "google/gemma-4-31b-it:free"

    DATABASE_URL: str = f"sqlite:///{(REPO_ROOT / 'backend' / 'oncall.db').as_posix()}"
    FRONTEND_ORIGIN: str = "http://localhost:5173"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
