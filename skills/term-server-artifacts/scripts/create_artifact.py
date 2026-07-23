#!/usr/bin/env python3
"""Create a private, session-scoped artifact and print its URI and path."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
import uuid


SAFE_SESSION = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
SAFE_PRODUCER = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create an editable artifact for the current terminal session."
    )
    parser.add_argument(
        "--name",
        default=None,
        help="Artifact filename, including an appropriate extension (default: artifact.md).",
    )
    parser.add_argument(
        "--producer",
        default=None,
        help="Agent or tool creating the artifact, for example codex.",
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--from-file", type=Path, help="Copy bytes from an existing file.")
    source.add_argument("--content", help="Use this text instead of reading standard input.")
    return parser.parse_args()


def artifact_root() -> Path:
    configured = os.environ.get("TERM_SERVER_ARTIFACTS_DIR")
    if configured:
        root = Path(configured).expanduser()
        if not root.is_absolute():
            raise ValueError("TERM_SERVER_ARTIFACTS_DIR must be an absolute path")
        return root
    return Path(tempfile.gettempdir()) / "artifacts"


def session_name() -> str:
    session = os.environ.get("TERM_SERVER_SESSION") or f"pid-{os.getppid()}"
    if not SAFE_SESSION.fullmatch(session):
        raise ValueError("TERM_SERVER_SESSION contains unsupported characters")
    return session


def filename(requested: str | None, source: Path | None) -> str:
    name = requested or (source.name if source else "artifact.md")
    if Path(name).name != name or name in {"", ".", ".."}:
        raise ValueError("--name must be a filename, not a path")
    return name


def content_bytes(args: argparse.Namespace) -> bytes:
    if args.from_file:
        if not args.from_file.is_file():
            raise ValueError(f"source file does not exist: {args.from_file}")
        return args.from_file.read_bytes()
    if args.content is not None:
        return args.content.encode()
    if sys.stdin.isatty():
        raise ValueError("provide content on stdin, with --content, or with --from-file")
    return sys.stdin.buffer.read()


def producer_name(requested: str | None) -> str | None:
    if requested is None:
        return None
    producer = requested.strip().lower()
    if not SAFE_PRODUCER.fullmatch(producer):
        raise ValueError("--producer contains unsupported characters")
    return producer


def write_private(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def create_artifact(name: str, content: bytes, producer: str | None) -> Path:
    root = artifact_root()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    session_directory = root / session_name()
    session_directory.mkdir(mode=0o700, exist_ok=True)
    artifact_id = str(uuid.uuid4())
    staging = Path(tempfile.mkdtemp(prefix=".artifact-", dir=session_directory))
    destination = staging / name
    try:
        metadata = {
            "createdAt": int(time.time() * 1000),
            **({"producer": producer} if producer else {}),
        }
        write_private(
            staging / ".artifact.json",
            json.dumps(metadata, separators=(",", ":")).encode(),
        )
        write_private(destination, content)
        final_directory = session_directory / artifact_id
        staging.replace(final_directory)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return final_directory / name


def main() -> int:
    args = parse_args()
    try:
        path = create_artifact(
            filename(args.name, args.from_file),
            content_bytes(args),
            producer_name(args.producer),
        ).resolve()
    except (OSError, ValueError) as error:
        print(f"create_artifact.py: {error}", file=sys.stderr)
        return 1
    print(path.as_uri())
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
