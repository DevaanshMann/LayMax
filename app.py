"""LayMax web server.

Run:  python app.py   then open http://127.0.0.1:5050
"""

import json
import logging
import os
import time
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

import planner

load_dotenv()
logging.basicConfig(level=logging.INFO)
app = Flask(__name__)

MOCK = os.getenv("LAYMAX_MOCK") == "1"
MOCK_DELAY = float(os.getenv("LAYMAX_MOCK_DELAY", "2"))
DEMO_DIR = Path(__file__).parent / "demo_samples"


class MockClient:
    """Offline stand-in for the Anthropic client (LAYMAX_MOCK=1).

    Replays the worked Doha examples from the prompt file (one per stage of
    the chain) so the UI can be developed and demoed without spending tokens.
    """

    class _Messages:
        def parse(self, output_format, **_):
            stage = 1 if output_format is planner.TimeCheck else 2
            parsed = output_format.model_validate(json.loads(planner.example_output(stage)))
            return type("Resp", (), {"stop_reason": "end_turn", "parsed_output": parsed})()

    messages = _Messages()


def demo_samples() -> dict:
    """Saved real Claude results (demo_samples/*.json), keyed by file name."""
    return {f.stem: json.loads(f.read_text(encoding="utf-8")) for f in sorted(DEMO_DIR.glob("*.json"))}


@app.get("/")
def index():
    return render_template("index.html", mock=MOCK)


@app.post("/api/plan")
def plan():
    form = request.get_json(silent=True) or {}
    client = None
    if MOCK:
        time.sleep(MOCK_DELAY)  # lets the loading screen be seen and tested
        sample = demo_samples().get(form.get("demo_sample", ""))
        if sample:
            return jsonify(sample)
        client = MockClient()
    try:
        return jsonify(planner.plan_layover(form, client=client))
    except planner.PlannerError as e:
        return jsonify({"error": str(e)}), 400
    except anthropic.AuthenticationError:
        return jsonify({"error": "The server's Anthropic API key is missing or invalid. Check your .env file."}), 500
    except anthropic.BadRequestError as e:
        app.logger.exception("Claude API rejected the request")
        if "credit balance" in str(e):
            return jsonify({"error": "The Anthropic account behind this server is out of credits. Add credits in the Anthropic Console under Plans & Billing."}), 502
        return jsonify({"error": "Claude rejected the request (400). Check the server log for details."}), 502
    except anthropic.RateLimitError:
        return jsonify({"error": "Too many requests right now. Wait a minute and try again."}), 429
    except anthropic.APIStatusError as e:
        app.logger.exception("Claude API error")
        return jsonify({"error": f"Claude API error ({e.status_code}). Please try again."}), 502
    except anthropic.APIConnectionError:
        return jsonify({"error": "Could not reach the Claude API. Check your internet connection."}), 503


def demo_label(d: dict) -> str:
    trip = d["trip"]
    tags = [d["verdict"].replace("_", " ")]
    if trip.get("budget_amount"):
        tags.append(f"{trip['budget_currency']} {trip['budget_amount']:g} cap")
    if trip.get("visited_before"):
        tags.append("been before")
    return " · ".join([d["city"].split(",")[0]] + tags)


@app.get("/api/demo-samples")
def list_demo_samples():
    if not MOCK:
        return jsonify([])
    return jsonify([
        {"id": key, "label": demo_label(d), "trip": d["trip"]}
        for key, d in demo_samples().items()
    ])


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "model": planner.MODEL, "mock": MOCK})


if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("PORT", 5050)))
