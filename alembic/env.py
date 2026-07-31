from logging.config import fileConfig

from alembic import context
from app import models  # noqa: F401
from app.config import get_settings
from app.database import Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)
config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    from app.database import create_database_engine

    migration_engine = create_database_engine()
    try:
        with migration_engine.connect() as connection:
            context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        migration_engine.dispose()


run_migrations_offline() if context.is_offline_mode() else run_migrations_online()
