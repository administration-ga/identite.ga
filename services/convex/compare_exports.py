#!/usr/bin/env python3
"""Compare two Convex exports without printing document contents or file IDs."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile


def inventory(path):
    tables = {}
    files = {}
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            name = entry.filename
            if name.endswith("/documents.jsonl"):
                table = name.removesuffix("/documents.jsonl")
                if table.split("/")[-1] == "_tables":
                    continue
                with archive.open(entry) as stream:
                    rows = [json.loads(line) for line in stream if line.strip()]
                rows.sort(key=lambda row: row["_id"])
                canonical = json.dumps(rows, sort_keys=True, separators=(",", ":"))
                tables[table] = {
                    "count": len(rows),
                    "sha256": hashlib.sha256(canonical.encode()).hexdigest(),
                }
            elif "_storage" in name.split("/")[:-1] and not name.endswith(".jsonl") and not entry.is_dir():
                digest = hashlib.sha256()
                with archive.open(entry) as stream:
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                files[name] = {"bytes": entry.file_size, "sha256": digest.hexdigest()}
    return tables, files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    source_tables, source_files = inventory(args.source)
    destination_tables, destination_files = inventory(args.destination)
    # A deployed component may introduce an empty table absent from the source.
    # Empty destination tables are harmless; every source table must match.
    different_tables = [
        name for name in sorted(source_tables.keys() | destination_tables.keys())
        if source_tables.get(name) != destination_tables.get(name)
        and not (name not in source_tables and destination_tables[name]["count"] == 0)
    ]
    different_files = sum(
        source_files.get(name) != destination_files.get(name)
        for name in source_files.keys() | destination_files.keys()
    )
    report = {
        "equal": not different_tables and different_files == 0,
        "source_tables": len(source_tables),
        "destination_tables": len(destination_tables),
        "source_rows": sum(table["count"] for table in source_tables.values()),
        "destination_rows": sum(table["count"] for table in destination_tables.values()),
        "source_files": len(source_files),
        "destination_files": len(destination_files),
        "source_file_bytes": sum(file["bytes"] for file in source_files.values()),
        "different_tables": different_tables,
        "different_files": different_files,
    }
    if args.report:
        os.umask(0o077)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["equal"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
