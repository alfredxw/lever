#!/usr/bin/env python3
"""Check publishable text without printing private values; --staged reads the index."""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
IPV4 = re.compile(r"(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.\d)")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
EXAMPLE_DOMAIN = re.compile(r"(?:^|\.)(?:example(?:\.(?:com|net|org))?|test|invalid|localhost)$", re.I)
DOC_NETS = tuple(ipaddress.ip_network(n) for n in (
    "192.0.0.0/24", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24",
))
RULES = (
    ("home directory", re.compile(r"/(?:Users|home)/[^/\s\"'<>`]+")),
    ("home directory", re.compile(r"\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s\"'<>`]+", re.I)),
    ("intranet URL", re.compile(
        r"\b(?:https?|wss?|ssh)://[^/\s\"'<>]+\.(?:corp|internal|intranet|local)(?=[:/\s\"'<>]|$)", re.I,
    )),
    ("private key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----")),
    ("access token", re.compile(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
        r"sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|"
        r"xox[baprs]-[A-Za-z0-9-]{10,})\b",
    )),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")),
)


def git(*args):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], capture_output=True, check=True,
    ).stdout


def private_rules():
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    words = set()
    for path in (ROOT / ".private-words.txt", config / "lever" / "private-words.txt"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            word = line.strip()
            if word and not word.startswith("#"):
                words.add(word.casefold())
    rules = list(RULES)
    for word in sorted(words):
        pattern = re.escape(word)
        if word.isascii() and word.isalnum() and len(word) < 6:
            pattern = r"(?<![a-z0-9])" + pattern + r"(?![a-z0-9])"
        rules.append(("local private term", re.compile(pattern, re.I)))
    return rules, len(words)


def problems(text, rules):
    kinds = {kind for kind, pattern in rules if pattern.search(text)}
    for match in IPV4.finditer(text):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if (address.is_private and not address.is_loopback and not address.is_unspecified
                and not any(address in network for network in DOC_NETS)):
            kinds.add("private IPv4")
    if any(not EXAMPLE_DOMAIN.search(match[1]) for match in EMAIL.finditer(text)):
        kinds.add("email")
    return sorted(kinds)


def safe_path(name, rules):
    for _, pattern in rules:
        name = pattern.sub("[redacted]", name)
    name = IPV4.sub("[redacted]", EMAIL.sub("[redacted]", name))
    return name.replace("\n", r"\n").replace("\r", r"\r")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="scan staged blobs instead of working files")
    args = parser.parse_args()
    rules, word_count = private_rules()
    if args.staged:
        names = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    else:
        names = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
    hits = 0
    scanned = 0

    def report(name, location, text):
        nonlocal hits
        for kind in problems(text, rules):
            print(f"{safe_path(name, rules)}:{location}: {kind}")
            hits += 1

    for raw in names.split(b"\0"):
        if not raw:
            continue
        name = os.fsdecode(raw)
        report(name, "path", name)
        if args.staged:
            data = git("show", ":" + name)
        else:
            path = ROOT / name
            try:
                # Inspect the link target itself, never a file outside the checkout.
                data = os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes()
            except FileNotFoundError:
                continue  # A tracked file deleted from the working tree.
        scanned += 1
        if b"\0" in data:
            continue
        for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            report(name, number, line)
    if hits:
        print(f"privacy_check: {hits} hit(s); replace private values with placeholders.", file=sys.stderr)
        return 1
    print(f"privacy_check: clean ({scanned} files, {word_count} local private terms)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        sys.exit("privacy_check: unable to read files or Git objects; scan did not complete.")
