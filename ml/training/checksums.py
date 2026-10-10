"""SHA-256 of every saved model, in models/checksums.json.

The ML service unpickles a model only when its hash matches this file
(app/main.py, `pinned`), because unpickling runs code. Every training script
calls pin() right after joblib.dump; commit the model and checksums.json together.

    python training/checksums.py    # re-pin every models/*.joblib as it is now
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

MODELS = Path(__file__).resolve().parents[1] / "models"
SUMS = MODELS / "checksums.json"


def pin(path: Path) -> None:
    sums = json.loads(SUMS.read_text()) if SUMS.exists() else {}
    sums[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    SUMS.write_text(json.dumps(sums, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    for model in sorted(MODELS.glob("*.joblib")):
        pin(model)
        print(f"pinned {model.name}")
