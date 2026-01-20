.PHONY: install build build-dev build-prod package verify-bridge test clean

install:
	pip install -e ".[dev]"

build:
	cd bridge && npm install && npm run build:prod

build-dev:
	cd bridge && npm install && npm run build:dev

build-prod:
	cd bridge && npm install && npm run build:prod

package: verify-bridge
	python -m build

verify-bridge:
	@if [ ! -f bridge/dist/bridge.bundle.cjs ]; then \
		echo "❌ Bridge bundle not found at bridge/dist/bridge.bundle.cjs"; \
		echo "   Run 'make build-prod' or 'npm run build:python-bridge' from project root first."; \
		exit 1; \
	fi
	@echo "✓ Bridge bundle verified"

test:
	pytest -v

test-unit:
	pytest tests/ -v --ignore=tests/integration

test-integration:
	pytest tests/integration/ -v

clean:
	rm -rf build dist *.egg-info
	rm -rf bridge/node_modules
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
