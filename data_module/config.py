from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Tuple

from dotenv import load_dotenv


DEFAULT_DOMAINS: Tuple[str, ...] = (
    "facebook.com",
    "threads.net",
    "threads.com",
    "x.com",
    "twitter.com",
    "reddit.com",
    "tiktok.com",
    "instagram.com",
)

DEFAULT_INTENTS: Tuple[str, ...] = (
    "bị lừa",
    "bóc phốt",
    "lừa đảo",
    "giả mạo",
    "chuyển khoản",
    "mất tiền",
    "link giả",
    "app giả",
    "số tài khoản",
    "số điện thoại",
)


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_service_role_key: str
    tinyfish_api_key: str
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-20b"
    serpapi_api_key: str = ""
    serpapi_backup_keys: Tuple[str, ...] = ()
    openai_api_key: str = ""
    openai_model: str = "gpt-5.6-luna"
    openai_reasoning_effort: str = "none"
    discovery_provider: str = "serpapi"
    worker_poll_seconds: float = 3.0
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, require_all: bool = False) -> "Settings":
        # The local Settings tab can rotate provider keys while the worker stays
        # alive. Reload .env on every call so the next job uses the new values.
        load_dotenv(override=True)
        settings = cls(
            supabase_url=os.getenv(
                "SUPABASE_URL", "https://xrvrzpmwmqowymhuksse.supabase.co"
            ).rstrip("/"),
            supabase_service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            tinyfish_api_key=os.getenv("TINYFISH_API_KEY", ""),
            groq_api_key=os.getenv("GROQ_API_KEY", ""),
            groq_model=os.getenv("GROQ_MODEL", "openai/gpt-oss-20b"),
            serpapi_api_key=os.getenv("SERPAPI_API_KEY", ""),
            serpapi_backup_keys=tuple(
                key.strip()
                for key in os.getenv("SERPAPI_BACKUP_KEYS", "").split(",")
                if key.strip()
            ),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            openai_model=os.getenv("OPENAI_MODEL", "gpt-5.6-luna"),
            openai_reasoning_effort=os.getenv(
                "OPENAI_REASONING_EFFORT", "none"
            ).lower(),
            discovery_provider=os.getenv(
                "DISCOVERY_PROVIDER", "serpapi"
            ).lower(),
            worker_poll_seconds=float(os.getenv("WORKER_POLL_SECONDS", "3")),
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        )
        if require_all:
            missing = settings.missing_required()
            if missing:
                raise RuntimeError(
                    "Missing required environment variables: " + ", ".join(missing)
                )
        return settings

    def missing_required(self) -> Tuple[str, ...]:
        missing = []
        if not self.supabase_url:
            missing.append("SUPABASE_URL")
        if not self.supabase_service_role_key:
            missing.append("SUPABASE_SERVICE_ROLE_KEY")
        if not self.tinyfish_api_key:
            missing.append("TINYFISH_API_KEY")
        if not self.serpapi_api_key:
            missing.append("SERPAPI_API_KEY")
        if not self.openai_api_key:
            missing.append("OPENAI_API_KEY")
        return tuple(missing)
