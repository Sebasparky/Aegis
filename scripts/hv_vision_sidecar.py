#!/usr/bin/env python3
"""Antigen Visual Judgment v0 — dev-only LOCALHOST prediction sidecar.

WHY THIS EXISTS
  The Antigen runtime must NOT shell out to or import the offline harness
  (scripts/hv_vision_*) — see apps/api/src/runtime/visualBlockerClassifier/
  runtimeSeam.ts. Activation-gated visual judgment instead reaches inference
  through THIS small localhost HTTP sidecar. The sidecar (not the runtime) is
  allowed to import the offline harness; it loads model.joblib once and answers
  one-frame prediction requests over loopback only.

SAFETY BOUNDARY (unchanged from the harness)
  Antigen detects page STATE and routes only. This sidecar performs NO OCR, reads
  NO page text, and NEVER solves / clicks / holds / types into / bypasses any
  CAPTCHA or human-verification challenge. Its output is an ADVISORY page-state
  label + confidence. It returns NO screenshot bytes — only label/confidence/top_3.

  - Binds 127.0.0.1 only (refuses non-loopback hosts).
  - Reads a redacted frame.png from a local path the caller already wrote.
  - No continuous watching: it is request/response; the runtime only calls it when
    an existing suspicious-state trigger has already fired.

Usage:
  dev-artifacts/hv-vision-venv/bin/python scripts/hv_vision_sidecar.py \
      [--host 127.0.0.1] [--port 8782] \
      [--model dev-artifacts/hv-vision-models/model.joblib] \
      [--review-threshold 0.6]

Endpoints:
  GET  /healthz            -> {"ok": true, "model_loaded": bool, "model_version": str}
  POST /predict {frame_path} -> {predicted_label, confidence, top_3, model_version,
                                 needs_human_review}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _SCRIPT_DIR)

# The sidecar (NOT the runtime) may import the offline harness.
from hv_vision_predict import DEFAULT_MODEL, DEFAULT_REVIEW_THRESHOLD, predict  # noqa: E402

# Max request body we will read (a path string is tiny; cap defensively).
_MAX_BODY_BYTES = 8 * 1024


class _Config:
    model_path: str = DEFAULT_MODEL
    review_threshold: float = DEFAULT_REVIEW_THRESHOLD
    model_version: str = "unknown"


CONFIG = _Config()


def _load_model_version(model_path: str) -> str:
    """Best-effort model identity for telemetry/correlation. Never raises."""
    try:
        import joblib

        artifact = joblib.load(model_path)
        return str(artifact.get("trained_at") or artifact.get("harness") or "model")
    except Exception:
        return "unknown"


class JudgmentHandler(BaseHTTPRequestHandler):
    # Silence default stderr access logging (keeps dev console clean / leak-safe).
    def log_message(self, *_args) -> None:  # noqa: D401
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/healthz":
            self._send_json(
                200,
                {
                    "ok": True,
                    "model_loaded": os.path.isfile(CONFIG.model_path),
                    "model_version": CONFIG.model_version,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/predict":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > _MAX_BODY_BYTES:
            self._send_json(400, {"ok": False, "error": "bad_request"})
            return
        try:
            raw = self.rfile.read(length)
            req = json.loads(raw.decode("utf-8"))
            frame_path = req.get("frame_path")
        except Exception:
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return
        if not isinstance(frame_path, str) or not frame_path:
            self._send_json(400, {"ok": False, "error": "frame_path_required"})
            return

        try:
            result = predict(frame_path, CONFIG.model_path, CONFIG.review_threshold)
        except FileNotFoundError as exc:
            # Missing frame or model — fail soft; the runtime maps this to "uncertain".
            self._send_json(503, {"ok": False, "error": "model_or_frame_unavailable", "detail": str(exc)})
            return
        except Exception:
            self._send_json(500, {"ok": False, "error": "prediction_failed"})
            return

        # Return ONLY safe scalars — never screenshot bytes, never the frame path back.
        self._send_json(
            200,
            {
                "predicted_label": result.get("predicted_label"),
                "confidence": result.get("confidence"),
                "top_3": result.get("top_3", []),
                "model_version": CONFIG.model_version,
                "needs_human_review": result.get("needs_human_review", True),
                "advisory": "Page-state estimate only. Antigen detects and routes; it does not solve/bypass human verification.",
            },
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="Antigen Visual Judgment v0 — localhost sidecar (dev-only).")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ANTIGEN_VISUAL_JUDGMENT_PORT", "8782")))
    ap.add_argument("--model", default=os.environ.get("ANTIGEN_VISUAL_JUDGMENT_MODEL_PATH", DEFAULT_MODEL))
    ap.add_argument("--review-threshold", type=float, default=DEFAULT_REVIEW_THRESHOLD)
    args = ap.parse_args()

    # Loopback only — this sidecar must never be reachable off the dev machine.
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"[hv-vision-sidecar] refusing non-loopback host: {args.host}", file=sys.stderr)
        return 2

    CONFIG.model_path = args.model
    CONFIG.review_threshold = args.review_threshold
    CONFIG.model_version = _load_model_version(args.model)

    if not os.path.isfile(args.model):
        # Start anyway so the runtime can still fail soft; just warn loudly.
        print(f"[hv-vision-sidecar] WARNING: model not found at {args.model} (run hv_vision_train.py)", file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), JudgmentHandler)
    print(
        f"[hv-vision-sidecar] listening on http://{args.host}:{args.port} "
        f"(model_loaded={os.path.isfile(args.model)}, version={CONFIG.model_version}). "
        "Detect-and-route only; no CAPTCHA/HV solving; no continuous watching.",
        file=sys.stderr,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
