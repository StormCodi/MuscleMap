#!/usr/bin/env python3
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

# =========================
# CONFIG
# =========================

# Add/remove files here.
FILES = [
    # core user identity
    "api/db.php",              # replace GLOBAL_USER_ID=0 with session-based user_id

    # auth (new)
    "api/auth/login.php",
    "api/auth/register.php",
    "api/auth/logout.php",

    # APIs that must respect user_id (already mostly do, but rely on db.php)
    "api/exercises_list.php",
    "api/add_exercises.php",
    "api/ai_chat.php",
    "api/muscle_sensitivity.php",

    # workout system (user_id is centralized here)
    "api/workout/_lib.php",

    # frontend needs to react to auth state
    "lib/api.js",              # handle 401 once, globally
    "main.js",                 # redirect if unauth
    "ai_chat.js",              # redirect + logout
]



OUT_FILE = "nice_snapshot.md"

# file tree options
TREE_MAX_DEPTH = 3
TREE_IGNORE_DIRS = {
    ".git", "node_modules", "vendor", "uploads", "uploads/ai_tmp",
    "__pycache__", ".venv", ".idea", ".vscode", "z-anatomy-unity", "myenv",
}
TREE_IGNORE_FILES = {
    ".DS_Store",
}

# =========================
# REDACTION
# =========================

# Conservative redactions: avoid nuking too much code context but ensure secrets are not leaked.
REDACTIONS = [
    # PHP vars: $DB_PASS = "..."
    (re.compile(r"(\$DB_PASS\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_PASSWORD\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_USER\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_NAME\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),
    (re.compile(r"(\$DB_HOST\s*=\s*)(['\"]).*?\2\s*;", re.IGNORECASE), r"\1[REDACTED];"),

    # define("DB_PASSWORD", "...")
    (re.compile(r'(define\(\s*[\'"]DB_PASSWORD[\'"]\s*,\s*)([\'"]).*?\2\s*\)', re.IGNORECASE),
     r"\1[REDACTED])"),
    (re.compile(r'(define\(\s*[\'"]DB_USER[\'"]\s*,\s*)([\'"]).*?\2\s*\)', re.IGNORECASE),
     r"\1[REDACTED])"),
    (re.compile(r'(define\(\s*[\'"]DB_NAME[\'"]\s*,\s*)([\'"]).*?\2\s*\)', re.IGNORECASE),
     r"\1[REDACTED])"),
    (re.compile(r'(define\(\s*[\'"]DB_HOST[\'"]\s*,\s*)([\'"]).*?\2\s*\)', re.IGNORECASE),
     r"\1[REDACTED])"),

    # PDO DSN strings (mysql:host=...;dbname=...;port=...)
    (re.compile(r"(mysql:host=)([^;'\"]+)", re.IGNORECASE), r"\1[REDACTED_HOST]"),
    (re.compile(r"(dbname=)([^;'\"]+)", re.IGNORECASE), r"\1[REDACTED_DB]"),
    (re.compile(r"(port=)(\d+)", re.IGNORECASE), r"\1[REDACTED_PORT]"),

    # DSN-like fragments: password=something
    (re.compile(r"(password=)[^;'\"]+", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(passwd=)[^;'\"]+", re.IGNORECASE), r"\1[REDACTED]"),

    # mysqli_connect("host","user","pass","db")
    (re.compile(r"(mysqli_connect\(\s*['\"][^'\"]+['\"]\s*,\s*['\"][^'\"]+['\"]\s*,\s*)(['\"]).*?\2", re.IGNORECASE),
     r"\1[REDACTED]"),

    # Generic assignments in many languages: password/api_key/token/secret = "..."
    (re.compile(r"(\bpassword\s*[:=]\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bpasswd\s*[:=]\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bpwd\s*[:=]\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bapi[_-]?key\s*[:=]\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\btoken\s*[:=]\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(\bsecret\s*[:=]\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),

    # JSON-ish / arrays: "password": "..."
    (re.compile(r"(['\"]password['\"]\s*:\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]api[_-]?key['\"]\s*:\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]token['\"]\s*:\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]secret['\"]\s*:\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),

    # PHP arrays: 'password' => '...'
    (re.compile(r"(['\"]password['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]api[_-]?key['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]token['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(['\"]secret['\"]\s*=>\s*)(['\"]).*?\2", re.IGNORECASE), r"\1[REDACTED]"),

    # .env style: KEY=VALUE (only for sensitive key names)
    (re.compile(r"^(\s*(?:OPENAI|XAI|ANTHROPIC|GROK|AZURE|AWS|GCP|DB)_[A-Z0-9_]*\s*=\s*).+$", re.IGNORECASE | re.MULTILINE),
     r"\1[REDACTED]"),

    # Private keys/certs blocks
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----",
                re.DOTALL),
     "[REDACTED_PRIVATE_KEY_BLOCK]"),
]

# "Fail hard" patterns: if any appear in the *final snapshot*, abort.
LEAK_CHECKS = [
    re.compile(r"\$DB_PASS\s*=\s*(['\"]).+?\1\s*;", re.IGNORECASE),
    re.compile(r"\$DB_PASSWORD\s*=\s*(['\"]).+?\1\s*;", re.IGNORECASE),
    re.compile(r"define\(\s*['\"]DB_PASSWORD['\"]\s*,\s*(['\"]).+?\1\s*\)", re.IGNORECASE),
    re.compile(r"\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*(['\"]).+?\2", re.IGNORECASE),
    re.compile(r"(['\"]password['\"]\s*=>\s*)(['\"]).+?\2", re.IGNORECASE),
    re.compile(r"(['\"]password['\"]\s*:\s*)(['\"]).+?\2", re.IGNORECASE),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----", re.IGNORECASE),
]

# Also detect "looks like a real key" strings (heuristic, better safe than sorry)
HEURISTIC_KEYS = [
    # OpenAI style-ish keys (varies), Grok/xAI keys (unknown format), generic long tokens
    re.compile(r"\b(sk-[A-Za-z0-9]{20,})\b"),
    re.compile(r"\b(xai-[A-Za-z0-9]{16,})\b", re.IGNORECASE),
    re.compile(r"\b([A-Fa-f0-9]{32,})\b"),  # long hex tokens
    re.compile(r"\b([A-Za-z0-9_\-]{40,})\b"),  # long base64/url-safe tokens
]


# =========================
# HELPERS
# =========================

def run(cmd: list[str]) -> str:
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
        return (p.stdout or "").strip()
    except Exception as e:
        return f"[error running {' '.join(cmd)}: {e}]"

def redact(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text

def ensure_no_leaks(text: str, file_path: str):
    hits = []
    for chk in LEAK_CHECKS:
        if chk.search(text):
            hits.append(chk.pattern)

    # heuristic scan: only treat as fatal if it looks *and* it's near a sensitive keyword
    # (reduces false positives on long hashes that are harmless)
    if any(k.search(text) for k in HEURISTIC_KEYS):
        window = text.lower()
        if any(w in window for w in ["api_key", "apikey", "token", "secret", "password", "xai", "openai", "anthropic", "grok", "db_pass", "db_password"]):
            hits.append("[heuristic key-like token present near sensitive keyword]")

    if hits:
        raise SystemExit(
            f"\n[ABORT] Potential secret leakage detected in snapshot output for: {file_path}\n"
            f"Matched checks:\n- " + "\n- ".join(hits) + "\n"
            f"Fix the source file(s) or extend redaction rules, then rerun.\n"
        )

def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")

def is_ignored_dir(d: Path) -> bool:
    parts = set(d.parts)
    if any(x in parts for x in TREE_IGNORE_DIRS):
        return True
    # also ignore if any segment exactly matches ignore dirs
    return any(seg in TREE_IGNORE_DIRS for seg in d.parts)

def build_tree(root: Path, max_depth: int = 3) -> str:
    lines: list[str] = []
    root = root.resolve()

    def walk(dir_path: Path, depth: int):
        if depth > max_depth:
            return
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except Exception:
            return

        for p in entries:
            rel = p.relative_to(root)
            if p.is_dir():
                if is_ignored_dir(p):
                    continue
                lines.append(f"{'  ' * depth}- {rel}/")
                walk(p, depth + 1)
            else:
                if p.name in TREE_IGNORE_FILES:
                    continue
                # hide obvious sensitive files but still show they exist
                if p.name.lower() in {".env", ".env.local", ".env.production"}:
                    lines.append(f"{'  ' * depth}- {rel}  [REDACTED_FILE]")
                else:
                    lines.append(f"{'  ' * depth}- {rel}")

    lines.append(f"- {root.name}/")
    walk(root, 1)
    return "\n".join(lines)

def main():
    root = Path(os.getcwd()).resolve()
    now = datetime.now().isoformat(timespec="seconds")

    git_head = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    git_commit = run(["git", "rev-parse", "HEAD"])
    git_status = run(["git", "status", "--porcelain"])
    php_v = run(["php", "-v"]).splitlines()[0] if shutil_which("php") else "[php not found]"
    py_v = run(["python3", "--version"]) if shutil_which("python3") else "[python3 not found]"

    tree = build_tree(root, TREE_MAX_DEPTH)

    with open(OUT_FILE, "w", encoding="utf-8") as out:
        out.write("# MuscleMap Snapshot (REDACTED)\n\n")
        out.write(f"- Generated: `{now}`\n")
        out.write(f"- Project root: `{root}`\n")
        out.write(f"- Git branch: `{git_head}`\n")
        out.write(f"- Git commit: `{git_commit}`\n")
        out.write(f"- PHP: `{php_v}`\n")
        out.write(f"- Python: `{py_v}`\n\n")

        if git_status:
            out.write("## Git status (porcelain)\n\n")
            out.write("```text\n" + git_status + "\n```\n\n")

        out.write("## Project tree (trimmed)\n\n")
        out.write("```text\n" + tree + "\n```\n\n")

        out.write("## Files\n\n")

        for rel_path in FILES:
            out.write("\n---\n\n")
            out.write(f"### `{rel_path}`\n\n")

            abs_path = (root / rel_path).resolve()
            if not abs_path.exists():
                out.write(f"**[MISSING FILE]** `{rel_path}`\n")
                continue

            content = read_text(abs_path)

            # Optional: also refuse to snapshot raw .env files if someone adds them by mistake
            if abs_path.name.lower().startswith(".env"):
                out.write("[REDACTED_FILE]\n")
                continue

            safe = redact(content)

            # Fail hard if secrets are still detectable in the redacted output
            ensure_no_leaks(safe, rel_path)

            # Use fenced blocks with language hints when possible
            lang = guess_lang(rel_path)
            out.write(f"```{lang}\n{safe}\n```\n")

        out.write("\n---\n\n")
        out.write("**END OF SNAPSHOT**\n")

    print(f"✔ Wrote REDACTED snapshot to {OUT_FILE}")

# =========================
# SMALL UTILS (no extra deps)
# =========================

def shutil_which(cmd: str) -> bool:
    # minimal which
    paths = os.environ.get("PATH", "").split(os.pathsep)
    exts = [""] + (os.environ.get("PATHEXT", "").split(os.pathsep) if os.name == "nt" else [])
    for p in paths:
        for e in exts:
            cand = Path(p) / (cmd + e)
            if cand.exists() and os.access(cand, os.X_OK):
                return True
    return False

def guess_lang(path: str) -> str:
    p = path.lower()
    if p.endswith(".php"):
        return "php"
    if p.endswith(".js"):
        return "javascript"
    if p.endswith(".css"):
        return "css"
    if p.endswith(".html"):
        return "html"
    if p.endswith(".md"):
        return "markdown"
    if p.endswith(".json"):
        return "json"
    return "text"

if __name__ == "__main__":
    main()
