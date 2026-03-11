"""Compatibility wrapper for the canonical module: utils/gcloud_storage.py."""

from gcloud_storage import main


if __name__ == "__main__":
    raise SystemExit(main())
