#!/usr/bin/env python3
import os
import re
from datetime import datetime

FILES = [
    "api/db.php",
    "api/get_logs.php",
    "api/log_workout.php",
    "api/state_reset.php",
    "index.html",
    "style.css",
    "main.js",
    "lib/exercises.js",
    "lib/recovery.js",
    "lib/muscleMap.js",
    "lib/recs.js",
]

OUT_FILE = "nice.txt"

# --- Redaction patterns (conservative) ---
REDACTIONS = [
    # PHP variable assignments like $DB_PASS = "..."
    (re.compile(r"(\$DB_PASS\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_PASSWORD\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_USER\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_NAME\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_HOST\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),

    # Generic php assignments: password/api_key/token/secret = "..."
    (re.compile(r"(\bpassword\s*=\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bpasswd\s*=\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bpwd\s*=\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bapi[_-]?key\s*=\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\btoken\s*=\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bsecret\s*=\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),

    # PHP arrays: 'password' => '...'
    (re.compile(r"(['\"]password['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]api[_-]?key['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]token['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]secret['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),

    # define("DB_PASSWORD", "...")
    (re.compile(r'(define\(\s*[\'"]DB_PASSWORD[\'"]\s*,\s*)([\'"]).*?\2\s*\)', re.IGNORECASE),
     r"\1[REDACTED])"),

    # DSN fragments like password=something
    (re.compile(r"(password=)[^;'\"]+", re.IGNORECASE), r"\1[REDACTED]"),

    # getenv("OPENAI_API_KEY") style: if you accidentally inline it
    (re.compile(r'((OPENAI|XAI|ANTHROPIC|GROK|AZURE|AWS|GCP)[A-Z0-9_]*\s*=\s*)(["\']).*?\3', re.IGNORECASE),
     r"\1[REDACTED]"),
]

# --- Post-redaction leak detectors (fail hard if these remain) ---
LEAK_CHECKS = [
    re.compile(r"\$DB_PASS\s*=\s*(['\"]).+?\1\s*;", re.IGNORECASE),
    re.compile(r"\$DB_PASSWORD\s*=\s*(['\"]).+?\1\s*;", re.IGNORECASE),
    re.compile(r"define\(\s*['\"]DB_PASSWORD['\"]\s*,\s*(['\"]).+?\1\s*\)", re.IGNORECASE),
    re.compile(r"\b(api[_-]?key|token|secret|password)\s*=\s*(['\"]).+?\2", re.IGNORECASE),
    re.compile(r"(['\"]password['\"]\s*=>\s*)(['\"]).+?\2", re.IGNORECASE),
]

def redact(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text

def ensure_no_leaks(text: str, file_path: str):
    hits = []
    for chk in LEAK_CHECKS:
        m = chk.search(text)
        if m:
            hits.append(chk.pattern)
    if hits:
        raise SystemExit(
            f"\n[ABORT] Potential secret leakage still detected in: {file_path}\n"
            f"Matched patterns:\n- " + "\n- ".join(hits) + "\n"
            f"Fix the file or extend redaction rules, then rerun.\n"
        )

def main():
    root = os.getcwd()
    now = datetime.now().isoformat(timespec="seconds")

    with open(OUT_FILE, "w", encoding="utf-8") as out:
        out.write("MuscleMap Refactor Snapshot (SAFE)\n")
        out.write(f"Generated: {now}\n")
        out.write(f"Project root: {root}\n")
        out.write("=" * 80 + "\n\n")

        for path in FILES:
            out.write(f"\n{'#' * 80}\n")
            out.write(f"# FILE: {path}\n")
            out.write(f"{'#' * 80}\n\n")

            abs_path = os.path.join(root, path)

            if not os.path.exists(abs_path):
                out.write(f"[MISSING FILE] {path}\n")
                continue

            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
                safe = redact(content)

                # fail hard if something still looks like a secret
                ensure_no_leaks(safe, path)

                out.write(safe)

        out.write("\n\n=== END OF SNAPSHOT ===\n")

    print(f"✔ Wrote REDACTED snapshot to {OUT_FILE}")

if __name__ == "__main__":
    main()
