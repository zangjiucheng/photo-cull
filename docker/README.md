# Running locally with Docker

## Start

```bash
make docker-up
```

Open <http://127.0.0.1:5000>. The port is bound to the local machine only; the app has no account authentication.

The image builds the frontend and the shared style parameters in a Node stage, then Flask / Gunicorn serves the pages and RAW processing. Electron does not run inside the container.

## Photo folders

Folders typed in the browser are container paths. The default upload folder is `/app/uploads`. To index photos on the host in place, add mounts to `volumes` in `docker-compose.yml`, for example:

```yaml
      - /absolute/path/to/photos:/photos:ro
      - /absolute/path/to/exports:/exports
```

Create these folders on the host first, then open `/photos` in the app and export to `/exports`. The originals folder can be mounted read-only; the output folder must be writable.

## Data and stopping

`uploads/` and `data/` live at the repository root and are persisted through volumes; the database is `data/ai_culling.db`. The RAW cache also lives in the data folder by default. Frontend assets are included in the image.

```bash
make docker-down
```

This stops the containers without deleting photos or the database on the host. Rebuild with `make docker-build`.
