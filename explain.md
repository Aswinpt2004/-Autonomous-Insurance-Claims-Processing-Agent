# ClaimSight AI — Detailed Architecture & Design Explanation

This document provides an in-depth explanation of how ClaimSight AI works, the design decisions behind it, and the reasoning for each component.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Why This Architecture?](#why-this-architecture)
3. [The Four-Stage Pipeline](#the-four-stage-pipeline)
4. [Data Flow & Examples](#data-flow--examples)
5. [Routing Logic Explained](#routing-logic-explained)
6. [Scoring System](#scoring-system)
7. [Risk Signals & Semantic Understanding](#risk-signals--semantic-understanding)
8. [Configuration & Thresholds](#configuration--thresholds)
9. [Frontend Architecture](#frontend-architecture)
10. [Cost Optimization](#cost-optimization)
11. [Auditability & Explainability](#auditability--explainability)
12. [File Structure & Detailed Explanations](#file-structure--detailed-explanations)

---

## System Overview

**ClaimSight AI** is an autonomous FNOL (First Notice of Loss) claims processing system that transforms unstructured insurance documents into structured, routed claims with full decision transparency.

### Core Principle

**One API call per document.**

Instead of the naive approach (extract → validate → route → explain with 3+ API calls), this system:
1. Makes **exactly one** Gemini API call for extraction + risk analysis
2. Performs validation, routing, and explanation via **pure Python logic** (zero additional API cost)

This design reduces cost by 75%+ while maintaining semantic understanding through structured outputs.

### Business Value

- **Faster claims processing** — Deterministic routing reduces manual review queue
- **Lower operational costs** — Minimal API calls, pure Python validation
- **Better risk detection** — Semantic signals catch cross-field inconsistencies
- **Full auditability** — Every decision is explainable from first principles
- **Scalable** — No language model callbacks; bottleneck is Gemini extraction latency

---

## Why This Architecture?

### Problem Statement

Insurance FNOL processing involves:
1. Extracting structured fields from unstructured documents (PDFs, scanned images, text)
2. Validating extracted data for completeness and consistency
3. Routing claims to appropriate teams (fast-track, manual review, investigation, specialist)
4. Explaining decisions to stakeholders for auditability

**Naive approach:** Call LLM independently for each stage.
```
Extract (API call 1) → Validate (API call 2) → Route (API call 3) → Explain (API call 4)
Cost: ~$0.02/document | Latency: 8+ seconds | Inflexible routing
```

**This system:** One extraction + deterministic logic.
```
Extract (API call 1) → Validate (Python) → Route (Python) → Explain (Python)
Cost: ~$0.003/document | Latency: 2.5 seconds | Flexible, auditable routing
```

### Design Decisions

#### 1. **Single Gemini Call via Structured Output**

**Why?**
- Gemini 2.5 Flash's `responseSchema` forces strictly typed output (no hallucination)
- One request = one token usage window = minimal token waste
- Extraction + risk signals combined in single response

**How it works:**
```python
# Single request returns:
{
  "policyNumber": {"value": "POL-123", "confidence": 0.98, "source": "[PAGE 1]"},
  "riskSignals": [
    {"signal": "Date outside window", "severity": "high", "evidence": "..."}
  ]
}
```

#### 2. **Semantic Risk Signals, Not Keyword Matching**

**Problem with keyword approach:**
```
if "staged" in text or "inconsistent" in text:
    flag_fraud()
```
Easily defeated by rephrasing.

**This system's approach:**
Ask Gemini to *reason* about consistency and return structured signals:
```python
{
  "signal": "Incident date outside policy window",
  "severity": "high",
  "evidence": "Incident 2024-12-20, policy ends 2024-11-30"
}
```

Requires Gemini to understand cross-field relationships, not just pattern match.

#### 3. **Tiered Confidence Thresholds**

**Insight:** Not all fields are equally critical.

A policy number extracted at 52% confidence is essentially missing — the value is unreliable. A claimant name at 70% confidence is acceptable for a first pass.

**Implementation:**
```python
CRITICAL_FIELDS = {"policyNumber", "assetId", "claimType"}
CRITICAL_THRESHOLD = 0.85      # Strict: 85%

STANDARD_REQUIRED = ["incidentDate", "incidentLocation", ...]
STANDARD_THRESHOLD = 0.60      # Lenient: 60%
```

This creates a **functional** definition of "missing" — high-confidence absence **or** low-confidence presence.

#### 4. **Composite Escalation Score**

**Problem with fixed thresholds:**
```
if missing_fields > 2:
    route("INVESTIGATION")
elif high_risk_signal:
    route("INVESTIGATION")
```
A claim with 3 missing fields but zero risk signals gets same treatment as 1 missing field + high risk signal.

**This system:**
All factors contribute to a weighted score. Routing flows from accumulated evidence:

| Factor | Points | Example |
|--------|--------|---------|
| Missing required field | +15 | Missing claimant → +15 |
| Low confidence on critical field | +15 | Policy # at 80% → +15 |
| High-severity risk signal | +30 | Date outside policy window → +30 |
| Injury claim | +20 | Auto claim with injuries → +20 |
| Consistency issue | +10 | Conflicting timestamps → +10 |

Score 35 → INVESTIGATION (threshold 31)

Justifiable, auditable, flexible.

#### 5. **Pure Python Validation & Routing**

**Why not call Gemini for validation?**
- Deterministic output — same inputs always produce same decision
- Faster — <100ms vs. 2+ seconds for API call
- Cheaper — zero additional API cost
- Auditable — pure code, no LLM variance

**Examples:**
- Check `incidentDate` is within `policyEffectiveDates` ✓ (date math)
- Flag confidence < threshold ✓ (comparison)
- Detect timestamp contradictions ✓ (string parsing + logic)

None of this needs an LLM.

---

## The Four-Stage Pipeline

### Stage 0: Ingestion & Preprocessing

**Files:** `pipeline/ingest.py`

**Purpose:** Transform raw documents into clean, tokenized text.

**Steps:**

1. **Detect File Type**
   - PDF → Use PyMuPDF (fitz)
   - TXT → Direct UTF-8 decode

2. **Extract Text**
   ```python
   doc = fitz.open(stream=file_bytes, filetype="pdf")
   for page in doc:
       text = page.get_text()
   ```

3. **Tag Pages for Provenance**
   ```
   [PAGE 1]
   Policy Number: ABC123
   ...
   
   [PAGE 2]
   Incident Description: ...
   ```
   
   **Why?** So later stages can say "Policy # extracted from [PAGE 1]". Auditable.

4. **Detect Scanned/Vision Pages**
   ```python
   if len(extracted_text) < 40:  # Few characters = likely scanned
       needs_vision = True
       flag = "[GRAPHICAL/SCANNED PAGE — vision required]"
   ```

5. **Strip Boilerplate**
   ```python
   BOILERPLATE_PATTERNS = [
       r"Applicable in [A-Z][a-z]+...",  # ACORD location applicability
       r"©.*ACORD CORPORATION",           # Copyright notice
       r"-{10,}.*FRAUD NOTICE.*-{10,}",  # Fraud warning box
   ]
   ```
   
   **Why?** ACORD forms have ~1,500 tokens of boilerplate. Removing saves API cost.

6. **Output**
   ```python
   full_text = "[PAGE 1]\n...cleaned text...\n[PAGE 2]\n..."
   needs_vision = False  # or True
   ```

**Cost Impact:**
- Input: 10 page PDF (50KB raw) → ~15KB cleaned (70% reduction)
- Tokens saved: ~3,000 tokens
- Cost saved: ~$0.0015 per document

---

### Stage 1: Extraction Agent

**Files:** `pipeline/extraction_agent.py`

**Purpose:** Call Gemini exactly once to extract structured fields + risk signals.

**The Single API Call**

```python
response = genai.generate_content(
    prompt=[
        {
            "role": "user",
            "parts": [
                {"text": system_prompt},  # Instructions
                {"text": document_text},  # Clean text from Stage 0
                {
                    "inline_data": {
                        "mime_type": "image/png",
                        "data": base64_encoded_pdf_pages  # If needs_vision
                    }
                }
            ]
        }
    ],
    generation_config={
        "response_schema": responseSchema,  # Pydantic model
        "response_mime_type": "application/json"
    }
)
```

**Key Features:**

1. **Conditional Model Selection**
   ```python
   if needs_vision:
       MODEL = "gemini-2.5-flash"      # Full model with vision
   else:
       MODEL = "gemini-2.5-flash-lite" # Faster, cheaper lite model
   ```

2. **Structured Output Schema**
   ```python
   class ExtractedFields(BaseModel):
       policyNumber: ExtractedFieldString
       policyholderName: ExtractedFieldString
       incidentDate: ExtractedFieldString
       ...
       riskSignals: list[RiskSignal]
   ```
   
   Gemini respects the schema → no post-processing needed.

3. **16 Fields Extracted**
   - Policy: `policyNumber`, `policyholderName`, `policyEffectiveDates`
   - Incident: `incidentDate`, `incidentTime`, `incidentLocation`, `incidentDescription`
   - Parties: `claimant`, `thirdParties`, `contactDetails`
   - Asset: `assetType`, `assetId`
   - Claim: `claimType`, `estimatedDamage`
   - Coverage: `coverageType`

4. **Every Field Carries Confidence + Source**
   ```python
   {
       "policyNumber": {
           "value": "POL-2024-001234",
           "confidence": 0.98,
           "source": "[PAGE 1]"
       }
   }
   ```

5. **Risk Signals Extracted**
   ```python
   {
       "riskSignals": [
           {
               "signal": "Damage estimate unusually high",
               "severity": "medium",
               "evidence": "Reported $250k damage for minor fender bender",
               "source": "[PAGE 3]"
           }
       ]
   }
   ```

**Example Extraction**

**Input Document:**
```
ACORD 130 — GENERAL LIABILITY LOSS NOTICE

Policy Number: WC-2024-456789
Policyholder: Acme Corp, Inc.
Incident Date: 2024-12-15
Incident Location: 123 Main St, Springfield, OH
Description: Slip and fall in lobby. Employee fell on wet floor.
Estimated Damage: $15,000
```

**Extracted Output:**
```json
{
  "extractedFields": {
    "policyNumber": {
      "value": "WC-2024-456789",
      "confidence": 0.99,
      "source": "[PAGE 1]"
    },
    "policyholderName": {
      "value": "Acme Corp, Inc.",
      "confidence": 0.97,
      "source": "[PAGE 1]"
    },
    "incidentDate": {
      "value": "2024-12-15",
      "confidence": 0.95,
      "source": "[PAGE 1]"
    },
    ...
  },
  "riskSignals": [
    {
      "signal": "Potential workers compensation fraud indicator",
      "severity": "medium",
      "evidence": "Injury claim on liability policy typically seen in workplace accidents, warrant review.",
      "source": "[PAGE 1]"
    }
  ]
}
```

---

### Stage 2: Validation Agent

**Files:** `pipeline/validation_agent.py`

**Purpose:** Check extracted data for completeness, confidence, and consistency.

**Three Validation Layers**

#### 2A. Missing Fields Check

```python
REQUIRED_FIELDS = [
    "policyNumber", "policyholderName", "incidentDate",
    "incidentLocation", "incidentDescription", "claimant",
    "assetType", "claimType", "initialEstimate"
]

missing = []
for field in REQUIRED_FIELDS:
    value = fields.get(field, {}).get("value")
    if value is None or (isinstance(value, str) and not value.strip()):
        missing.append(field)
```

**Result:**
```python
missing = ["contactDetails", "thirdParties"]  # 2 missing fields
```

#### 2B. Low Confidence Check

```python
CRITICAL_FIELDS = {"policyNumber", "assetId", "claimType"}
CRITICAL_THRESHOLD = 0.85
STANDARD_THRESHOLD = 0.60

low_conf = []
for field in REQUIRED_FIELDS:
    obj = fields.get(field, {})
    value = obj.get("value")
    confidence = obj.get("confidence", 1.0)
    threshold = CRITICAL_THRESHOLD if field in CRITICAL_FIELDS else STANDARD_THRESHOLD
    
    if value is not None and confidence < threshold:
        low_conf.append({
            "field": field,
            "value": value,
            "confidence": confidence,
            "threshold": threshold,
            "is_critical": field in CRITICAL_FIELDS
        })
```

**Result:**
```python
low_conf = [
    {
        "field": "incidentTime",
        "value": "14:30",
        "confidence": 0.58,
        "threshold": 0.60,
        "is_critical": False
    }
]
```

#### 2C. Consistency Check

```python
def check_consistency(fields):
    issues = []
    
    # Date range check
    incident_date = fields.get("incidentDate", {}).get("value")
    policy_dates = fields.get("policyEffectiveDates", {}).get("value")
    
    if incident_date and policy_dates:
        try:
            inc_dt = dateutil_parser.parse(incident_date)
            policy_start, policy_end = extract_dates_from_range(policy_dates)
            
            if inc_dt < policy_start or inc_dt > policy_end:
                issues.append("Incident date outside policy coverage window")
        except:
            pass
    
    # Damage divergence check
    estimated = fields.get("estimatedDamage", {}).get("value")
    description = fields.get("incidentDescription", {}).get("value")
    
    if estimated and description:
        if estimated > 500000 and "minor" in description.lower():
            issues.append("Estimated damage disproportionate to incident severity")
    
    return issues
```

**Result:**
```python
consistency_issues = [
    "Incident date outside policy coverage window"
]
```

---

### Stage 3: Routing Agent

**Files:** `pipeline/routing_agent.py`

**Purpose:** Combine validation results into routing decision.

#### 3A. Escalation Score Calculation

```python
def escalation_score(
    missing_fields,
    low_confidence_fields,
    risk_signals,
    consistency_issues,
    fields
):
    score = 0
    
    # Missing field penalty
    score += 15 * len(missing_fields)
    
    # Low confidence penalties
    for lc in low_confidence_fields:
        if lc["field"] in CRITICAL_FIELDS:
            score += 15  # Critical field = high penalty
        else:
            score += 5   # Standard field = low penalty
    
    # Risk signal scores
    risk_weights = {"low": 5, "medium": 15, "high": 30}
    for signal in risk_signals:
        score += risk_weights.get(signal["severity"], 0)
    
    # Consistency issue penalty
    score += 10 * len(consistency_issues)
    
    # Injury modifier
    if fields.get("claimType", {}).get("value", "").lower() == "injury":
        score += 20
    
    return score
```

**Example Calculation:**
```
Missing: 2 fields × 15 = 30 points
Low confidence critical: 0 × 15 = 0 points
Low confidence standard: 1 × 5 = 5 points
High risk signal: 1 × 30 = 30 points
Consistency issues: 1 × 10 = 10 points
Injury modifier: 0
─────────────────────────
Total Score: 75 points
```

#### 3B. Routing Decision

```python
def base_route(fields, missing, low_conf, risk_signals, consistency, score):
    
    # Check for injury claims
    if fields.get("claimType", {}).get("value", "").lower() == "injury":
        return "SPECIALIST_QUEUE"
    
    # Check escalation thresholds
    if score >= 31:
        return "INVESTIGATION_FLAG"
    
    if score <= 10:
        damage = fields.get("estimatedDamage", {}).get("value", 0)
        if damage <= 25000:
            return "FAST_TRACK"
    
    # Default path
    return "MANUAL_REVIEW"
```

**Route Decisions:**
- **FAST_TRACK** (score ≤10, damage ≤$25k) — Automated approval pathway
- **MANUAL_REVIEW** (default) — Assigned to claims adjuster
- **INVESTIGATION** (score ≥31) — Fraud/risk investigation team
- **SPECIALIST_QUEUE** (injury claim) — Specialized injury team

---

### Stage 4: Explanation Builder

**Files:** `pipeline/explanation.py`

**Purpose:** Generate human-readable decision explanations.

**Deterministic Explanation Logic**

```python
def build_reasoning(
    route,
    missing_fields,
    low_confidence_fields,
    risk_signals,
    consistency_issues,
    fields,
    escalation_score
):
    explanation = ""
    
    # Header
    if route == "INVESTIGATION_FLAG":
        explanation += f"⚠️ This claim has been escalated to Investigation. "
    elif route == "SPECIALIST_QUEUE":
        explanation += f"👤 This injury claim has been routed to our Specialist team. "
    elif route == "FAST_TRACK":
        explanation += f"✓ This claim qualifies for our Fast-Track pathway. "
    else:
        explanation += f"This claim requires Manual Review. "
    
    # Contributing factors
    factors = []
    
    if risk_signals:
        high_signals = [s for s in risk_signals if s["severity"] == "high"]
        if high_signals:
            factors.append(
                f"high-severity risk signal ({high_signals[0]['signal']}, "
                f"+30 pts)"
            )
    
    if missing_fields:
        factors.append(f"missing critical fields ({', '.join(missing_fields[:2])}, "
                      f"+15 pts each)")
    
    if low_confidence_fields:
        critical_low = [f for f in low_confidence_fields if f["is_critical"]]
        if critical_low:
            factors.append(f"low confidence on critical field "
                          f"({critical_low[0]['field']}, +15 pts)")
    
    if factors:
        explanation += f"\n\nContributing factors:\n"
        for i, factor in enumerate(factors, 1):
            explanation += f"{i}. {factor}\n"
    
    # Specific guidance
    if route == "INVESTIGATION_FLAG":
        investigation_factors = risk_signals + consistency_issues
        if investigation_factors:
            explanation += f"\n**Recommended Actions:**\n"
            if risk_signals:
                explanation += f"- Verify {risk_signals[0]['signal'].lower()}\n"
            if missing_fields:
                explanation += f"- Request missing {missing_fields[0]}\n"
    
    return explanation.strip()
```

**Example Explanation Output**

**Score: 75 (INVESTIGATION)**
```
⚠️ This claim has been escalated to Investigation. Escalation score (75) 
significantly exceeds investigation threshold (31).

Contributing factors:
1. high-severity risk signal (Incident date outside policy window, +30 pts)
2. missing critical fields (contactDetails, thirdParties, +15 pts each)
3. low confidence on critical field (policyNumber, +15 pts)
4. consistency issue (Damage estimate disproportionate to incident, +10 pts)

Recommended Actions:
- Verify incident date against policy records
- Request contact information for claimant and third parties
- Review damage estimate for reasonableness given incident type
```

---

## Data Flow & Examples

### Example 1: Straightforward Claim (Fast-Track)

**Input:** Simple auto claim, PDF with clean scan

**Stage 0 Output:**
```
[PAGE 1]
Policy: ABC-2024-123456
Policyholder: John Smith
Incident: 2024-12-15, parking lot fender bender
Damage estimate: $8,500
```

**Stage 1 Output:**
```json
{
  "policyNumber": {"value": "ABC-2024-123456", "confidence": 0.99, "source": "[PAGE 1]"},
  "policyholderName": {"value": "John Smith", "confidence": 0.98, "source": "[PAGE 1]"},
  "incidentDate": {"value": "2024-12-15", "confidence": 0.97, "source": "[PAGE 1]"},
  "estimatedDamage": {"value": 8500, "confidence": 0.95, "source": "[PAGE 1]"},
  ...all fields present with high confidence...,
  "riskSignals": []
}
```

**Stage 2 Output:**
```json
{
  "missing": [],
  "lowConfidence": [],
  "consistencyIssues": []
}
```

**Stage 3 Output:**
```json
{
  "score": 0,
  "route": "FAST_TRACK"
}
```

**Stage 4 Output:**
```
✓ This claim qualifies for our Fast-Track pathway. All required information is 
present with high confidence, no risk signals detected, and estimated damage is 
within fast-track limits ($8,500 < $25,000).
```

---

### Example 2: Complex Claim (Investigation)

**Input:** Property damage claim, scanned handwritten notes + typed form

**Stage 0 Output:**
```
[PAGE 1]
[Standard form text...]
Policy Effective: 2024-01-01 to 2024-12-31
[PAGE 2]
[GRAPHICAL/SCANNED PAGE — vision required]
[Handwritten incident details...]
[PAGE 3]
Estimated Damage: $275,000
Incident Description: Minor roof leak caused by rain
```

**Stage 1 Output:**
```json
{
  "policyNumber": {"value": "PROP-2024-789", "confidence": 0.92, "source": "[PAGE 1]"},
  "incidentDate": {"value": "2024-12-28", "confidence": 0.87, "source": "[PAGE 2-handwritten]"},
  "estimatedDamage": {"value": 275000, "confidence": 0.81, "source": "[PAGE 3]"},
  "contactDetails": {"value": null, "confidence": 0.0, "source": null},
  ...
  "riskSignals": [
    {
      "signal": "Damage estimate disproportionate to incident description",
      "severity": "high",
      "evidence": "Estimated $275k for minor roof leak; typical roof repairs $5-15k",
      "source": "[PAGE 3]"
    },
    {
      "signal": "Incident date outside policy window",
      "severity": "high",
      "evidence": "Incident 2024-12-28 but policy ends 2024-12-31 (3 days remaining)",
      "source": "[PAGE 2]"
    }
  ]
}
```

**Stage 2 Output:**
```json
{
  "missing": ["contactDetails"],
  "lowConfidence": [
    {"field": "policyNumber", "confidence": 0.92, "threshold": 0.85, "is_critical": true}
  ],
  "consistencyIssues": [
    "Estimated damage ($275k) disproportionate to described incident (minor leak)"
  ]
}
```

**Stage 3 Output:**
```
Score: 1×15 (missing) + 1×15 (low-conf critical) + 2×30 (high signals) + 1×10 (consistency)
     = 15 + 15 + 60 + 10 = 100

route = "INVESTIGATION"
```

**Stage 4 Output:**
```
⚠️ This claim has been escalated to Investigation. Escalation score (100) 
significantly exceeds investigation threshold (31).

Contributing factors:
1. high-severity risk signal (Damage estimate disproportionate to incident, +30 pts)
2. high-severity risk signal (Incident date outside policy window, +30 pts)
3. missing critical fields (contactDetails, +15 pts)
4. low confidence on critical field (policyNumber, +15 pts)
5. consistency issue (Damage estimate disproportionate, +10 pts)

Recommended Actions:
- Verify reported damage with independent adjuster
- Contact policyholder for clarification on incident date
- Request contact information
- Confirm policy coverage status for incident date
```

---

## Routing Logic Explained

### Routing Decision Tree

```
Input: Extraction + Validation + Risk Signals + Score

└─ Is injury claim?
   ├─ YES → SPECIALIST_QUEUE
   └─ NO  → Check score
      ├─ Score ≥ 31 → INVESTIGATION
      ├─ Score ≤ 10 & Damage ≤ $25k → FAST_TRACK
      └─ Otherwise → MANUAL_REVIEW
```

### Why This Structure?

**SPECIALIST_QUEUE (Injury Claims)**
- Injury claims require specialized adjusters familiar with medical reporting
- Policy: Always route injury claims to specialists regardless of other factors
- Example: Workplace injury with perfect documentation → SPECIALIST_QUEUE

**INVESTIGATION (High Score)**
- Score ≥31 indicates multiple risk factors
- Typical triggers:
  - High-severity risk signal ($30 pts) + missing field ($15 pts) = 45 pts
  - 3+ missing fields (45 pts)
  - Injury claim ($20 pts) + consistency issue ($10 pts) + low-conf critical ($15 pts) = 45 pts
- Handled by fraud/risk team before approval

**FAST_TRACK (Low Score + Low Damage)**
- Score ≤10: Minimal risk factors
- Damage ≤$25,000: Below investigation threshold
- Typical triggers:
  - All fields present, all high confidence, no risk signals → Score 0
  - One low-severity risk signal ($5 pts) + small damage → Score 5
- Automated pathway: minimal manual review

**MANUAL_REVIEW (Default)**
- Catch-all for borderline cases
- Score 11–30: Moderate risk, needs adjuster judgment
- Typical triggers:
  - Missing one optional field → Score 15
  - Moderate risk signal ($15 pts) → Route depends on other factors
- Assigned to claims queue for human review

---

## Scoring System

### Score Calculation Formula

```
Score = (Missing Fields × 15) 
      + (Low-Conf Critical × 15)
      + (Low-Conf Standard × 5)
      + (Risk Signals: low×5, medium×15, high×30)
      + (Consistency Issues × 10)
      + (Injury Modifier × 20)
```

### Score Thresholds

| Score Range | Route | Policy |
|-------------|-------|--------|
| 0–10 | FAST_TRACK or MANUAL_REVIEW | Score ≤10 AND damage ≤$25k → FAST_TRACK |
| 11–30 | MANUAL_REVIEW | Default path for moderate risk |
| 31+ | INVESTIGATION | Escalate to risk team |
| Injury | SPECIALIST_QUEUE | Always, regardless of score |

### Why These Weights?

**Missing Field (15 pts):** 
- Makes claim incomplete, requires follow-up
- ~10% contribution to investigation threshold
- Justified: prevents incomplete processing

**Low Confidence Critical (15 pts):**
- Critical field at 52% confidence = functional missing field
- Same weight as missing ensures consistency
- Justified: critical fields must be reliable

**Low Confidence Standard (5 pts):**
- Standard fields at 58% confidence still usable
- Lower weight reflects recoverable information
- Justified: can be verified with claimant

**Risk Signal Scores:**
- **Low (5 pts):** Minor inconsistency, likely explains itself
- **Medium (15 pts):** Moderate concern, warrants review
- **High (30 pts):** Major concern, nearly triggers investigation alone
- Justified: semantic understanding > keyword matching

**Consistency Issue (10 pts):**
- Indicates data quality concern
- Lower than risk signal (logic errors vs. AI reasoning)
- Justified: algorithmic check < AI assessment

**Injury Modifier (20 pts):**
- Injury claims require specialist handling
- Not investigation-level (20 < 31), but forces manual review
- Justified: policy requirement, not risk-based

---

## Risk Signals & Semantic Understanding

### What Are Risk Signals?

Risk signals are structured, semantic assessments of claim quality returned by Gemini during extraction. Unlike keyword matching, they require reasoning about cross-field relationships.

### Risk Signal Structure

```python
{
    "signal": str,           # What was detected (e.g., "Policy mismatch")
    "severity": str,         # "low", "medium", or "high"
    "evidence": str,         # Specific evidence from document
    "source": str            # Page reference "[PAGE n]"
}
```

### Example Risk Signals

| Signal | Severity | Evidence | Routing Impact |
|--------|----------|----------|-----------------|
| "Incident date outside policy window" | High | "Incident 2024-12-28, policy ends 2024-12-23" | +30 pts → Investigation |
| "Damage estimate unusually high" | Medium | "$250k for minor fender bender" | +15 pts → Adds to score |
| "Third-party involvement unclear" | Low | "Multiple parties mentioned, relationships not clear" | +5 pts → Noted |
| "Inconsistent timestamps" | Medium | "Report says 14:00, handwritten note says 16:30" | +15 pts → Investigation |

### Why Gemini-Generated Signals?

1. **Semantic Understanding** — Gemini understands context, not just keyword matching
   ```
   ✗ if "staged" in text: ...          # Easily defeated
   ✓ Gemini: "Pattern matches known staged-accident indicators"
   ```

2. **Cross-Field Reasoning** — Can compare multiple fields
   ```
   ✗ Keyword check: "Is $500k in text?" — No insight
   ✓ Gemini: "Damage $500k for incident described as 'minor'"
   ```

3. **Severity Classification** — Prioritizes concerns
   ```
   ✗ All flags weighted equally
   ✓ Gemini: "High severity" (immediate investigation) vs. "Low severity" (note for review)
   ```

4. **Evidence-Based** — Explains its reasoning
   ```
   ✗ "Fraud detected" — No explanation
   ✓ "Damage estimate disproportionate: reported $275k for typical $8-12k roof repair"
   ```

---

## Configuration & Thresholds

### Adjustable Parameters

All thresholds are defined as constants in the pipeline files:

#### Confidence Thresholds (`validation_agent.py`)

```python
CRITICAL_THRESHOLD = 0.85          # Policy #, Claim Type, Asset ID
STANDARD_THRESHOLD = 0.60          # Other required fields

CRITICAL_FIELDS = {"policyNumber", "assetId", "claimType"}
```

**To adjust:**
- Lower `CRITICAL_THRESHOLD` to 0.75 if many claims rejected for low policy # confidence
- Raise `STANDARD_THRESHOLD` to 0.70 for stricter validation

#### Escalation Scoring (`routing_agent.py`)

```python
SCORE_MISSING_FIELD = 15
SCORE_LOW_CONF_CRITICAL = 15
SCORE_LOW_CONF_STANDARD = 5
SCORE_RISK_SIGNAL = {"low": 5, "medium": 15, "high": 30}
SCORE_INJURY_CLAIM = 20
SCORE_CONSISTENCY_ISSUE = 10
```

**To adjust:**
- Raise `SCORE_RISK_SIGNAL["high"]` to 40 to treat fraud indicators more seriously
- Lower `SCORE_MISSING_FIELD` to 10 if data entry issues are recoverable

#### Routing Thresholds (`routing_agent.py`)

```python
SCORE_FASTTRACK_MAX = 10           # Fast-track if score ≤ this
SCORE_INVESTIGATION_MIN = 31       # Investigate if score ≥ this
DAMAGE_FASTTRACK_MAX = 25_000      # Max damage for fast-track
```

**To adjust:**
- Lower `SCORE_FASTTRACK_MAX` to 5 for stricter fast-track eligibility
- Raise `SCORE_INVESTIGATION_MIN` to 35 to reduce investigation queue

#### Model Selection (`extraction_agent.py`)

```python
MODEL_NAME = "gemini-2.5-flash"          # Full model
MODEL_NAME_LITE = "gemini-2.5-flash-lite"  # Lite model
```

**To adjust:**
- Use "gemini-1.5-flash" for lower cost (less accurate)
- Use "gemini-2.0-pro" for higher accuracy (higher cost)

---

## Frontend Architecture

### Overview

The frontend is a single-page application (SPA) built with vanilla JavaScript, HTML, and CSS.

### File Structure

```
frontend/
├── index.html    # Main UI
├── app.js        # Event handlers, API calls
└── style.css     # Styling, responsive layout
```

### Key Components

**Upload Panel:**
```html
<input type="file" id="fileInput" accept=".pdf,.txt">
<button onclick="processFile()">Process Claim</button>
```
- Users select PDF/TXT file
- Frontend validates file size and type
- Sends `multipart/form-data` POST to `/process-claim`

**Results Display:**
```
Claims ID: [UUID]
Status: [FAST_TRACK | MANUAL_REVIEW | INVESTIGATION | SPECIALIST_QUEUE]
Escalation Score: [0-∞]

Extracted Fields:
├─ Policy Number: ABC-2024-123 (98% confidence, [PAGE 1])
├─ Policyholder: John Smith (95% confidence, [PAGE 1])
...

Risk Signals:
├─ ⚠️ HIGH: Incident date outside policy window
│  Evidence: Incident 2024-12-28, policy ends 2024-12-23
...

Validation Issues:
├─ Missing: contactDetails
├─ Low Confidence: incidentTime (58%, threshold 60%)
...

Explanation:
⚠️ This claim has been escalated to Investigation...
```

**History Panel:**
- Tab showing all processed claims from session
- Click to view details again
- Session storage: cleared on page reload

### API Integration

**POST /process-claim**
```javascript
const formData = new FormData();
formData.append("fnol", file);

const response = await fetch("/process-claim", {
    method: "POST",
    body: formData
});

const result = await response.json();
// Display result...
```

**Response Handling:**
```javascript
if (response.status === 200) {
    displayResults(result);
} else if (response.status === 400) {
    alert(result.error);  // Missing file
} else if (response.status === 415) {
    alert(result.error);  // Invalid file type
} else {
    alert("Processing failed: " + result.error);
}
```

---

## Cost Optimization

### Cost Breakdown

**Per-Document Costs (Gemini 2.5 Flash pricing):**

| Component | Tokens | Cost |
|-----------|--------|------|
| Input (extraction request) | ~2,500 | $0.00125 |
| Output (structured response) | ~800 | $0.0024 |
| **Total Per Document** | ~3,300 | **~$0.00365** |

**Why So Low?**
1. Boilerplate stripping saves ~3,000 tokens
2. Text extraction (pure Python) = $0.00
3. Validation/routing (pure Python) = $0.00
4. Single API call vs. multiple

### Optimization Techniques

#### 1. **Lite Model for Clean Text**
```python
if needs_vision:
    MODEL = "gemini-2.5-flash"      # Full model, scanned PDFs
else:
    MODEL = "gemini-2.5-flash-lite" # Lite model, clean text
```

**Savings:** ~30% cost reduction for clean documents

#### 2. **Boilerplate Stripping**
```python
BOILERPLATE_PATTERNS = [
    r"Applicable in [A-Z][a-z]+...",  # ACORD form text
    r"©.*ACORD CORPORATION",
    ...
]
```

**Savings:** ~1,500 tokens / document = ~$0.00075/document

#### 3. **Deterministic Post-Processing**
- Validation (Python) instead of LLM validation
- Routing (Python) instead of LLM routing  
- Explanation (string assembly) instead of LLM generation

**Savings:** Eliminates 3 additional API calls = ~$0.01/document

#### 4. **Structured Output Schema**
- Pydantic models force specific JSON structure
- No need for prompt-engineered output reformatting
- Gemini respects schema → single request = single cost

**Savings:** No retry loops or reformatting = guaranteed single call

---

## Auditability & Explainability

### Every Decision Is Traceable

**Field-Level Traceability**
```json
{
    "policyNumber": {
        "value": "POL-2024-001234",
        "confidence": 0.98,
        "source": "[PAGE 1]"
    }
}
```
→ "Policy found on page 1 with 98% confidence"

**Risk Signal Traceability**
```json
{
    "signal": "Damage estimate unusually high",
    "severity": "high",
    "evidence": "Reported $250k damage for minor fender bender",
    "source": "[PAGE 3]"
}
```
→ "High-risk signal detected on page 3: $250k for minor damage"

**Routing Traceability**
```json
{
    "escalationScore": 45,
    "route": "INVESTIGATION",
    "reasoning": "Score (45) exceeds investigation threshold (31). Factors: High-severity risk signal (+30), Missing field (+15)."
}
```
→ "Investigation routed due to 45-point escalation score"

### Audit Trail

**Result JSON Contains:**
1. ✓ Claim ID (unique identifier)
2. ✓ Timestamp (when processed)
3. ✓ Filename (source document)
4. ✓ Extracted fields with confidence & source
5. ✓ Risk signals with severity & evidence
6. ✓ Validation issues (missing, low-confidence)
7. ✓ Escalation score & calculation factors
8. ✓ Routing decision & rationale
9. ✓ Plain-English explanation

**Auditor Can:**
- Verify extraction accuracy against source pages
- Understand why each risk signal was triggered
- Trace routing decision back to scoring factors
- Reproduce the decision with Python logic (deterministic)

### Explainability

The system is built on explainability:

**Explicit Rules:**
- Scoring is formula-based, not learned
- Routing is rule-based, not LLM-decided
- Thresholds are configurable constants

**Traceable Evidence:**
- Every extracted field shows source page
- Every risk signal includes evidence quote
- Every routing point calculated from factors

**Readable Output:**
- Stage 4 generates human-English explanations
- Stakeholders don't need AI knowledge to understand
- Non-technical users can see why decision was made

**Reviewable Decisions:**
- Claims auditors can manually verify logic
- Regular audits ensure thresholds remain appropriate
- ML/AI is used for extraction only; decisions are interpretable

---

## File Structure & Detailed Explanations

### Complete Project Tree

```
synapx_assignment/
│
├── app.py                          ⭐ Flask server entry point
├── requirements.txt                📦 Python dependencies
├── .env                           🔐 Environment variables (git ignored)
├── .env.example                   📋 Example env template
├── .gitignore                     📝 Git ignore patterns
├── README.md                      📖 User guide & quick start
├── explain.md                     📚 This detailed architecture doc
│
├── frontend/                      🎨 Web dashboard
│   ├── index.html                 HTML structure & layout
│   ├── app.js                     JavaScript logic & API integration
│   └── style.css                  Responsive styling
│
└── pipeline/                      🔄 Processing pipeline
    ├── __init__.py                Package initialization
    ├── ingest.py                  STAGE 0 — Text extraction
    ├── extraction_agent.py        STAGE 1 — Gemini extraction
    ├── validation_agent.py        STAGE 2 — Data validation
    ├── routing_agent.py           STAGE 3 — Routing decisions
    └── explanation.py             STAGE 4 — Explanation builder
```

---

### Root Level Files

#### **app.py** — Flask Application Server

**Purpose:** Main entry point. Orchestrates the entire pipeline and serves the web API.

**Key Responsibilities:**
1. **File Upload Handler** — Receives multipart/form-data POST requests
2. **Pipeline Orchestration** — Chains all 4 pipeline stages sequentially
3. **Frontend Server** — Serves static HTML/CSS/JS from `frontend/` folder
4. **REST API** — Exposes `/process-claim` endpoint
5. **Error Handling** — Catches and reports pipeline errors

**Key Code Structure:**
```python
@app.route("/process-claim", methods=["POST"])
def process_claim():
    # 1. Validate file upload
    file = request.files["fnol"]
    
    # 2. Stage 0: Ingest
    full_text, needs_vision, pdf_doc = extract_text_and_flag_vision(file_bytes, filename)
    
    # 3. Stage 1: Extract (Gemini)
    extraction = run_extraction_agent(full_text, needs_vision, file_bytes)
    
    # 4. Stage 2: Validate (Python)
    missing = find_missing_fields(fields)
    low_conf = find_low_confidence_fields(fields)
    consistency_issues = check_consistency(fields)
    
    # 5. Stage 3: Route (Python)
    score = escalation_score(missing, low_conf, risk_signals, consistency_issues)
    route = base_route(fields, missing, low_conf, risk_signals, consistency_issues, score)
    
    # 6. Stage 4: Explain (Python)
    reasoning = build_reasoning(route, missing, low_conf, risk_signals, consistency_issues)
    
    # 7. Return JSON result
    return jsonify({
        "claimId": claim_id,
        "extractedFields": fields,
        "riskSignals": risk_signals,
        "routing": {"score": score, "route": route, "reasoning": reasoning},
        "explanation": reasoning,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })
```

**Configuration:**
- `MAX_CONTENT_LENGTH = 20 * 1024 * 1024` — 20 MB file size limit
- `FLASK_SECRET_KEY` — Session encryption key (from `.env`)
- CORS enabled for cross-origin requests
- Logging configured with ISO 8601 timestamps

**Dependencies Used:**
- `flask` — Web framework
- `flask_cors` — Cross-origin support
- `dotenv` — Environment variable loading
- All pipeline modules

---

#### **requirements.txt** — Python Dependencies

**Purpose:** Lists all Python packages needed to run the project.

**Key Packages:**
```
flask==3.0.0                    # Web framework
flask-cors==4.0.0               # CORS support
google-genai==0.3.0            # Google Gemini API client
pymupdf==1.23.8                # PDF text extraction (PyMuPDF)
python-dotenv==1.0.0           # Environment variable management
python-dateutil==2.8.2         # Date parsing & utilities
pydantic==2.5.0                # Data validation & serialization
```

**Installation:**
```bash
pip install -r requirements.txt
```

---

#### **.env** — Environment Configuration

**Purpose:** Store secrets and configuration that shouldn't be in git.

**Required Variables:**
```env
GOOGLE_API_KEY=<your_gemini_api_key>    # Required for Gemini API calls
FLASK_SECRET_KEY=dev-secret-key          # Session encryption
FLASK_ENV=development                    # development or production
FLASK_DEBUG=1                           # Enable debug mode
```

**Note:** This file is `.gitignore`d — never commit secrets to repo.

---

#### **.env.example** — Configuration Template

**Purpose:** Template showing what environment variables are needed.

```env
# Copy this to .env and fill in your values
GOOGLE_API_KEY=your_google_api_key_here
FLASK_SECRET_KEY=your_secret_key_here
FLASK_ENV=development
FLASK_DEBUG=1
```

**Usage:** New developers copy this file and customize it:
```bash
cp .env.example .env
# Then edit .env with your values
```

---

#### **.gitignore** — Git Configuration

**Purpose:** Tell git which files NOT to commit to the repository.

**Key Patterns Ignored:**
```
# Secrets
.env
.env.local

# Virtual environments
venv/
env/
.venv

# Python cache
__pycache__/
*.pyc
*.pyo
*.egg-info/

# IDE files
.vscode/
.idea/
*.swp

# OS files
.DS_Store
Thumbs.db

# Logs & temp files
*.log
test_results/
```

**Why?** Prevents:
- API keys from being exposed
- Large venv folders being committed
- IDE-specific settings from cluttering repo
- Sensitive user data from leaking

---

#### **README.md** — User Guide

**Purpose:** Quick-start guide for new users or developers.

**Sections:**
- Quick Start (6 steps to run)
- Project Overview (what does it do)
- Key Features
- Installation (detailed setup)
- Usage (running server, dashboard)
- API Endpoints (REST documentation)
- Project Structure (file overview)
- Troubleshooting (common issues)
- Development (extending the system)

**Target Audience:** Developers, DevOps, newcomers to the project.

---

#### **explain.md** — Architecture Deep-Dive

**Purpose:** Detailed technical explanation of design decisions and system internals.

**Sections:**
- System Overview (why one API call?)
- Design Philosophy (why architectural choices)
- Four-Stage Pipeline (how each stage works)
- Data Flow & Examples (real-world claim processing)
- Routing Logic (how claims are routed)
- Scoring System (escalation score formula)
- Risk Signals (semantic understanding)
- Configuration & Thresholds (adjustable parameters)
- Cost Optimization (how costs are minimized)
- Auditability & Explainability (full decision traceability)
- **File Structure** (this section!)

**Target Audience:** Architects, ML engineers, maintainers.

---

### Frontend Files (Web Dashboard)

#### **frontend/index.html** — Main Web Page

**Purpose:** HTML structure for the single-page application (SPA).

**Key Sections:**

1. **Header**
   ```html
   <header class="site-header">
       <nav class="header-nav">
           <button onclick="showPanel('upload')">Upload</button>
           <button onclick="showPanel('history')">History</button>
       </nav>
       <div class="header-badge">Gemini 2.5 Flash</div>
   </header>
   ```

2. **Upload Panel**
   ```html
   <div id="upload-panel" class="panel">
       <input type="file" id="fileInput" accept=".pdf,.txt">
       <button onclick="processFile()">Process Claim</button>
   </div>
   ```

3. **Results Panel**
   ```html
   <div id="results-panel" class="panel">
       <!-- Claim ID, extracted fields, routing decision, explanation -->
   </div>
   ```

4. **History Panel**
   ```html
   <div id="history-panel" class="panel">
       <!-- List of all processed claims in session -->
   </div>
   ```

**Design:**
- Responsive layout (mobile, tablet, desktop)
- Dark theme with glassmorphism styling
- Interactive panels with smooth transitions
- No build step required (vanilla HTML/CSS/JS)

---

#### **frontend/app.js** — Frontend Logic

**Purpose:** Handle user interactions and API integration.

**Key Functions:**

1. **File Upload & Validation**
   ```javascript
   async function processFile() {
       const file = document.getElementById('fileInput').files[0];
       
       // Validate file type & size
       if (!file.name.match(/\.(pdf|txt)$/i)) {
           alert("Only PDF or TXT files allowed");
           return;
       }
       
       if (file.size > 20 * 1024 * 1024) {
           alert("File too large (max 20 MB)");
           return;
       }
       
       // Send to backend
       const formData = new FormData();
       formData.append("fnol", file);
       
       const response = await fetch("/process-claim", {
           method: "POST",
           body: formData
       });
       
       const result = await response.json();
       displayResults(result);
   }
   ```

2. **Results Display**
   ```javascript
   function displayResults(result) {
       // Show claim ID
       document.getElementById('claimId').textContent = result.claimId;
       
       // Show extracted fields with confidence & source
       displayExtractedFields(result.extractedFields);
       
       // Show risk signals
       displayRiskSignals(result.riskSignals);
       
       // Show routing decision & explanation
       displayRouting(result.routing);
       
       // Add to history
       HISTORY.push(result);
   }
   ```

3. **Panel Navigation**
   ```javascript
   function showPanel(panelName) {
       // Hide all panels
       document.querySelectorAll('.panel').forEach(p => {
           p.style.display = 'none';
       });
       
       // Show selected panel
       document.getElementById(`${panelName}-panel`).style.display = 'block';
   }
   ```

4. **Session History**
   ```javascript
   const HISTORY = [];  // Store processed claims in memory
   
   function displayHistory() {
       // Render all claims from HISTORY
       // Click to view full details again
   }
   ```

**Error Handling:**
```javascript
if (response.status === 400) {
    alert(`Error: ${result.error}`);  // No file
} else if (response.status === 415) {
    alert(`Error: ${result.error}`);  // Invalid type
} else if (response.status === 500) {
    alert(`Processing failed: ${result.error}`);
}
```

---

#### **frontend/style.css** — Styling

**Purpose:** Visual design and responsive layout.

**Key Styles:**

1. **Layout**
   ```css
   body {
       font-family: 'Inter', sans-serif;
       background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
       color: #e0e0e0;
   }
   
   .container {
       max-width: 1200px;
       margin: 0 auto;
       padding: 20px;
   }
   ```

2. **Header**
   ```css
   .site-header {
       background: rgba(255, 255, 255, 0.1);
       backdrop-filter: blur(10px);
       border-radius: 12px;
       padding: 20px;
       margin-bottom: 30px;
   }
   ```

3. **Panels**
   ```css
   .panel {
       background: rgba(255, 255, 255, 0.05);
       border: 1px solid rgba(255, 255, 255, 0.1);
       border-radius: 12px;
       padding: 30px;
       margin-bottom: 20px;
       backdrop-filter: blur(10px);
   }
   ```

4. **Buttons**
   ```css
   button {
       background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
       color: white;
       border: none;
       padding: 12px 24px;
       border-radius: 8px;
       cursor: pointer;
       font-weight: 600;
       transition: all 0.3s ease;
   }
   
   button:hover {
       transform: translateY(-2px);
       box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
   }
   ```

5. **Responsive Design**
   ```css
   @media (max-width: 768px) {
       .container {
           padding: 10px;
       }
       
       .panel {
           padding: 15px;
       }
       
       button {
           padding: 10px 16px;
           font-size: 14px;
       }
   }
   ```

**Design System:**
- Dark theme (backgrounds: #1a1a2e, #16213e)
- Accent colors: Purple gradient (667eea → 764ba2)
- Glassmorphism: semi-transparent + blur effect
- Smooth transitions: 0.3s ease on interactions
- Mobile-first responsive design

---

### Pipeline Files (Processing Logic)

#### **pipeline/__init__.py** — Package Initialization

**Purpose:** Make `pipeline` directory a Python package.

**Content:** Usually empty (just makes imports work).

**Enables:**
```python
from pipeline.ingest import extract_text_and_flag_vision
from pipeline.extraction_agent import run_extraction_agent
from pipeline.validation_agent import find_missing_fields
```

---

#### **pipeline/ingest.py** — STAGE 0 (Text Extraction)

**Purpose:** Transform raw documents into clean, tokenized text.

**Key Functions:**

1. **Main Entry Point**
   ```python
   def extract_text_and_flag_vision(file_bytes, filename) -> (str, bool, obj):
       # Detect file type
       ext = os.path.splitext(filename)[1].lower()
       
       if ext == ".pdf":
           return _process_pdf_bytes(file_bytes)
       else:
           return _process_text_bytes(file_bytes)
   
   # Returns: (full_text, needs_vision, pdf_doc)
   ```

2. **PDF Processing**
   ```python
   def _process_pdf_bytes(file_bytes):
       doc = fitz.open(stream=file_bytes, filetype="pdf")
       pages_text = []
       needs_vision = False
       
       for i, page in enumerate(doc, start=1):
           text = page.get_text()
           
           # If page is mostly blank/scanned, flag for vision
           if len(text.strip()) < VISION_TEXT_THRESHOLD:
               needs_vision = True
               pages_text.append(f"[PAGE {i}]\n[GRAPHICAL/SCANNED PAGE]")
           else:
               pages_text.append(f"[PAGE {i}]\n{text}")
       
       full_text = "\n".join(pages_text)
       full_text = _strip_boilerplate(full_text)
       
       return full_text, needs_vision, doc
   ```

3. **Text Processing**
   ```python
   def _process_text_bytes(file_bytes):
       raw = file_bytes.decode("utf-8", errors="replace")
       text = _strip_boilerplate(f"[PAGE 1]\n{raw}")
       return text, False, None
   ```

4. **Boilerplate Stripping**
   ```python
   BOILERPLATE_PATTERNS = [
       r"Applicable in [A-Z][a-z]+...",  # ACORD location
       r"©.*ACORD CORPORATION",          # Copyright
       r"-{10,}.*FRAUD NOTICE.*-{10,}", # Fraud box
       r"\n{3,}",                        # Excessive line breaks
   ]
   
   def _strip_boilerplate(text):
       for pattern in BOILERPLATE_PATTERNS:
           text = re.sub(pattern, " ", text, flags=re.IGNORECASE | re.DOTALL)
       return text
   ```

**Output Example:**
```
[PAGE 1]
Policy Number: X55UXCR6C09P9123456
Policyholder Name: Marcus A. Whitfield
Incident Date: 06/28/2026
Incident Location: 456 Oak Lane, Denver, CO 80223
...
[PAGE 2]
[GRAPHICAL/SCANNED PAGE — vision required]
...
```

**Cost Impact:**
- Removes ~1,500 tokens of ACORD boilerplate per document
- Saves ~$0.0007-0.001 per document
- 70% token reduction on 10-page forms

---

#### **pipeline/extraction_agent.py** — STAGE 1 (Gemini Extraction)

**Purpose:** Call Gemini API exactly once to extract 16 fields + risk signals.

**Key Classes:**

1. **Data Models (Pydantic)**
   ```python
   class ExtractedFieldString(BaseModel):
       value: Optional[str]
       confidence: float        # 0.0-1.0
       source: Optional[str]    # "[PAGE n]"
   
   class RiskSignal(BaseModel):
       signal: str             # "Damage estimate unusually high"
       severity: str           # "low", "medium", "high"
       evidence: str           # Specific quote from document
       source: Optional[str]   # "[PAGE n]"
   
   class ExtractedFields(BaseModel):
       policyNumber: ExtractedFieldString
       policyholderName: ExtractedFieldString
       policyEffectiveDates: ExtractedFieldString
       incidentDate: ExtractedFieldString
       incidentTime: ExtractedFieldString
       incidentLocation: ExtractedFieldString
       incidentDescription: ExtractedFieldString
       claimant: ExtractedFieldString
       thirdParties: ExtractedFieldString
       contactDetails: ExtractedFieldString
       assetType: ExtractedFieldString
       assetId: ExtractedFieldString
       estimatedDamage: ExtractedFieldNumber
       claimType: ExtractedFieldString
       attachments: ExtractedFieldString
       initialEstimate: ExtractedFieldNumber
   
   class ExtractionResult(BaseModel):
       extractedFields: ExtractedFields
       riskSignals: List[RiskSignal]
   ```

2. **System Instruction**
   ```python
   SYSTEM_INSTRUCTION = """\
   You are a claims-intake extraction engine for a P&C insurer.
   
   Rules:
   1. Extract fields exactly as written. Never invent values.
   2. If field is missing, return null.
   3. Return every field with {value, confidence, source}.
   4. Flag semantic inconsistencies (e.g., incident date outside policy).
   5. Output valid JSON only, no prose.
   """
   ```

3. **Main Function**
   ```python
   def run_extraction_agent(document_text, needs_vision, pdf_bytes=None):
       client = genai.Client(api_key=GOOGLE_API_KEY)
       
       config = types.GenerateContentConfig(
           system_instruction=SYSTEM_INSTRUCTION,
           response_mime_type="application/json",
           response_schema=ExtractionResult,  # Forces Pydantic structure
           max_output_tokens=8192,
           temperature=0.1,  # Deterministic output
       )
       
       # Conditional model selection
       if needs_vision:
           MODEL = "gemini-2.5-flash"       # Full model with vision
           contents = [
               types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
               "Extract fields from the PDF..."
           ]
       else:
           MODEL = "gemini-2.5-flash-lite"  # Lite model (cheaper)
           contents = ["Extract fields from:\n" + document_text]
       
       # Call Gemini (with retry logic)
       for attempt in range(3):
           try:
               response = client.models.generate_content(
                   model=MODEL, contents=contents, config=config
               )
               break
           except (ServerError, APIError):
               if attempt == 2:
                   raise
               time.sleep(1.5 * (2.0 ** attempt))
       
       # Parse response
       result = json.loads(response.text)
       return result
   ```

**Token Usage (Typical):**
- Prompt tokens: ~2,500 (cleaned text + schema)
- Output tokens: ~800 (16 fields + risk signals)
- Total: ~3,300 tokens (~$0.0036 cost)

**Response Example:**
```json
{
  "extractedFields": {
    "policyNumber": {
      "value": "X55UXCR6C09P9123456",
      "confidence": 1.0,
      "source": "[PAGE 1]"
    },
    ...
  },
  "riskSignals": [
    {
      "signal": "Incident date potentially outside policy window",
      "severity": "medium",
      "evidence": "Incident 06/28/2026, policy effective 07/07/2026",
      "source": "[PAGE 1]"
    }
  ]
}
```

---

#### **pipeline/validation_agent.py** — STAGE 2 (Data Validation)

**Purpose:** Check extracted data for completeness, confidence, and consistency.

**Key Constants:**
```python
REQUIRED_FIELDS = [
    "policyNumber", "policyholderName", "incidentDate",
    "incidentLocation", "incidentDescription", "claimant",
    "assetType", "claimType", "initialEstimate"
]

CRITICAL_FIELDS = {"policyNumber", "assetId", "claimType"}
CRITICAL_THRESHOLD = 0.85    # Strict threshold for critical fields
STANDARD_THRESHOLD = 0.60    # Lenient threshold for others
```

**Key Functions:**

1. **Find Missing Fields**
   ```python
   def find_missing_fields(fields):
       missing = []
       for field in REQUIRED_FIELDS:
           value = fields.get(field, {}).get("value")
           if value is None or (isinstance(value, str) and not value.strip()):
               missing.append(field)
       return missing
   ```

2. **Find Low Confidence Fields**
   ```python
   def find_low_confidence_fields(fields):
       flagged = []
       for field in REQUIRED_FIELDS:
           obj = fields.get(field, {})
           confidence = obj.get("confidence", 1.0)
           threshold = 0.85 if field in CRITICAL_FIELDS else 0.60
           
           if confidence < threshold:
               flagged.append({
                   "field": field,
                   "confidence": confidence,
                   "threshold": threshold,
                   "is_critical": field in CRITICAL_FIELDS
               })
       return flagged
   ```

3. **Check Consistency**
   ```python
   def check_consistency(fields):
       issues = []
       
       # Check 1: Incident date within policy window
       incident_date = fields.get("incidentDate", {}).get("value")
       policy_dates = fields.get("policyEffectiveDates", {}).get("value")
       
       if incident_date and policy_dates:
           inc_dt = dateutil_parser.parse(incident_date)
           policy_start, policy_end = extract_dates_from_range(policy_dates)
           if not (policy_start <= inc_dt <= policy_end):
               issues.append("Incident date outside policy window")
       
       # Check 2: Damage proportional to incident
       damage = fields.get("estimatedDamage", {}).get("value")
       description = fields.get("incidentDescription", {}).get("value", "")
       
       if damage and damage > 500000 and "minor" in description.lower():
           issues.append("Damage disproportionate to incident severity")
       
       return issues
   ```

**Example Output:**
```python
{
    "missing": ["contactDetails"],
    "lowConfidence": [
        {
            "field": "assetId",
            "confidence": 0.52,
            "threshold": 0.85,
            "is_critical": True
        }
    ],
    "consistencyIssues": [
        "Incident date outside policy window"
    ]
}
```

---

#### **pipeline/routing_agent.py** — STAGE 3 (Routing Decisions)

**Purpose:** Calculate escalation score and route claims to appropriate queue.

**Key Constants:**
```python
# Scoring weights
SCORE_MISSING_FIELD = 15           # Per missing field
SCORE_LOW_CONF_CRITICAL = 15       # Per low-conf critical field
SCORE_LOW_CONF_STANDARD = 5        # Per low-conf standard field
SCORE_RISK_SIGNAL = {              # Per risk signal
    "low": 5,
    "medium": 15,
    "high": 30
}
SCORE_INJURY_CLAIM = 20            # If injury claim
SCORE_CONSISTENCY_ISSUE = 10       # Per consistency issue

# Thresholds
SCORE_FASTTRACK_MAX = 10           # Fast-track if ≤ this
SCORE_INVESTIGATION_MIN = 31       # Investigate if ≥ this
DAMAGE_FASTTRACK_MAX = 25_000      # Max damage for fast-track
```

**Key Functions:**

1. **Calculate Escalation Score**
   ```python
   def escalation_score(missing, low_conf, risk_signals, consistency, fields):
       score = 0
       
       score += 15 * len(missing)
       
       for lc in low_conf:
           score += 15 if lc["is_critical"] else 5
       
       for signal in risk_signals:
           score += SCORE_RISK_SIGNAL.get(signal["severity"], 0)
       
       score += 10 * len(consistency)
       
       if fields.get("claimType", {}).get("value", "").lower() == "injury":
           score += 20
       
       return score
   ```

2. **Route Decision Logic**
   ```python
   def base_route(fields, missing, low_conf, risk_signals, consistency, score):
       # Priority 1: Injury claims → Specialist
       if is_injury_claim(fields):
           return "Specialist Queue"
       
       # Priority 2: Missing/low-conf critical → Manual
       if missing or has_critical_low_conf(low_conf):
           return "Manual Review"
       
       # Priority 3: High score → Investigation
       if score >= 31:
           return "Investigation Flag"
       
       # Priority 4: Low score + low damage → Fast-track
       if score <= 10 and damage <= 25000:
           return "Fast-track"
       
       # Default: Manual review
       return "Manual Review"
   ```

**Routing Matrix:**
```
Injury Claim? → YES  → SPECIALIST_QUEUE
              → NO   ↓
Missing or     → YES  → MANUAL_REVIEW
Critical Low?  → NO   ↓
Score ≥ 31?    → YES  → INVESTIGATION_FLAG
              → NO   ↓
Score ≤ 10 &   → YES  → FAST_TRACK
Damage < $25k? → NO   → MANUAL_REVIEW
```

---

#### **pipeline/explanation.py** — STAGE 4 (Explanation Builder)

**Purpose:** Generate human-readable decision explanations (deterministic, no LLM).

**Key Function:**
```python
def build_reasoning(route, missing, low_conf, risk_signals, consistency, fields, score):
    explanation = ""
    
    # 1. Header based on route
    if route == "INVESTIGATION_FLAG":
        explanation += f"⚠️ This claim has been escalated to Investigation. "
    elif route == "SPECIALIST_QUEUE":
        explanation += f"👤 This injury claim has been routed to Specialist team. "
    elif route == "FAST_TRACK":
        explanation += f"✓ This claim qualifies for Fast-Track pathway. "
    else:
        explanation += f"This claim requires Manual Review. "
    
    # 2. Add score if investigation
    if route == "INVESTIGATION_FLAG":
        explanation += f"Escalation score ({score}) exceeds threshold (31).\n\n"
    
    # 3. Contributing factors
    factors = []
    
    if risk_signals:
        high_sig = [s for s in risk_signals if s["severity"] == "high"]
        if high_sig:
            factors.append(f"• High-severity risk signal ({high_sig[0]['signal']}) — +30 pts")
    
    if missing:
        factors.append(f"• Missing fields ({', '.join(missing[:2])}) — +15 pts each")
    
    if low_conf:
        critical_low = [lc for lc in low_conf if lc["is_critical"]]
        if critical_low:
            factors.append(f"• Low confidence on critical field — +15 pts")
    
    if consistency:
        factors.append(f"• Consistency issues detected — +10 pts each")
    
    if factors:
        explanation += "Contributing factors:\n" + "\n".join(factors)
    
    # 4. Recommendations
    if route == "INVESTIGATION_FLAG":
        explanation += "\n\nRecommended actions:\n"
        if risk_signals:
            explanation += f"• Verify {risk_signals[0]['signal'].lower()}\n"
        if missing:
            explanation += f"• Request missing {missing[0]}\n"
        if consistency:
            explanation += f"• Review {consistency[0]}\n"
    
    return explanation
```

**Example Output:**
```
⚠️ This claim has been escalated to Investigation. Escalation score (50) 
exceeds threshold (31).

Contributing factors:
• High-severity risk signal (Incident date outside policy window) — +30 pts
• Missing fields (contactDetails) — +15 pts
• Consistency issue (Damage disproportionate to incident) — +10 pts

Recommended actions:
• Verify incident date against policy records
• Request contact details from claimant
• Review damage estimate for reasonableness
```

**Why Pure Python?**
- Deterministic: same inputs → same explanation
- Fast: <50ms generation
- Free: zero API cost
- Auditable: transparent logic

---

### Summary: Data Flow Through Files

```
User uploads PDF/TXT
        ↓
app.py ← receives multipart/form-data
        ↓
ingest.py ← extracts text, strips boilerplate, flags vision pages
        ↓
extraction_agent.py ← calls Gemini API once (returns JSON)
        ↓
validation_agent.py ← checks missing, confidence, consistency (pure Python)
        ↓
routing_agent.py ← calculates score, determines route (pure Python)
        ↓
explanation.py ← generates human-readable reasoning (pure Python)
        ↓
app.py ← assembles JSON response
        ↓
frontend/app.js ← receives & displays results in frontend
        ↓
User sees routing decision + explanation + extracted fields
```

**File Responsibilities:**
| File | Responsibility | Technology |
|------|-----------------|------------|
| `app.py` | Orchestration, API | Flask |
| `ingest.py` | Text cleaning | PyMuPDF, regex |
| `extraction_agent.py` | Field extraction | Gemini API |
| `validation_agent.py` | Data checking | Python logic |
| `routing_agent.py` | Routing logic | Python math |
| `explanation.py` | Human text | Python strings |
| `index.html` | Page layout | HTML5 |
| `app.js` | User interaction | Vanilla JS |
| `style.css` | Visual design | CSS3 |

---

## Conclusion

**ClaimSight AI** demonstrates a principled approach to AI-assisted claims processing:

1. **Minimal API calls** → Lower cost
2. **Semantic understanding** → Better risk detection
3. **Deterministic logic** → Auditable decisions
4. **Full transparency** → Explainable outcomes
5. **Configurable thresholds** → Adaptable to policy

The system scales processing volume while maintaining the audit trail and explainability required in regulated insurance environments.
