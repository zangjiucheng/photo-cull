.DEFAULT_GOAL := help

PYTHON ?= python3
NPM ?= npm
NPM_CONFIG_CACHE ?= /tmp/ai-culling-npm-cache
FLASK_HOST ?= 127.0.0.1
FLASK_PORT ?= 5050
DOCKER ?= docker
DOCKER_COMPOSE ?= docker compose
IMAGE_NAME ?= ai-culling-app

.PHONY: help setup setup-py setup-web setup-ai setup-faiss test test-py test-web build-web run-backend dev dev-desktop dev-web kill docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make setup          install Python, web, and Electron dependencies"
	@echo "  make dev            run the Electron desktop app (default development flow)"
	@echo "  make dev-web        build web assets and run Flask for browser debugging"
	@echo "  make test           run backend and frontend tests"
	@echo "  make build-web      build React frontend into static/dist"
	@echo "  make setup-ai       install optional AI scoring dependencies"
	@echo "  make setup-faiss    install optional FAISS similarity backend"
	@echo "  make docker-build   build Docker image"
	@echo "  make docker-up      run app with docker compose"
	@echo "  make clean          remove generated build/cache artifacts"

setup: setup-py setup-web

setup-py:
	$(PYTHON) -m pip install -r requirements-dev.txt

setup-ai:
	$(PYTHON) -m pip install -r requirements-ai.txt

setup-faiss:
	$(PYTHON) -m pip install -r requirements-faiss.txt

setup-web:
	cd frontend && $(NPM) --cache $(NPM_CONFIG_CACHE) install

build-web:
	cd frontend && $(NPM) --cache $(NPM_CONFIG_CACHE) run build

test: test-py test-web

test-py:
	$(PYTHON) -m pytest

test-web:
	cd frontend && $(NPM) --cache $(NPM_CONFIG_CACHE) test

kill:
	@pids=`lsof -ti tcp:$(FLASK_PORT) 2>/dev/null`; \
	if [ -n "$$pids" ]; then \
		echo "Stopping process(es) on port $(FLASK_PORT): $$pids"; \
		kill $$pids; \
	else \
		echo "No process found on port $(FLASK_PORT)"; \
	fi

run-backend:
	FLASK_HOST=$(FLASK_HOST) FLASK_PORT=$(FLASK_PORT) $(PYTHON) app.py

dev: dev-desktop

dev-desktop: build-web kill
	cd frontend && env -u ELECTRON_RUN_AS_NODE FLASK_HOST=$(FLASK_HOST) FLASK_PORT=$(FLASK_PORT) PYTHON=$(PYTHON) BACKEND_ENTRY=app.py $(NPM) --cache $(NPM_CONFIG_CACHE) run electron:dev

dev-web: build-web kill run-backend

docker-build:
	$(DOCKER) build -f docker/Dockerfile -t $(IMAGE_NAME) .

docker-up:
	$(DOCKER_COMPOSE) -f docker/docker-compose.yml up --build

docker-down:
	$(DOCKER_COMPOSE) -f docker/docker-compose.yml down

clean:
	rm -rf static/dist
	rm -rf build dist release
	rm -rf frontend/dist
	rm -rf __pycache__
	find . -name "*.pyc" -delete
