import logging
import os
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_from_directory, abort
from flask_cors import CORS
from dotenv import load_dotenv

from pipeline.ingest import extract_text_and_flag_vision
from pipeline.extraction_agent import run_extraction_agent
from pipeline.validation_agent import find_missing_fields, find_low_confidence_fields, check_consistency
from pipeline.routing_agent import escalation_score, base_route
from pipeline.explanation import build_reasoning

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder="frontend", static_url_path="")
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key")
CORS(app)

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".text"}
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB

PROCESSED_CLAIMS = []


def _allowed_file(filename: str) -> bool:
    return "." in filename and "." + filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route("/")
def index():
    return send_from_directory("frontend", "index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()})


@app.route("/process-claim", methods=["POST"])
def process_claim():
    if "fnol" not in request.files:
        return jsonify({"error": "No file uploaded. Send the FNOL document as field 'fnol'."}), 400

    file = request.files["fnol"]
    if not file.filename:
        return jsonify({"error": "Uploaded file has no filename."}), 400

    if not _allowed_file(file.filename):
        return jsonify({"error": f"Unsupported file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"}), 415

    claim_id = str(uuid.uuid4())

    try:
        file_bytes = file.read()
        logger.info("[%s] Ingesting %s (%d bytes)", claim_id, file.filename, len(file_bytes))

        full_text, needs_vision, pdf_doc = extract_text_and_flag_vision(file_bytes, file.filename)

        extraction = run_extraction_agent(
            document_text=full_text,
            needs_vision=needs_vision,
            pdf_bytes=file_bytes if needs_vision else None,
        )

        if pdf_doc is not None:
            pdf_doc.close()

        fields = extraction["extractedFields"]
        risk_signals = extraction.get("riskSignals", [])

        missing = find_missing_fields(fields)
        low_conf = find_low_confidence_fields(fields)
        consistency_issues = check_consistency(fields)

        score = escalation_score(missing, low_conf, risk_signals, consistency_issues, fields)
        route = base_route(fields, missing, low_conf, risk_signals, consistency_issues, score)

        reasoning = build_reasoning(
            route=route,
            missing_fields=missing,
            low_confidence_fields=low_conf,
            risk_signals=risk_signals,
            consistency_issues=consistency_issues,
            fields=fields,
            escalation_score=score,
        )

        result = {
            "claimId": claim_id,
            "filename": file.filename,
            "processedAt": datetime.now(timezone.utc).isoformat(),
            "needsVision": needs_vision,
            "extractedFields": fields,
            "missingFields": missing,
            "lowConfidenceFields": low_conf,
            "consistencyIssues": consistency_issues,
            "riskSignals": risk_signals,
            "escalationScore": score,
            "recommendedRoute": route,
            "reasoning": reasoning,
        }

        PROCESSED_CLAIMS.insert(0, result)
        if len(PROCESSED_CLAIMS) > 100:
            PROCESSED_CLAIMS.pop()

        logger.info("[%s] Done. Route: %s | Score: %d", claim_id, route, score)
        return jsonify(result), 200

    except RuntimeError as exc:
        logger.error("[%s] Pipeline error: %s", claim_id, exc)
        return jsonify({"error": str(exc), "claimId": claim_id}), 500

    except Exception as exc:
        logger.exception("[%s] Unexpected error: %s", claim_id, exc)
        return jsonify({"error": "An unexpected error occurred.", "claimId": claim_id}), 500


@app.route("/claims", methods=["GET"])
def list_claims():
    summaries = [
        {
            "claimId": d.get("claimId"),
            "filename": d.get("filename"),
            "recommendedRoute": d.get("recommendedRoute"),
            "escalationScore": d.get("escalationScore"),
            "processedAt": d.get("processedAt"),
            "missingFieldCount": len(d.get("missingFields", [])),
            "riskSignalCount": len(d.get("riskSignals", [])),
        }
        for d in PROCESSED_CLAIMS
    ]
    return jsonify(summaries)


@app.route("/claims/<claim_id>", methods=["GET"])
def get_claim(claim_id: str):
    if not claim_id.replace("-", "").isalnum():
        abort(400)
    for claim in PROCESSED_CLAIMS:
        if claim["claimId"] == claim_id:
            return jsonify(claim)
    return jsonify({"error": f"Claim '{claim_id}' not found."}), 404


if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG", "1") == "1", port=5000)
