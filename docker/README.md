# Docker Run

## 1) Start container

make docker-up

Open: http://127.0.0.1:5000

The Docker image builds the frontend inside a Node stage and serves it from Flask/Gunicorn.

## 2) Stop container

make docker-down

## Notes

- Docker files are in docker/
- .dockerignore remains in repository root because docker build context is the repository root.
- uploads and sqlite db are mounted from host:
  - ./uploads -> /app/uploads
  - ./data -> /app/data (database file: /app/data/ai_culling.db)
- frontend assets are built into the image and are not mounted from the host.
