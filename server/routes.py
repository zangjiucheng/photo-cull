from __future__ import annotations

import os

from flask import Blueprint, Response, abort, current_app, jsonify, render_template, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from . import db, events, export_enhance, scoring, similarity, storage, editing, raw_pipeline


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


@bp.route("/events", methods=["GET"])
def event_stream():
    workspace_id = request.args.get("workspace_id")
    return Response(events.stream(workspace_id), mimetype="text/event-stream")


@bp.route("/workspaces", methods=["GET"])
def workspaces():
    return jsonify({"workspaces": storage.list_workspaces()})


@bp.route("/workspaces", methods=["POST"])
def create_workspace():
    data = request.get_json(silent=True) or {}
    root_path = data.get("root_path")
    name = data.get("name")
    try:
        workspace = storage.create_workspace(str(root_path or ""), str(name) if name else None)
    except storage.InvalidWorkspaceError as exc:
        return error_response(str(exc), 400)
    return jsonify(workspace)


@bp.route("/workspaces/<workspace_id>", methods=["DELETE"])
def remove_workspace(workspace_id):
    if not storage.delete_workspace(workspace_id):
        return error_response("Workspace not found", 404)
    return jsonify({"deleted": True, "workspaceId": workspace_id})


@bp.route("/workspaces/<workspace_id>/refresh", methods=["POST"])
def refresh_workspace(workspace_id):
    try:
        storage.start_workspace_scan(workspace_id)
    except storage.InvalidWorkspaceError as exc:
        return error_response(str(exc), 404)
    return jsonify(storage.build_library_payload(workspace_id))


@bp.route("/workspaces/<workspace_id>/rescore", methods=["POST"])
def rescore_workspace(workspace_id):
    try:
        result = storage.rescore_workspace(workspace_id)
    except storage.InvalidWorkspaceError as exc:
        return error_response(str(exc), 404)
    payload = storage.build_library_payload(workspace_id)
    payload["rescore"] = result
    return jsonify(payload)


@bp.route("/workspaces/<workspace_id>/export-queue", methods=["PUT"])
def set_workspace_export_queue(workspace_id):
    data = request.get_json(silent=True) or {}
    photo_ids = data.get("photo_ids", [])
    if not isinstance(photo_ids, list):
        return error_response("photo_ids must be a list", 400)
    try:
        return jsonify(storage.set_export_queue(workspace_id, [str(photo_id) for photo_id in photo_ids]))
    except storage.InvalidWorkspaceError as exc:
        return error_response(str(exc), 404)


@bp.route("/library", methods=["GET"])
def library():
    workspace_id = request.args.get("workspace_id")
    return jsonify(storage.build_library_payload(workspace_id))


@bp.route("/library/refresh", methods=["POST"])
def refresh_library():
    data = request.get_json(silent=True) or {}
    workspace_id = data.get("workspace_id") or request.args.get("workspace_id")
    if not workspace_id:
        return error_response("workspace_id is required", 400)
    try:
        storage.start_workspace_scan(str(workspace_id))
    except storage.InvalidWorkspaceError as exc:
        return error_response(str(exc), 404)
    return jsonify(storage.build_library_payload(str(workspace_id)))


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
    try:
        path = storage.display_path_for_photo_row(photo)
    except storage.InvalidImageError:
        abort(404)
    if not os.path.exists(path):
        abort(404)
    return send_file(path)


@bp.route("/photos/export", methods=["POST"])
def export():
    data = request.get_json(silent=True) or {}
    selected_ids = data.get("selected_ids", [])
    if not isinstance(selected_ids, list) or not selected_ids:
        return error_response("No photos selected", 400)

    unique_ids = list(dict.fromkeys(str(photo_id) for photo_id in selected_ids))
    mem = storage.build_export_zip(unique_ids)
    return send_file(mem, download_name="selected.zip", as_attachment=True)


@bp.route("/workspaces/<workspace_id>/export-enhance-settings", methods=["PUT"])
def save_export_enhance_settings(workspace_id):
    if db.fetch_workspace(workspace_id) is None:
        return error_response("Workspace not found", 404)
    data = request.get_json(silent=True) or {}
    raw_settings_by_photo = data.get("settings_by_photo")
    if not isinstance(raw_settings_by_photo, dict):
        return error_response("settings_by_photo must be an object", 400)
    try:
        settings_by_photo = {
            str(photo_id): export_enhance.serialize_settings(export_enhance.parse_settings(raw_settings))
            for photo_id, raw_settings in raw_settings_by_photo.items()
            if isinstance(raw_settings, dict)
        }
    except export_enhance.ExportEnhanceError as exc:
        return error_response(str(exc), 400)
    return jsonify({
        "workspaceId": workspace_id,
        "settingsByPhoto": db.set_export_enhance_settings(workspace_id, settings_by_photo),
    })


@bp.route("/export-enhance/jobs", methods=["POST"])
def create_export_enhance_job():
    data = request.get_json(silent=True) or {}
    selected_ids = data.get("selected_ids", [])
    if not isinstance(selected_ids, list) or not selected_ids:
        return error_response("selected_ids must be a non-empty list", 400)
    try:
        settings = export_enhance.parse_settings(data.get("settings"))
        raw_settings_by_photo = data.get("settings_by_photo") if isinstance(data.get("settings_by_photo"), dict) else {}
        job = export_enhance.queue.create(
            selected_ids=[str(photo_id) for photo_id in selected_ids],
            output_folder=str(data.get("output_folder") or ""),
            settings=settings,
            settings_by_photo={
                str(photo_id): export_enhance.parse_settings(raw_settings)
                for photo_id, raw_settings in raw_settings_by_photo.items()
                if isinstance(raw_settings, dict)
            },
        )
    except export_enhance.ExportEnhanceError as exc:
        return error_response(str(exc), 400)
    return jsonify(export_enhance.serialize_job(job))


@bp.route("/export-enhance/jobs/<job_id>", methods=["GET"])
def get_export_enhance_job(job_id):
    job = export_enhance.queue.get(job_id)
    if job is None:
        return error_response("Enhance & Export job not found", 404)
    return jsonify(export_enhance.serialize_job(job))


@bp.route("/export-enhance/jobs/<job_id>/cancel", methods=["POST"])
def cancel_export_enhance_job(job_id):
    job = export_enhance.queue.cancel(job_id)
    if job is None:
        return error_response("Enhance & Export job not found", 404)
    return jsonify(export_enhance.serialize_job(job))


@bp.route("/export-enhance/preview", methods=["POST"])
def export_enhance_preview():
    data = request.get_json(silent=True) or {}
    photo_id = data.get("photo_id")
    if not photo_id:
        return error_response("photo_id is required", 400)
    try:
        settings = export_enhance.parse_settings(data.get("settings"))
        preview_path = export_enhance.render_preview(str(photo_id), settings)
    except (export_enhance.ExportEnhanceError, RuntimeError, raw_pipeline.InvalidRawImageError, OSError) as exc:
        return error_response(str(exc), 400)
    response = send_file(preview_path, mimetype="image/jpeg")
    response.headers["X-Denoise-Engine"] = getattr(preview_path, "denoise_engine", "Off")
    return response


@bp.route("/photos/<photo_id>/editing-base", methods=["GET"])
def editing_base(photo_id):
    photo = db.fetch_photo(photo_id)
    if photo is None:
        return error_response("Photo not found", 404)
    try:
        image, _exif, _source = export_enhance.queue._loader.load(photo)
    except (export_enhance.ExportEnhanceError, raw_pipeline.InvalidRawImageError, OSError) as exc:
        return error_response(str(exc), 400)
    image = editing.resize_float(image, 1600)
    return Response(image.astype("<f4").tobytes(), mimetype="application/octet-stream",
                    headers={"X-Image-Width": str(image.shape[1]), "X-Image-Height": str(image.shape[0]),
                             "Cache-Control": "no-store"})


@bp.route("/photos/<photo_id>/auto-adjustments", methods=["GET"])
def auto_adjustments(photo_id):
    photo = db.fetch_photo(photo_id)
    if photo is None:
        return error_response("Photo not found", 404)
    try:
        image, _exif, _source = export_enhance.queue._loader.load(photo)
    except (export_enhance.ExportEnhanceError, raw_pipeline.InvalidRawImageError, OSError) as exc:
        return error_response(str(exc), 400)
    return jsonify(editing.auto_adjustments(editing.resize_float(image, 512)))


@bp.route("/export-enhance/style-masks", methods=["POST"])
def export_enhance_style_masks():
    data = request.get_json(silent=True) or {}
    photo_id = data.get("photo_id")
    if not photo_id:
        return error_response("photo_id is required", 400)
    try:
        payload = export_enhance.render_style_masks(str(photo_id), int(data.get("max_edge") or 1024))
    except (export_enhance.ExportEnhanceError, RuntimeError, ValueError) as exc:
        return error_response(str(exc), 400)
    return jsonify(payload)


@bp.route("/photos/similar", methods=["GET"])
def similar_photos():
    include_clip = request.args.get("include_clip", "1") not in {"0", "false", "False"}
    cache_only = request.args.get("cache_only", "0") in {"1", "true", "True"}
    scope = request.args.get("scope", "library")
    if scope not in {"current", "library"}:
        return error_response("scope must be current or library", 400)
    workspace_id = request.args.get("workspace_id")
    if not workspace_id:
        return error_response("workspace_id is required", 400)
    folder_path = request.args.get("folder_path", "") if scope == "current" else None
    return jsonify(similarity.find_similar_groups(include_clip=include_clip, folder_path=folder_path, workspace_id=workspace_id, cache_only=cache_only))


@bp.route("/photos", methods=["DELETE"])
def delete_photos():
    data = request.get_json(silent=True) or {}
    photo_ids = data.get("photo_ids", [])
    if not isinstance(photo_ids, list) or not photo_ids:
        return error_response("photo_ids must be a non-empty list", 400)
    result = storage.exclude_photo_files([str(photo_id) for photo_id in photo_ids])
    return jsonify(result)


@bp.route("/photos/restore", methods=["POST"])
def restore_photos():
    data = request.get_json(silent=True) or {}
    workspace_id = data.get("workspace_id")
    relative_paths = data.get("relative_paths")
    if not workspace_id:
        return error_response("workspace_id is required", 400)
    if relative_paths is not None and not isinstance(relative_paths, list):
        return error_response("relative_paths must be a list", 400)
    try:
        result = storage.restore_excluded(str(workspace_id), [str(path) for path in relative_paths] if relative_paths else None)
    except storage.InvalidWorkspaceError as exc:
        return error_response(str(exc), 404)
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


@bp.route("/photos/<photo_id>/rating", methods=["PATCH"])
def set_rating(photo_id):
    data = request.get_json(silent=True) or {}
    rating = data.get("rating")
    if rating is not None:
        try:
            rating = int(rating)
        except (TypeError, ValueError):
            return error_response("rating must be an integer from 1 to 5 or null", 400)
        if rating < 1 or rating > 5:
            return error_response("rating must be between 1 and 5", 400)

    updated = db.update_rating(photo_id, rating)
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


@bp.route("/photos/<photo_id>/orientation", methods=["PATCH"])
def set_orientation(photo_id):
    data = request.get_json(silent=True) or {}
    orientation_override = data.get("orientation_override")

    if orientation_override is not None:
        try:
            orientation_override = int(orientation_override)
        except (TypeError, ValueError):
            return error_response("orientation_override must be 0, 90, 180, 270, or null", 400)
        if orientation_override not in {0, 90, 180, 270}:
            return error_response("orientation_override must be 0, 90, 180, 270, or null", 400)
        if orientation_override == 0:
            orientation_override = None

    updated = db.update_orientation_override(photo_id, orientation_override)
    if not updated:
        return error_response("Photo not found", 404)

    row = db.fetch_photo(photo_id)
    return jsonify(db.row_to_photo(row))
