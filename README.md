# ClaimSight AI — Autonomous FNOL Claims Processing Agent

> **Gemini 2.5 Flash · Flask · Pure-Python deterministic pipeline · 1 API call per document**

An autonomous First Notice of Loss (FNOL) claims processing pipeline that extracts structured data from insurance documents, validates completeness and consistency, and routes claims — with full auditability at every step.

**📖 For detailed architecture explanation, see [explain.md](explain.md)**

---

## Table of Contents

- [Quick Start](#quick-start)
- [Project Overview](#project-overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Installation](#installation)
- [Usage](#usage)
- [API Endpoints](#api-endpoints)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick Start

```bash
# 1. Clone/enter the project directory
cd synapx_assignment

# 2. Create and activate a virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1          # On Windows PowerShell
# or source venv/bin/activate        # On macOS/Linux

# 3. Install dependencies
pip install -r requirements.txt

# 4. Set up environment variables
# Create a .env file in the project root with:
# GOOGLE_API_KEY=your_gemini_api_key_here
# FLASK_SECRET_KEY=your_secret_key

# 5. Run the Flask server
python app.py

# 6. Open browser to http://localhost:5000
```

The application will start on `http://localhost:5000` with the frontend dashboard ready.

---

## Project Overview

**ClaimSight AI** is an enterprise-grade FNOL (First Notice of Loss) claims processing system that:

- **Extracts** structured data from insurance claim documents (PDF, TXT) using Google Gemini AI
- **Validates** extracted data for completeness, confidence, and consistency
- **Routes** claims intelligently based on risk signals and escalation scores
- **Explains** every decision with full auditability and source traceability

### Key Features

✅ **Single Gemini API call per document** — cost-efficient extraction with one structured-output request  
✅ **Semantic risk signals** — detects cross-field inconsistencies, not just keywords  
✅ **Tiered confidence thresholds** — critical fields (policy #, claim type) get stricter validation (85%) vs. standard fields (60%)  
✅ **Composite escalation scoring** — multiple risk factors accumulate into justified routing decisions  
✅ **Full auditability** — every field carries confidence score and page source reference  
✅ **Deterministic pipeline** — validation, routing, and explanation are pure Python (zero LLM cost after extraction)  
✅ **Vision support** — automatically detects scanned/graphical pages and uses Gemini's vision for extraction  
✅ **Clean frontend** — modern web dashboard for document upload and result visualization  

---

## Architecture

```
FNOL Document (PDF / TXT)
        │
        ▼
┌───────────────────────────────────────────┐
│  STAGE 0 — Ingestion & Preprocessing      │  pure Python
│  • extract text with PyMuPDF              │
│  • tag pages with [PAGE n] for provenance │
│  • strip ACORD boilerplate (~1,500 tokens)│
│  • detect scanned/vision pages            │
└──────────────────────┬────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────┐
│  STAGE 1 — Extraction Agent         🤖    │  ← ONLY Gemini call
│  • gemini-2.5-flash-lite (clean text)     │
│  • gemini-2.5-flash (scanned/vision)      │
│  • structured output via responseSchema   │
│  • extracts 16 fields + risk signals      │
│  • each field: {value, confidence, source}│
└──────────────────────┬────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────┐
│  STAGE 2 — Validation Agent               │  pure Python
│  • missing required fields                │
│  • tiered confidence: critical=85%,       │
│    standard=60% (different bars by risk)  │
│  • date range + damage divergence checks  │
└──────────────────────┬────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────┐
│  STAGE 3 — Routing Agent                  │  pure Python
│  • composite escalation score             │
│    (missing=15, low-conf-critical=15,     │
│     high-signal=30, injury=20, ...)       │
│  • score ≥31  → Investigation Flag        │
│  • score ≤10 + low damage → Fast-track    │
│  • injury → Specialist Queue              │
│  • default → Manual Review               │
└──────────────────────┬────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────┐
│  STAGE 4 — Explanation Builder            │  pure Python (zero LLM cost)
│  • assembles plain-English reasoning      │
│  • from Stage 2/3 structured outputs      │
│  • deterministic: same inputs = same text │
└──────────────────────┬────────────────────┘
                       │
                       ▼
          JSON result + file persistence
```

### Design Philosophy

**Single Gemini Call per Document**  
The naive approach sends documents to Gemini 3–4 times (extract, validate, route, explain). This design uses exactly **one API call**: extraction + risk signals in a single structured-output request. Validation, routing, and explanation are all deterministic Python, eliminating redundant API calls and reducing costs.

**Semantic Risk Signals, Not Keyword Matching**  
Instead of fragile keyword detection ("staged", "inconsistent"), the extraction prompt asks Gemini to **reason about cross-field consistency** and return structured `riskSignals` with severity levels and evidence. This catches:
- Incident dates outside the policy window
- Damage estimates disproportionate to described incident
- Contradictory timestamps or vague narratives

**Composite Escalation Score**  
Every risk factor contributes weighted points. Routing decisions flow from accumulated scores, not brittle single-threshold if/else logic.

**Tiered Confidence Thresholds**  
Not every field carries equal risk:
- **Critical fields** (policy #, claim type, asset ID): 85% minimum confidence
- **Standard required fields** (incident date, location, etc.): 60% minimum confidence

**Full Auditability**  
Every field carries confidence score and page source reference. Every routing decision is explainable from first principles.

---

## Key Features

✅ **Single Gemini API call per document** — cost-efficient extraction  
✅ **Semantic risk signals** — detects cross-field inconsistencies  
✅ **Tiered confidence thresholds** — critical fields get stricter validation  
✅ **Composite escalation scoring** — multiple factors accumulate into decisions  
✅ **Full auditability** — every field has confidence score & page source  
✅ **Deterministic pipeline** — validation, routing, explanation are pure Python  
✅ **Vision support** — automatically handles scanned/graphical pages  
✅ **Clean frontend** — modern dashboard for upload and results  

---

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Google Gemini API Key (required)
GOOGLE_API_KEY=your_google_api_key_here

# Flask configuration
FLASK_ENV=development
FLASK_SECRET_KEY=your_secret_key_for_sessions
FLASK_DEBUG=1
```

### Thresholds & Scoring

All scoring constants are defined in source files and can be adjusted:

**Confidence Thresholds** (`pipeline/validation_agent.py`):
- `CRITICAL_THRESHOLD = 0.85` — Policy #, Claim Type, Asset ID
- `STANDARD_THRESHOLD = 0.60` — Other required fields

**Escalation Scoring** (`pipeline/routing_agent.py`):
- `SCORE_MISSING_FIELD = 15` — each missing required field
- `SCORE_LOW_CONF_CRITICAL = 15` — low confidence on critical field
- `SCORE_LOW_CONF_STANDARD = 5` — low confidence on standard field
- `SCORE_RISK_SIGNAL = {"low": 5, "medium": 15, "high": 30}` — per signal severity
- `SCORE_INJURY_CLAIM = 20` — injury-related claim
- `SCORE_CONSISTENCY_ISSUE = 10` — each consistency violation

**Routing Thresholds** (`pipeline/routing_agent.py`):
- `SCORE_FASTTRACK_MAX = 10` — score ≤10 + damage ≤$25k → Fast-track
- `SCORE_INVESTIGATION_MIN = 31` — score ≥31 → Investigation
- `DAMAGE_FASTTRACK_MAX = 25_000` — max damage for fast-track

---

## Installation

### Prerequisites

- **Python 3.9+**
- **Google Gemini API key** (free tier available at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey))
- **pip** package manager

### Step 1: Create Virtual Environment

```bash
# Windows PowerShell
python -m venv venv
.\venv\Scripts\Activate.ps1

# macOS/Linux
python3 -m venv venv
source venv/bin/activate
```

### Step 2: Install Dependencies

```bash
pip install -r requirements.txt
```

**Key Dependencies:**
- `flask` — Web framework
- `flask-cors` — Cross-origin request handling
- `google-genai` — Google Gemini API client
- `pymupdf` — PDF text extraction
- `python-dotenv` — Environment variable management
- `python-dateutil` — Date parsing
- `pydantic` — Data validation

### Step 3: Configure Environment

Create `.env` file in project root:

```env
GOOGLE_API_KEY=<your_api_key_here>
FLASK_SECRET_KEY=dev-secret-key
FLASK_DEBUG=1
```

---

## Usage

### Running the Server

```bash
# Activate virtual environment (if not already active)
.\venv\Scripts\Activate.ps1  # Windows
# or source venv/bin/activate # macOS/Linux

# Start Flask server
python app.py
```

**Expected Output:**
```
[INFO] Running on http://127.0.0.1:5000
[INFO] Press CTRL+C to quit
```

### Web Dashboard

Open **http://localhost:5000** in your browser.

**Upload Panel:**
1. Click **"Choose File"** to select a PDF or TXT claim document
2. Click **"Process Claim"** to submit
3. Results display with extracted fields, validation issues, routing decision, and explanation

**History Panel:**
- View all processed claims from the current session
- Each claim shows claim ID, filename, routing status, and escalation score

### Processing Flow

1. **Upload** FNOL document (PDF or TXT, max 20 MB)
2. **Ingest** → Extract text, detect scanned pages, remove boilerplate
3. **Extract** → Call Gemini once to extract 16 fields + risk signals
4. **Validate** → Check completeness, confidence thresholds, consistency
5. **Route** → Calculate escalation score, determine claim queue
6. **Explain** → Generate human-readable reasoning for every decision

---

## API Endpoints

### `POST /process-claim`

Process an FNOL claim document.

**Request:**
```
Content-Type: multipart/form-data

File upload: fnol = [PDF or TXT file]
```

**Response (200 OK):**
```json
{
  "claimId": "550e8400-e29b-41d4-a716-446655440000",
  "filename": "fnol_20240115.pdf",
  "extractedFields": {
    "policyNumber": {
      "value": "POL-2024-001234",
      "confidence": 0.98,
      "source": "[PAGE 1]"
    }
  },
  "riskSignals": [
    {
      "signal": "Date outside policy window",
      "severity": "high",
      "evidence": "Incident 2024-12-20, policy ends 2024-11-30",
      "source": "[PAGE 1]"
    }
  ],
  "validation": {
    "missingFields": ["contactDetails"],
    "lowConfidenceFields": [...],
    "consistencyIssues": []
  },
  "routing": {
    "escalationScore": 35,
    "route": "INVESTIGATION",
    "reasoning": "..."
  },
  "explanation": "This claim has been routed to Investigation...",
  "timestamp": "2024-01-15T14:23:45.123456Z"
}
```

**Error Responses:**

- **400 Bad Request:** Missing file
  ```json
  {"error": "No file uploaded. Send the FNOL document as field 'fnol'."}
  ```

- **415 Unsupported Media Type:** Invalid file type
  ```json
  {"error": "Unsupported file type. Allowed: .pdf, .txt, .text"}
  ```

- **500 Internal Server Error:** Processing failed
  ```json
  {"error": "An error occurred during claim processing: [details]"}
  ```

### `GET /health`

Health check endpoint.

**Response (200 OK):**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T14:23:45.123456Z"
}
```

### `GET /`

Serves the frontend dashboard (index.html).

---

## Project Structure

```
synapx_assignment/
│
├── app.py                          # Flask application entry point
├── requirements.txt                # Python dependencies
├── .env                           # Environment variables (git ignored)
├── .gitignore                     # Git ignore patterns
├── README.md                      # This file
├── explain.md                     # Detailed architecture explanation
│
├── frontend/                      # Web dashboard
│   ├── index.html                # Main HTML
│   ├── app.js                    # Frontend JavaScript
│   └── style.css                 # Styling
│
└── pipeline/                      # Processing stages
    ├── __init__.py
    ├── ingest.py                 # STAGE 0: Text extraction & preprocessing
    ├── extraction_agent.py        # STAGE 1: Gemini extraction agent
    ├── validation_agent.py        # STAGE 2: Validation logic
    ├── routing_agent.py           # STAGE 3: Routing decisions
    └── explanation.py             # STAGE 4: Decision explanation builder
```

### File Descriptions

| File | Purpose |
|------|---------|
| `app.py` | Flask server, file uploads, pipeline orchestration |
| `pipeline/ingest.py` | Text extraction, boilerplate stripping, page tagging |
| `pipeline/extraction_agent.py` | Gemini API call (structured output, 1x per document) |
| `pipeline/validation_agent.py` | Missing fields, confidence checks, consistency validation |
| `pipeline/routing_agent.py` | Escalation score calculation, routing decision logic |
| `pipeline/explanation.py` | Human-readable decision explanation builder |
| `frontend/index.html` | Web dashboard UI |
| `frontend/app.js` | Frontend logic, API integration |
| `frontend/style.css` | Styling and responsive layout |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| PyMuPDF import error | `pip install pymupdf` |
| GOOGLE_API_KEY not set | Create `.env` with your API key |
| Port 5000 already in use | Change port: `app.run(port=5001)` |
| CORS errors | CORS already enabled in `app.py` |
| File upload fails | Check max size: 20 MB limit in `app.config` |
| "ModuleNotFoundError: No module named 'flask'" | Run `pip install -r requirements.txt` in active venv |

---

## Development

### Adding New Validation Rules

Edit `pipeline/validation_agent.py`:

```python
def check_custom_rule(fields: dict[str, Any]) -> list[str]:
    issues = []
    # Your validation logic here
    return issues
```

### Adjusting Escalation Weights

Edit `pipeline/routing_agent.py`:

```python
SCORE_CUSTOM_FACTOR = 25  # Add new scoring constant
```

### Modifying Extraction Prompt

Edit the system prompt in `pipeline/extraction_agent.py` to change extraction behavior.

### Testing Locally

```bash
# Test the API with curl
curl -X POST -F "fnol=@sample_claim.pdf" http://localhost:5000/process-claim

# Check health
curl http://localhost:5000/health
```

---

## Performance Metrics

- **Extraction time:** ~2-3 seconds per document (Gemini API latency)
- **Validation/routing time:** <100ms (pure Python)
- **Explanation generation:** <50ms (string assembly)
- **Total per-document time:** ~2.5 seconds
- **API calls per document:** 1 (Gemini extraction only)
- **Estimated cost:** ~$0.0025-0.005 per document (Gemini 2.5 Flash pricing)

---

## Support

For detailed architecture explanation and design rationale, see [explain.md](explain.md).

**License:** ClaimSight AI — Assignment project for Synapx.
 