from pathlib import Path

from PIL import Image

from server import scoring


class FakeScore:
    def __init__(self, value: float):
        self.value = value

    def item(self) -> float:
        return self.value


class FakeMetric:
    def __init__(self, value: float | None = None, error: Exception | None = None):
        self.value = value
        self.error = error

    def __call__(self, _path: str):
        if self.error:
            raise self.error
        return FakeScore(float(self.value))


def make_image(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 16), "gray").save(path)
    return path


def test_normalize_metric_score_handles_directions():
    assert scoring.normalize_metric_score("higher", 80, lower_better=False, score_range=(0, 100)) == 80
    assert scoring.normalize_metric_score("lower", 20, lower_better=True, score_range=(0, 100)) == 80


def test_score_image_multi_continues_when_metric_fails(tmp_path, monkeypatch):
    image_path = make_image(tmp_path / "sample.jpg")
    monkeypatch.setattr(scoring, "load_metrics", lambda profile="balanced": None)
    monkeypatch.setattr(scoring, "_metric_errors", {})
    monkeypatch.setattr(scoring, "_metrics", {
        "technical": scoring.LoadedMetric("technical", "musiq", 0.45, FakeMetric(80), False, (0, 100)),
        "aesthetic": scoring.LoadedMetric("aesthetic", "nima", 0.25, FakeMetric(error=RuntimeError("model failed")), False, (0, 10)),
    })

    score_value, details = scoring.score_image_multi(str(image_path))

    assert 0 <= score_value <= 100
    assert details["metrics"]["musiq"]["status"] == "ok"
    assert details["metrics"]["nima"]["status"] == "error"
    assert "nima" in details["errors"]


def test_score_image_multi_uses_heuristic_without_pyiqa(tmp_path, monkeypatch):
    image_path = make_image(tmp_path / "sample.jpg")
    monkeypatch.setattr(scoring.importlib.util, "find_spec", lambda name: None if name == "pyiqa" else object())
    monkeypatch.setattr(scoring, "_metrics_loaded", False)
    monkeypatch.setattr(scoring, "_metrics", {})
    monkeypatch.setattr(scoring, "_metric_errors", {})
    monkeypatch.setattr(scoring, "_score_mode", "heuristic")

    score_value, details = scoring.score_image_multi(str(image_path))

    assert 0 <= score_value <= 100
    assert details["mode"] == "heuristic:enhanced"
    assert details["metrics"] == {}
    assert "sharpness" in details["heuristics"]
