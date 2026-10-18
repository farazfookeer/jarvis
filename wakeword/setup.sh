#!/bin/sh
# One-off set-up for the "Hey Jarvis" wake word: a private Python environment
# plus the openWakeWord models from its official GitHub release. The listener
# checks each model's checksum before it runs.
set -e
cd "$(dirname "$0")/.."
python3 -m venv .venv-wake
.venv-wake/bin/pip install -q -r wakeword/requirements.txt
mkdir -p models/wake
.venv-wake/bin/python -I -c "import openwakeword.utils as u; u.download_models(['hey_jarvis'], target_directory='models/wake')"
echo "Wake word ready."
