"""Wake word listener for Jarvis.

Listens to the Mac's microphone for "Hey Jarvis" with openWakeWord and prints
one JSON line per event to stdout, which the Node server reads:

    {"event": "ready"}
    {"event": "wake", "score": 0.91}
    {"event": "error", "message": "..."}

Audio stays in this process; nothing is recorded or sent anywhere. The server
starts this only while hands-free is on, and stops it when hands-free goes off.
"""
import hashlib
import json
import os
import sys
import time

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "wake")
# From the official openWakeWord v0.5.1 GitHub release. The release doesn't
# publish checksums, so these were measured on first download and pinned.
FILES = {
    "melspectrogram.onnx": "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    "embedding_model.onnx": "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
    "hey_jarvis_v0.1.onnx": "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
}
WAKEWORD = "hey_jarvis_v0.1"
THRESHOLD = float(os.environ.get("JARVIS_WAKE_THRESHOLD", "0.5"))
COOLDOWN = 2.0      # seconds to ignore after a wake, so one phrase fires once
FRAME = 1280        # 80 ms at 16 kHz, what openWakeWord expects


def emit(event, **data):
    print(json.dumps({"event": event, **data}), flush=True)


def verify():
    for name, want in FILES.items():
        path = os.path.join(MODELS, name)
        if not os.path.exists(path):
            raise RuntimeError(f"Missing wake word model {name}. Run: npm run setup-wake")
        with open(path, "rb") as f:
            got = hashlib.sha256(f.read()).hexdigest()
        if got != want:
            raise RuntimeError(f"Checksum mismatch for {name}. Delete models/wake and run: npm run setup-wake")


def main():
    try:
        verify()
        import sounddevice as sd
        from openwakeword.model import Model

        model = Model(
            wakeword_models=[os.path.join(MODELS, f"{WAKEWORD}.onnx")],
            inference_framework="onnx",
            melspec_model_path=os.path.join(MODELS, "melspectrogram.onnx"),
            embedding_model_path=os.path.join(MODELS, "embedding_model.onnx"),
        )
        stream = sd.InputStream(samplerate=16000, channels=1, dtype="int16", blocksize=FRAME)
        stream.start()
    except Exception as e:  # noqa: BLE001 - report any start-up failure to the server
        emit("error", message=str(e))
        return 1

    emit("ready")
    quiet_until = 0.0
    with stream:
        while True:
            frame, _ = stream.read(FRAME)
            score = model.predict(frame[:, 0])[WAKEWORD]
            now = time.monotonic()
            if score >= THRESHOLD and now >= quiet_until:
                emit("wake", score=round(float(score), 3))
                quiet_until = now + COOLDOWN
                model.reset()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
