"""Antigen Visual Classifier v0 — deterministic hand-crafted feature extractor.

SHADOW / OFFLINE / DEV-ONLY. This module is imported only by the offline
scripts/hv_vision_{train,predict,eval}.py harness. It is NOT wired into any
runtime, and nothing under apps/ imports it.

Safety boundary: this extractor produces coarse, redacted, downscaled image
features for classifying *page state* (normal page, normal modal, cookie
banner, sign-in drawer, newsletter modal, page-level human-verification wall).
It performs NO OCR, reads NO text, and must never be used to solve, click,
hold, type into, or bypass CAPTCHA / human verification. Antigen detects and
routes only.

Design (per product direction): grayscale-first, but keep color. Feature groups
are individually toggleable so we can later compare grayscale-only / color-only
/ combined. v0 default = combined, with the grayscale layout block weighted as
the dominant signal.

Implemented with numpy + Pillow only (no scipy/opencv). All steps are
deterministic — fixed thumbnail size, fixed resample filter, no randomness —
so the same frame.png always yields the same vector across train/predict/eval.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict

import numpy as np
from PIL import Image


# Default thumbnail edge length. Frames are ~2400x1454; we downscale hard so
# only coarse layout/structure survives (never legible text).
DEFAULT_THUMB = 64
# Grid used for per-tile edge / contrast / color statistics.
DEFAULT_TILES = 8


@dataclass(frozen=True)
class FeatureConfig:
    """Toggleable feature groups. Persisted in the model artifact so predict/
    eval rebuild byte-identical vectors."""

    grayscale: bool = True
    edges: bool = True
    contrast: bool = True
    color: bool = True
    thumb_size: int = DEFAULT_THUMB
    tiles: int = DEFAULT_TILES
    # Weight applied to the flattened grayscale layout block so it dominates the
    # combined vector (grayscale-first directive). Only affects the grayscale
    # group; other groups are left at native scale.
    grayscale_weight: float = 2.0

    def to_dict(self) -> Dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: Dict) -> "FeatureConfig":
        known = {f for f in FeatureConfig.__dataclass_fields__}  # type: ignore[attr-defined]
        return FeatureConfig(**{k: v for k, v in d.items() if k in known})


def feature_groups_preset(name: str) -> FeatureConfig:
    """Named presets to support later grayscale/color/combined comparison runs."""
    if name == "combined":
        return FeatureConfig(grayscale=True, edges=True, contrast=True, color=True)
    if name == "grayscale_only":
        return FeatureConfig(grayscale=True, edges=True, contrast=True, color=False)
    if name == "color_only":
        return FeatureConfig(grayscale=False, edges=False, contrast=False, color=True)
    raise ValueError(f"unknown feature preset: {name!r}")


def _load_rgb_thumb(image_path: str, thumb: int) -> np.ndarray:
    """Load -> RGB -> fixed-size thumbnail as float array in [0, 1], shape (T, T, 3)."""
    with Image.open(image_path) as im:
        im = im.convert("RGB").resize((thumb, thumb), Image.BILINEAR)
        arr = np.asarray(im, dtype=np.float64) / 255.0
    return arr


def _to_gray(rgb: np.ndarray) -> np.ndarray:
    """Luma grayscale, shape (T, T) in [0, 1]."""
    return rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114


def _tile_means(plane: np.ndarray, tiles: int) -> np.ndarray:
    """Mean of each tile in a (T, T) plane -> flat (tiles*tiles,) vector."""
    t = plane.shape[0]
    step = max(1, t // tiles)
    out = []
    for r in range(0, t, step):
        for c in range(0, t, step):
            out.append(plane[r : r + step, c : c + step].mean())
    return np.asarray(out, dtype=np.float64)


def _sobel_magnitude(gray: np.ndarray) -> np.ndarray:
    """Sobel gradient magnitude over a (T, T) gray plane, via manual array shifts.

    Captures modal borders, button/box edges, and text-density regions as a
    coarse edge map — NOT text content."""
    g = gray
    # Pad-reflect so shifts keep shape.
    gp = np.pad(g, 1, mode="edge")
    # Sobel kernels applied as combinations of shifted slices.
    # gx
    gx = (
        (gp[0:-2, 2:] + 2 * gp[1:-1, 2:] + gp[2:, 2:])
        - (gp[0:-2, 0:-2] + 2 * gp[1:-1, 0:-2] + gp[2:, 0:-2])
    )
    # gy
    gy = (
        (gp[2:, 0:-2] + 2 * gp[2:, 1:-1] + gp[2:, 2:])
        - (gp[0:-2, 0:-2] + 2 * gp[0:-2, 1:-1] + gp[0:-2, 2:])
    )
    return np.sqrt(gx * gx + gy * gy)


def extract_features(image_path: str, config: FeatureConfig | None = None) -> np.ndarray:
    """Deterministic feature vector for one frame.png.

    Concatenates the enabled groups into a single 1-D float64 vector. The group
    order is fixed (grayscale, edges, contrast, color) so vectors are stable
    across runs given the same FeatureConfig."""
    cfg = config or FeatureConfig()
    rgb = _load_rgb_thumb(image_path, cfg.thumb_size)
    gray = _to_gray(rgb)

    parts: list[np.ndarray] = []

    # 1) Grayscale layout block (primary signal) — flattened downscaled gray.
    if cfg.grayscale:
        parts.append((gray.reshape(-1) * cfg.grayscale_weight))

    # 2) Edge / gradient — per-tile mean Sobel magnitude (borders, buttons, text density).
    if cfg.edges:
        mag = _sobel_magnitude(gray)
        parts.append(_tile_means(mag, cfg.tiles))
        # Global edge stats: overall edge energy + std (busy page vs flat scrim).
        parts.append(np.asarray([mag.mean(), mag.std()], dtype=np.float64))

    # 3) Contrast / threshold — coarse high-contrast binary structure per tile.
    if cfg.contrast:
        thr = float(np.median(gray))  # cheap, deterministic Otsu-ish split
        binary = (gray > thr).astype(np.float64)
        parts.append(_tile_means(binary, cfg.tiles))
        # Global contrast: spread of luminance (dim overlay/scrim vs bright page).
        parts.append(np.asarray([gray.std(), float(thr)], dtype=np.float64))

    # 4) Color (secondary) — coarse per-channel histogram + per-tile mean RGB.
    if cfg.color:
        hist_bins = 8
        for ch in range(3):
            hist, _ = np.histogram(rgb[:, :, ch], bins=hist_bins, range=(0.0, 1.0))
            parts.append(hist.astype(np.float64) / float(rgb[:, :, ch].size))
        for ch in range(3):
            parts.append(_tile_means(rgb[:, :, ch], cfg.tiles))

    return np.concatenate(parts)


def feature_dim(config: FeatureConfig | None = None) -> int:
    """Length of the vector produced for the given config (for sanity checks)."""
    cfg = config or FeatureConfig()
    n = 0
    if cfg.grayscale:
        n += cfg.thumb_size * cfg.thumb_size
    if cfg.edges:
        n += cfg.tiles * cfg.tiles + 2
    if cfg.contrast:
        n += cfg.tiles * cfg.tiles + 2
    if cfg.color:
        n += 3 * 8 + 3 * (cfg.tiles * cfg.tiles)
    return n
