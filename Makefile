.DEFAULT_GOAL := help

PYTHON ?= python3
NPM ?= npm
NPM_CONFIG_CACHE ?= /tmp/ai-culling-npm-cache
FLASK_HOST ?= 127.0.0.1
FLASK_PORT ?= 5050
DOCKER ?= docker
DOCKER_COMPOSE ?= docker compose
IMAGE_NAME ?= ai-culling-app

.PHONY: help setup setup-ai setup-faiss setup-py setup-web build-web test test-py test-web kill run-backend dev docker-build docker-up docker-down clean

help:
	@echo "Available targets:"
	@echo "  make setup        - install Python and frontend dependencies"
	@echo "  make setup-ai     - install optional AI scoring dependencies"
	@echo "  make setup-faiss  - install optional FAISS index backend"
	@echo "  make setup-py     - install Python dependencies"
	@echo "  make setup-web    - install frontend dependencies"
	@echo "  make build-web    - build React TSX frontend to static/dist"
	@echo "  make test         - run backend and frontend tests"
	@echo "  make test-py      - run backend tests"
	@echo "  make test-web     - run frontend tests"
	@echo "  make kill         - stop any process using FLASK_PORT"
	@echo "  make run-backend  - run Flask backend on FLASK_HOST:FLASK_PORT"
	@echo "  make dev          - build frontend then run backend"
	@echo "  make docker-build - build Docker image"
	@echo "  make docker-up    - run app with docker compose"
	@echo "  make docker-down  - stop docker compose services"
	@echo "  make clean        - remove build artifacts"

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

dev: build-web kill run-backend

docker-build:
	$(DOCKER) build -f docker/Dockerfile -t $(IMAGE_NAME) .

docker-up:
	$(DOCKER_COMPOSE) -f docker/docker-compose.yml up --build

docker-down:
	$(DOCKER_COMPOSE) -f docker/docker-compose.yml down

clean:
	rm -rf static/dist
	rm -rf build dist
	rm -rf release
	rm -rf __pycache__
	find . -name "*.pyc" -delete
