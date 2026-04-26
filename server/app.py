from __future__ import annotations

import os

from flask import Flask

from . import db, scoring, storage
from .config import AppConfig
from .routes import bp as api_bp
from .routes import pages


def create_app(config: AppConfig | None = None) -> Flask:
    app_config = config or AppConfig()
    os.makedirs(app_config.upload_folder, exist_ok=True)

    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config["MAX_CONTENT_LENGTH"] = app_config.max_content_length
    app.config["DIST_DIR"] = os.path.join(app.static_folder or "static", "dist")
    app.config["DIST_ASSETS_DIR"] = os.path.join(app.config["DIST_DIR"], "assets")
    app.config["TRUSTED_HOSTS"] = [
        "127.0.0.1",
        "localhost",
        "::1",
        "0.0.0.0",
        "127.0.0.1:5000",
        "127.0.0.1:5050",
        "localhost:5000",
        "localhost:5050",
    ]

    db.configure(app_config)
    storage.configure(app_config)
    scoring.configure(app_config)
    db.init_db()

    app.register_blueprint(pages)
    app.register_blueprint(api_bp, url_prefix="/api")
    return app
