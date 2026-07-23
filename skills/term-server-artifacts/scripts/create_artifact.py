#!/usr/bin/env python3
"""Create a private, session-scoped artifact and print its URI and path."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid


SAFE_SESSION = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create an editable artifact for the current terminal session."
    )
    parser.add_argument(
        "--name",
        default=None,
        help="Artifact filename, including an appropriate extension (default: artifact.md).",
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


def create_artifact(name: str, content: bytes) -> Path:
    root = artifact_root()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    session_directory = root / session_name()
    session_directory.mkdir(mode=0o700, exist_ok=True)
    directory = session_directory / str(uuid.uuid4())
    directory.mkdir(mode=0o700)
    destination = directory / name
    descriptor, temporary_name = tempfile.mkstemp(prefix=".artifact-", dir=directory)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def main() -> int:
    args = parse_args()
    try:
        path = create_artifact(
            filename(args.name, args.from_file),
            content_bytes(args),
        ).resolve()
    except (OSError, ValueError) as error:
        print(f"create_artifact.py: {error}", file=sys.stderr)
        return 1
    print(path.as_uri())
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
