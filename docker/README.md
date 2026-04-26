# Docker Run

## 1) Build frontend first

cd frontend
npm install
npm run build

This generates static/dist used by Flask.

## 2) Start container

cd ..
make docker-up

Open: http://127.0.0.1:5000

## 3) Stop container

make docker-down

## Notes

- Docker files are in docker/
- .dockerignore remains in repository root because docker build context is the repository root.
- uploads and sqlite db are mounted from host:
  - ./uploads -> /app/uploads
  - ./data -> /app/data (database file: /app/data/ai_culling.db)
