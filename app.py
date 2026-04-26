from flask import Flask, request, jsonify, render_template, send_file, send_from_directory, abort
import os
from PIL import Image
import numpy as np
import zipfile
import io
import importlib
import importlib.util
from uuid import uuid4
from werkzeug.utils import secure_filename
from collections import defaultdict
import hashlib
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__)
# Avoid host-header rejections for common local dev entry points.
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
cors_spec = importlib.util.find_spec("flask_cors")
if cors_spec is not None:
    cors_module = importlib.import_module("flask_cors")
    cors_module.CORS(app)
UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
DIST_DIR = os.path.join(app.static_folder or "static", "dist")
DIST_ASSETS_DIR = os.path.join(DIST_DIR, "assets")


def resolve_db_path():
    configured = os.getenv("DB_PATH")
    if configured:
        return configured

    default_data_path = os.path.join("data", "ai_culling.db")
    legacy_path = "ai_culling.db"

    # Backward compatibility: if legacy db exists and new path does not, keep using legacy.
    if os.path.exists(legacy_path) and not os.path.exists(default_data_path):
        return legacy_path
    return default_data_path


DB_PATH = resolve_db_path()
DB_DIR = os.path.dirname(DB_PATH)
if DB_DIR:
    os.makedirs(DB_DIR, exist_ok=True)

SCORE_EXECUTOR = ThreadPoolExecutor(max_workers=2)
RUNNING_JOBS = set()
JOBS_LOCK = threading.Lock()
GC_LOCK = threading.Lock()
GC_INTERVAL_SECONDS = int(os.getenv("GC_INTERVAL_SECONDS", "300"))
LAST_GC_AT = 0.0

# Try load pyiqa
try:
    import pyiqa
    model = pyiqa.create_metric('musiq', device='cpu')
    USE_MODEL = True
except:
    USE_MODEL = False


def heuristic_score(img):
    arr = np.array(img)
    sharpness = np.var(arr)
    brightness = arr.mean()
    return 0.5 * sharpness + 0.5 * brightness


def score_image(path):
    if USE_MODEL:
        score = model(path)
        return float(score.item())
    else:
        img = Image.open(path).convert("RGB")
        return float(heuristic_score(img))


def allowed_image(filename):
    _, ext = os.path.splitext(filename.lower())
    return ext in ALLOWED_EXTS


def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                folder TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                mtime REAL NOT NULL,
                size INTEGER NOT NULL,
                content_hash TEXT,
                score REAL,
                manual_score REAL,
                decision TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(photos)").fetchall()
        }
        if "decision" not in columns:
            conn.execute("ALTER TABLE photos ADD COLUMN decision TEXT")
        if "content_hash" not in columns:
            conn.execute("ALTER TABLE photos ADD COLUMN content_hash TEXT")
        if "manual_score" not in columns:
            conn.execute("ALTER TABLE photos ADD COLUMN manual_score REAL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_folder_path ON photos(folder_path)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status)")


def row_to_photo(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "score": row["score"],
        "manualScore": row["manual_score"],
        "path": row["path"],
        "url": f"/uploads/{row['id']}",
        "folder": row["folder"],
        "folderPath": row["folder_path"],
        "relativePath": row["relative_path"],
        "mtime": row["mtime"],
        "size": row["size"],
        "decision": row["decision"],
        "status": row["status"],
        "error": row["error"],
    }


def update_decision(photo_id, decision):
    now = time.time()
    with db_conn() as conn:
        row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE photos SET decision = ?, updated_at = ? WHERE id = ?",
            (decision, now, photo_id),
        )
    return True


def update_manual_score(photo_id, manual_score):
    now = time.time()
    with db_conn() as conn:
        row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE photos SET manual_score = ?, status = 'done', error = NULL, updated_at = ? WHERE id = ?",
            (manual_score, now, photo_id),
        )
    return True


def fetch_photo(photo_id):
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
    return row


def compute_content_hash(path):
    digest = hashlib.sha1()
    with open(path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def insert_or_update_photo(photo_id, name, path, relative_path, folder, folder_path, mtime, size, content_hash):
    now = time.time()
    with db_conn() as conn:
        row = conn.execute(
            "SELECT id, score, status, content_hash FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO photos (id, name, path, relative_path, folder, folder_path, mtime, size, content_hash, score, decision, status, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)
                """,
                (photo_id, name, path, relative_path, folder, folder_path, mtime, size, content_hash, now, now),
            )
            return "inserted"

        conn.execute(
            """
            UPDATE photos
            SET name = ?, path = ?, relative_path = ?, folder = ?, folder_path = ?, mtime = ?, size = ?, content_hash = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, path, relative_path, folder, folder_path, mtime, size, content_hash, now, photo_id),
        )

        if row["content_hash"] != content_hash and row["status"] != "processing":
            conn.execute(
                "UPDATE photos SET score = NULL, status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
                (now, photo_id),
            )
            return "pending"

        if row["score"] is None and row["status"] != "processing":
            conn.execute(
                "UPDATE photos SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
                (now, photo_id),
            )
            return "pending"
    return "updated"


def make_photo_id(path):
    relative_path = os.path.relpath(path, UPLOAD_FOLDER).replace(os.sep, "/")
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:16]


def folder_name(relative_folder):
    if not relative_folder:
        return "Root"
    return os.path.basename(relative_folder) or relative_folder



def index_uploaded_file(path, photo_id=None, display_name=None):
    filename = os.path.basename(path)
    if not allowed_image(filename):
        return None, "ignored"

    resolved_id = photo_id or make_photo_id(path)
    name = display_name or filename
    relative_path = os.path.relpath(path, UPLOAD_FOLDER).replace(os.sep, "/")
    relative_folder = os.path.dirname(relative_path)
    stat = os.stat(path)
    content_hash = compute_content_hash(path)

    state = insert_or_update_photo(
        photo_id=resolved_id,
        name=name,
        path=path,
        relative_path=relative_path,
        folder=folder_name(relative_folder),
        folder_path=relative_folder,
        mtime=stat.st_mtime,
        size=stat.st_size,
        content_hash=content_hash,
    )

    row = fetch_photo(resolved_id)
    return (row_to_photo(row) if row else None), state


def mark_processing(photo_id):
    with db_conn() as conn:
        conn.execute(
            "UPDATE photos SET status = 'processing', error = NULL, updated_at = ? WHERE id = ?",
            (time.time(), photo_id),
        )


def mark_done(photo_id, score_value):
    with db_conn() as conn:
        conn.execute(
            "UPDATE photos SET score = ?, status = 'done', error = NULL, updated_at = ? WHERE id = ?",
            (round(float(score_value), 2), time.time(), photo_id),
        )


def mark_error(photo_id, message):
    with db_conn() as conn:
        conn.execute(
            "UPDATE photos SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
            (str(message)[:500], time.time(), photo_id),
        )


def score_job(photo_id, path):
    try:
        mark_processing(photo_id)
        score_value = score_image(path)
        mark_done(photo_id, score_value)
    except Exception as exc:
        mark_error(photo_id, exc)
    finally:
        with JOBS_LOCK:
            RUNNING_JOBS.discard(photo_id)


def enqueue_scoring(photo_id, path):
    with JOBS_LOCK:
        if photo_id in RUNNING_JOBS:
            return
        RUNNING_JOBS.add(photo_id)
    SCORE_EXECUTOR.submit(score_job, photo_id, path)


def gc_missing_photos():
    removed = 0
    with db_conn() as conn:
        rows = conn.execute("SELECT id, path FROM photos").fetchall()
        missing = [row["id"] for row in rows if not os.path.exists(row["path"])]
        if missing:
            conn.executemany("DELETE FROM photos WHERE id = ?", [(photo_id,) for photo_id in missing])
            removed = len(missing)
    if removed:
        with JOBS_LOCK:
            for photo_id in missing:
                RUNNING_JOBS.discard(photo_id)
    return removed


def maybe_run_gc(force=False):
    global LAST_GC_AT
    now = time.time()
    with GC_LOCK:
        if not force and now - LAST_GC_AT < GC_INTERVAL_SECONDS:
            return 0
        LAST_GC_AT = now
    return gc_missing_photos()


def scan_upload_folder(force_gc=False):
    maybe_run_gc(force=force_gc)
    for root, _dirs, files in os.walk(UPLOAD_FOLDER):
        for file_name in sorted(files):
            if not allowed_image(file_name):
                continue
            record, state = index_uploaded_file(os.path.join(root, file_name))
            if record and state in {"inserted", "pending"}:
                enqueue_scoring(record["id"], record["path"])


def build_library_payload():
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM photos ORDER BY relative_path ASC").fetchall()

    photos = [row_to_photo(row) for row in rows]
    folders = defaultdict(list)

    for photo in photos:
        folders[photo["folderPath"]].append(photo)

    folder_items = []
    for folder_path, items in folders.items():
        scored = [item["score"] for item in items if item["score"] is not None]
        folder_items.append({
            "path": folder_path,
            "name": folder_name(folder_path),
            "count": len(items),
            "bestScore": round(max(scored), 2) if scored else 0,
            "mtime": max(item["mtime"] for item in items),
        })

    folder_items.sort(key=lambda item: (item["path"].count("/"), item["path"], item["name"]))

    summary = {
        "pending": sum(1 for photo in photos if photo["status"] == "pending"),
        "processing": sum(1 for photo in photos if photo["status"] == "processing"),
        "done": sum(1 for photo in photos if photo["status"] == "done"),
        "error": sum(1 for photo in photos if photo["status"] == "error"),
    }

    return {"folders": folder_items, "photos": photos, "summary": summary}


init_db()
scan_upload_folder()


@app.route("/")
def index():
    dist_index = os.path.join(DIST_DIR, "index.html")
    if os.path.exists(dist_index):
        return send_from_directory(DIST_DIR, "index.html")
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    with db_conn() as conn:
        total = conn.execute("SELECT COUNT(*) AS c FROM photos").fetchone()["c"]
        done = conn.execute("SELECT COUNT(*) AS c FROM photos WHERE status = 'done'").fetchone()["c"]
    return jsonify({"ok": True, "dbPath": DB_PATH, "photos": total, "done": done})


@app.route("/library", methods=["GET"])
def library():
    maybe_run_gc(force=False)
    return jsonify(build_library_payload())


@app.route("/refresh", methods=["POST"])
def refresh_library():
    scan_upload_folder(force_gc=True)
    return jsonify(build_library_payload())


@app.route("/assets/<path:filename>")
def dist_assets(filename):
    if not os.path.exists(DIST_ASSETS_DIR):
        abort(404)
    return send_from_directory(DIST_ASSETS_DIR, filename)


@app.route("/upload", methods=["POST"])
def upload():
    files = request.files.getlist("files")
    results = []

    if not files:
        return jsonify({"error": "No files provided"}), 400

    for f in files:
        safe_name = secure_filename(f.filename or "")
        if not safe_name or not allowed_image(safe_name):
            continue

        photo_id = uuid4().hex
        disk_name = f"{photo_id}_{safe_name}"
        path = os.path.join(UPLOAD_FOLDER, disk_name)
        f.save(path)

        record, _state = index_uploaded_file(path, photo_id=photo_id, display_name=safe_name)
        if record is None:
            continue

        enqueue_scoring(record["id"], record["path"])
        results.append(record)

    if not results:
        return jsonify({"error": "No supported image files were uploaded"}), 400

    results.sort(key=lambda x: x["name"])
    return jsonify(results)


@app.route("/uploads/<photo_id>")
def uploaded_image(photo_id):
    photo = fetch_photo(photo_id)
    if not photo:
        abort(404)

    path = photo["path"]
    if not os.path.exists(path):
        abort(404)
    return send_file(path)


@app.route("/export", methods=["POST"])
def export():
    data = request.get_json(silent=True) or {}
    selected_ids = data.get("selected_ids", [])

    if not selected_ids:
        return jsonify({"error": "No photos selected"}), 400

    mem = io.BytesIO()
    with zipfile.ZipFile(mem, 'w') as z:
        for photo_id in selected_ids:
            row = fetch_photo(photo_id)
            if not row:
                continue
            path = row["path"]
            if os.path.exists(path):
                z.write(path, row["name"])

    mem.seek(0)
    return send_file(mem, download_name="selected.zip", as_attachment=True)


@app.route("/decision", methods=["POST"])
def set_decision():
    data = request.get_json(silent=True) or {}
    photo_id = data.get("photo_id")
    decision = data.get("decision")

    if not isinstance(photo_id, str) or not photo_id:
        return jsonify({"error": "photo_id is required"}), 400

    if decision not in {"accepted", "rejected", None}:
        return jsonify({"error": "decision must be accepted, rejected, or null"}), 400

    updated = update_decision(photo_id, decision)
    if not updated:
        return jsonify({"error": "Photo not found"}), 404

    row = fetch_photo(photo_id)
    return jsonify(row_to_photo(row))


@app.route("/score", methods=["POST"])
def set_score():
    data = request.get_json(silent=True) or {}
    photo_id = data.get("photo_id")
    manual_score = data.get("manual_score")

    if not isinstance(photo_id, str) or not photo_id:
        return jsonify({"error": "photo_id is required"}), 400

    if manual_score is not None:
        try:
            manual_score = float(manual_score)
        except (TypeError, ValueError):
            return jsonify({"error": "manual_score must be a number or null"}), 400
        if manual_score < 0 or manual_score > 100:
            return jsonify({"error": "manual_score must be between 0 and 100"}), 400
        manual_score = round(manual_score, 2)

    updated = update_manual_score(photo_id, manual_score)
    if not updated:
        return jsonify({"error": "Photo not found"}), 404

    row = fetch_photo(photo_id)
    return jsonify(row_to_photo(row))


if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", "5050"))
    app.run(debug=True, host=host, port=port)
