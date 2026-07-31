from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    host: str = "127.0.0.1"
    port: int = 4173
    db_path: Path = Path("data/app.db")
    backup_dir: Path = Path("backups")
    app_version: str = ""
    initial_admin_password: str = ""
    session_days: int = 7
    session_cookie_secure: bool = False
    allowed_hosts: list[str] = ["127.0.0.1", "localhost", "testserver"]
    allowed_origins: list[str] = []
    public_dir: Path = Path("public")
    max_body_bytes: int = 4 * 1024 * 1024
    docs_enabled: bool = True

    @field_validator("allowed_hosts", "allowed_origins", mode="before")
    @classmethod
    def split_csv(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
