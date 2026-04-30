.DEFAULT_GOAL := help

PYTHON ?= python3
PACKAGE_VENV ?= .package-venv
PACKAGE_PYTHON ?= $(abspath $(PACKAGE_VENV)/bin/python)
NPM ?= npm
NPM_CONFIG_CACHE ?= /tmp/ai-culling-npm-cache
FLASK_HOST ?= 127.0.0.1
FLASK_PORT ?= 5050
DOCKER ?= docker
DOCKER_COMPOSE ?= docker compose
IMAGE_NAME ?= ai-culling-app

.PHONY: help setup setup-py setup-web setup-package setup-ai setup-faiss test test-py test-web build-web build-backend package package-dmg package-dir run-backend dev dev-desktop dev-web kill docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make setup          install Python, web, and Electron dependencies"
	@echo "  make dev            run the branded desktop app (default development flow)"
	@echo "  make dev-web        build web assets and run Flask for browser debugging"
	@echo "  make test           run backend and frontend tests"
	@echo "  make build-web      build React frontend into static/dist"
	@echo "  make package        build a release desktop app"
	@echo "  make package-dmg    build a macOS DMG release package"
	@echo "  make package-dir    build an unpacked desktop app for local smoke testing"
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

setup-package:
	$(PYTHON) -m venv $(PACKAGE_VENV)
	$(PACKAGE_PYTHON) -m pip install --upgrade pip
	$(PACKAGE_PYTHON) -m pip install -r requirements-package.txt
	cd frontend && $(NPM) --cache $(NPM_CONFIG_CACHE) install

build-web:
	cd frontend && $(NPM) --cache $(NPM_CONFIG_CACHE) run build

build-backend:
	cd frontend && PYTHON=$(PACKAGE_PYTHON) $(NPM) --cache $(NPM_CONFIG_CACHE) run backend:build

package: setup-package
	cd frontend && PYTHON=$(PACKAGE_PYTHON) $(NPM) --cache $(NPM_CONFIG_CACHE) run package

package-dmg: setup-package
	cd frontend && PYTHON=$(PACKAGE_PYTHON) $(NPM) --cache $(NPM_CONFIG_CACHE) run package:dmg

package-dir: setup-package
	cd frontend && PYTHON=$(PACKAGE_PYTHON) $(NPM) --cache $(NPM_CONFIG_CACHE) run package:dir

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
	rm -rf frontend/.electron-dev
	rm -rf .package-venv
	rm -rf __pycache__
	find . -name "*.pyc" -delete
