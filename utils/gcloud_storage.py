"""Google Cloud Storage helper + CLI for SceneOne assets.

Usage examples:
  python utils/gcloud_storage.py upload --audio-file exports/audio/file.wav --object-name demo.wav
  python utils/gcloud_storage.py upload --script-id intro --script-text "Hello world"
  python utils/gcloud_storage.py get-script --script-id intro
  python utils/gcloud_storage.py get-audio --object-name demo.wav --out /tmp/demo.wav
  python utils/gcloud_storage.py list --kind all --max-results 50
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Iterable, Optional

from google.cloud import storage

DEFAULT_BUCKET = "sceneone-media-prod"
AUDIO_PREFIX = "audio"
SCRIPTS_PREFIX = "scripts"


class GCSAssetStore:
    def __init__(self, bucket_name: Optional[str] = None) -> None:
        self.bucket_name = bucket_name or os.getenv("GCS_BUCKET", DEFAULT_BUCKET)
        self.client = storage.Client()
        self.bucket = self.client.bucket(self.bucket_name)

    def upload_audio(self, local_path: str, object_name: str) -> str:
        normalized = _normalize_audio_object_name(object_name)
        blob = self.bucket.blob(f"{AUDIO_PREFIX}/{normalized}")
        blob.upload_from_filename(local_path)
        return blob.name

    def upload_audio_bytes(self, data: bytes, object_name: str, content_type: Optional[str] = None) -> str:
        normalized = _normalize_audio_object_name(object_name)
        blob = self.bucket.blob(f"{AUDIO_PREFIX}/{normalized}")
        blob.upload_from_string(data, content_type=content_type)
        return blob.name

    def upload_script_text(self, script_id: str, text: str) -> str:
        blob = self.bucket.blob(f"{SCRIPTS_PREFIX}/{script_id}.txt")
        blob.upload_from_string(text, content_type="text/plain")
        return blob.name

    def upload_script_file(self, script_id: str, script_file: str) -> str:
        text = Path(script_file).read_text(encoding="utf-8")
        return self.upload_script_text(script_id=script_id, text=text)

    def download_script_text(self, script_id: str) -> str:
        blob = self.bucket.blob(f"{SCRIPTS_PREFIX}/{script_id}.txt")
        return blob.download_as_text()

    def download_script_to_file(self, script_id: str, out_path: str) -> str:
        text = self.download_script_text(script_id)
        output = Path(out_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
        return str(output)

    def download_audio(self, object_name: str, out_path: str) -> str:
        normalized = _normalize_audio_object_name(object_name)
        blob = self.bucket.blob(f"{AUDIO_PREFIX}/{normalized}")
        output = Path(out_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(output)
        return str(output)

    def download_audio_bytes(self, object_name: str) -> bytes:
        normalized = _normalize_audio_object_name(object_name)
        blob = self.bucket.blob(f"{AUDIO_PREFIX}/{normalized}")
        return blob.download_as_bytes()

    def list_objects(self, kind: str = "all", prefix: str = "", max_results: int = 100) -> list[str]:
        object_prefixes = _resolve_prefixes(kind, prefix)
        results: list[str] = []

        for object_prefix in object_prefixes:
            iterator = self.client.list_blobs(
                self.bucket_name,
                prefix=object_prefix,
                max_results=max_results,
            )
            for blob in iterator:
                results.append(blob.name)
                if len(results) >= max_results:
                    return results

        return results


def _resolve_prefixes(kind: str, user_prefix: str) -> Iterable[str]:
    clean_prefix = user_prefix.strip("/")
    if kind == "audio":
        yield _join_prefix(AUDIO_PREFIX, clean_prefix)
    elif kind == "scripts":
        yield _join_prefix(SCRIPTS_PREFIX, clean_prefix)
    else:
        if clean_prefix:
            yield clean_prefix
        else:
            yield f"{AUDIO_PREFIX}/"
            yield f"{SCRIPTS_PREFIX}/"


def _join_prefix(base: str, extra: str) -> str:
    if not extra:
        return f"{base}/"
    if extra.startswith(f"{base}/"):
        return extra
    return f"{base}/{extra}"


def _normalize_audio_object_name(object_name: str) -> str:
    stripped = object_name.strip("/")
    prefix = f"{AUDIO_PREFIX}/"
    if stripped.startswith(prefix):
        return stripped[len(prefix):]
    return stripped


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Store/retrieve SceneOne audio and scripts in Google Cloud Storage")
    parser.add_argument("--bucket", default=None, help="GCS bucket name. Defaults to GCS_BUCKET env var or sceneone-media-prod")

    subparsers = parser.add_subparsers(dest="command", required=True)

    upload_parser = subparsers.add_parser("upload", help="Upload audio and/or script text")
    upload_parser.add_argument("--audio-file", help="Path to local audio file")
    upload_parser.add_argument("--object-name", help="Target audio object name under audio/")
    upload_parser.add_argument("--script-id", help="Script id used as scripts/<script_id>.txt")
    upload_parser.add_argument("--script-file", help="Path to local text file to upload as script")
    upload_parser.add_argument("--script-text", help="Raw script text to upload")

    get_script_parser = subparsers.add_parser("get-script", help="Download script text by script id")
    get_script_parser.add_argument("--script-id", required=True)
    get_script_parser.add_argument("--out", help="Output file path. If omitted, prints script text")

    get_audio_parser = subparsers.add_parser("get-audio", help="Download audio object")
    get_audio_parser.add_argument("--object-name", required=True)
    get_audio_parser.add_argument("--out", required=True, help="Local destination file path")

    list_parser = subparsers.add_parser("list", help="List objects in bucket")
    list_parser.add_argument("--kind", choices=["audio", "scripts", "all"], default="all")
    list_parser.add_argument("--prefix", default="", help="Optional prefix filter")
    list_parser.add_argument("--max-results", type=int, default=100)

    return parser


def _validate_upload_args(args: argparse.Namespace) -> None:
    has_audio = bool(args.audio_file)
    has_script = bool(args.script_file or args.script_text)

    if not has_audio and not has_script:
        raise ValueError("upload requires --audio-file and/or one of --script-file|--script-text")

    if has_audio and not args.object_name:
        raise ValueError("--object-name is required when --audio-file is provided")

    if has_script and not args.script_id:
        raise ValueError("--script-id is required when uploading script content")

    if args.script_file and args.script_text:
        raise ValueError("Provide only one of --script-file or --script-text")


def _run_upload(store: GCSAssetStore, args: argparse.Namespace) -> int:
    _validate_upload_args(args)

    if args.audio_file:
        name = store.upload_audio(args.audio_file, args.object_name)
        print(f"Uploaded audio: {name}")

    if args.script_text:
        name = store.upload_script_text(args.script_id, args.script_text)
        print(f"Uploaded script: {name}")

    if args.script_file:
        name = store.upload_script_file(args.script_id, args.script_file)
        print(f"Uploaded script: {name}")

    return 0


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    store = GCSAssetStore(bucket_name=args.bucket)

    if args.command == "upload":
        return _run_upload(store, args)

    if args.command == "get-script":
        if args.out:
            output = store.download_script_to_file(args.script_id, args.out)
            print(f"Saved script to: {output}")
        else:
            print(store.download_script_text(args.script_id))
        return 0

    if args.command == "get-audio":
        output = store.download_audio(args.object_name, args.out)
        print(f"Saved audio to: {output}")
        return 0

    if args.command == "list":
        for item in store.list_objects(kind=args.kind, prefix=args.prefix, max_results=args.max_results):
            print(item)
        return 0

    parser.error("Unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
