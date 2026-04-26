from __future__ import annotations

import os

from flask import Blueprint, abort, current_app, jsonify, render_template, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from . import db, scoring, similarity, storage


bp = Blueprint("api", __name__)
pages = Blueprint("pages", __name__)


def error_response(message: str, status: int):
    return jsonify({"error": message}), status


@pages.app_errorhandler(RequestEntityTooLarge)
def handle_large_upload(_exc):
    return error_response("Uploaded files exceed the configured size limit", 413)


@pages.app_errorhandler(HTTPException)
def handle_http_error(exc):
    if request.path.startswith("/api/"):
        return error_response(exc.description or exc.name, exc.code or 500)
    return exc


@pages.app_errorhandler(Exception)
def handle_unexpected_error(exc):
    current_app.logger.exception("Unhandled request error")
    if request.path.startswith("/api/"):
        return error_response("Internal server error", 500)
    raise exc


@pages.route("/")
def index():
    dist_dir = current_app.config["DIST_DIR"]
    dist_index = os.path.join(dist_dir, "index.html")
    if os.path.exists(dist_index):
        return send_from_directory(dist_dir, "index.html")
    return render_template("index.html")


@pages.route("/assets/<path:filename>")
def dist_assets(filename):
    dist_assets_dir = current_app.config["DIST_ASSETS_DIR"]
    if not os.path.exists(dist_assets_dir):
        abort(404)
    return send_from_directory(dist_assets_dir, filename)


@bp.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "ok": True,
            "dbPath": db.get_config().db_path,
            "photos": db.count_photos_by_status(),
            "done": db.count_photos_by_status("done"),
            "scoreMode": scoring.score_mode(),
            "runningJobs": scoring.running_count(),
        }
    )


@bp.route("/library", methods=["GET"])
def library():
    storage.ensure_initial_scan()
    storage.maybe_run_gc(force=False)
    return jsonify(storage.build_library_payload())


@bp.route("/library/refresh", methods=["POST"])
def refresh_library():
    storage.scan_upload_folder(force_gc=True)
    return jsonify(storage.build_library_payload())


@bp.route("/photos/upload", methods=["POST"])
def upload():
    files = request.files.getlist("files")
    if not files:
        return error_response("No files provided", 400)

    results = []
    invalid_count = 0
    for file_obj in files:
        try:
            record = storage.save_upload(file_obj)
        except storage.InvalidImageError:
            invalid_count += 1
            continue
        if record is not None:
            results.append(record)

    if not results:
        message = "No supported image files were uploaded"
        if invalid_count:
            message = "No valid supported image files were uploaded"
        return error_response(message, 400)

    results.sort(key=lambda item: item["name"])
    return jsonify(results)


@bp.route("/photos/<photo_id>/image", methods=["GET"])
def uploaded_image(photo_id):
    photo = db.fetch_photo(photo_id)
    if not photo:
        abort(404)
    path = storage.resolve_disk_path(photo["path"])
    if not os.path.exists(path):
        abort(404)
    return send_file(path)


@bp.route("/photos/export", methods=["POST"])
def export():
    data = request.get_json(silent=True) or {}
    selected_ids = data.get("selected_ids", [])
    if not isinstance(selected_ids, list) or not selected_ids:
        return error_response("No photos selected", 400)

    mem = storage.build_export_zip([str(photo_id) for photo_id in selected_ids])
    return send_file(mem, download_name="selected.zip", as_attachment=True)


@bp.route("/photos/similar", methods=["GET"])
def similar_photos():
    include_clip = request.args.get("include_clip", "1") not in {"0", "false", "False"}
    return jsonify(similarity.find_similar_groups(include_clip=include_clip))


@bp.route("/photos", methods=["DELETE"])
def delete_photos():
    data = request.get_json(silent=True) or {}
    photo_ids = data.get("photo_ids", [])
    if not isinstance(photo_ids, list) or not photo_ids:
        return error_response("photo_ids must be a non-empty list", 400)
    result = storage.delete_photo_files([str(photo_id) for photo_id in photo_ids])
    return jsonify(result)


@bp.route("/photos/<photo_id>/decision", methods=["PATCH"])
def set_decision(photo_id):
    data = request.get_json(silent=True) or {}
    decision = data.get("decision")
    if decision not in {"accepted", "rejected", None}:
        return error_response("decision must be accepted, rejected, or null", 400)

    updated = db.update_decision(photo_id, decision)
    if not updated:
        return error_response("Photo not found", 404)

    row = db.fetch_photo(photo_id)
    return jsonify(db.row_to_photo(row))


@bp.route("/photos/<photo_id>/score", methods=["PATCH"])
def set_score(photo_id):
    data = request.get_json(silent=True) or {}
    manual_score = data.get("manual_score")

    if manual_score is not None:
        try:
            manual_score = float(manual_score)
        except (TypeError, ValueError):
            return error_response("manual_score must be a number or null", 400)
        if manual_score < 0 or manual_score > 100:
            return error_response("manual_score must be between 0 and 100", 400)
        manual_score = round(manual_score, 2)

    updated = db.update_manual_score(photo_id, manual_score)
    if not updated:
        return error_response("Photo not found", 404)

    row = db.fetch_photo(photo_id)
    return jsonify(db.row_to_photo(row))
