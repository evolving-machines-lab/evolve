#!/bin/bash
# Setup Python environment for Evolve orchestration
# Creates .venv in current directory and installs evolve-sdk

set -e

VENV_DIR=".venv"

if [ -d "$VENV_DIR" ]; then
    echo "Virtual environment exists at $VENV_DIR"
    source "$VENV_DIR/bin/activate"
else
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    source "$VENV_DIR/bin/activate"
    echo "Installing evolve-sdk..."
    pip install --quiet evolve-sdk
fi

echo "Ready. Activate with: source $VENV_DIR/bin/activate"
