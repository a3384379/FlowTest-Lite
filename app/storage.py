from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel


class MissingAsset(ValueError):
    pass


class EditConflict(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class StoredAsset:
    id: str
    revision: int
    updated_at: str
    data: dict

    def payload(self) -> dict:
        return {**self.data, "id": self.id, "revision": self.revision, "updated_at": self.updated_at}


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.touch(mode=0o600, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS assets (
                    kind TEXT NOT NULL,
                    id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    data TEXT NOT NULL,
                    PRIMARY KEY (kind, id)
                );
                CREATE TABLE IF NOT EXISTS api_groups (name TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    content BLOB NOT NULL
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def asset(row: sqlite3.Row | None) -> StoredAsset:
        if row is None:
            raise MissingAsset("记录不存在")
        return StoredAsset(row["id"], row["revision"], row["updated_at"], json.loads(row["data"]))

    def list(self, kind: str) -> list[StoredAsset]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM assets WHERE kind=? ORDER BY updated_at DESC, id", (kind,)
            ).fetchall()
        return [self.asset(row) for row in rows]

    def get(self, kind: str, key: str) -> StoredAsset:
        with self.connect() as db:
            return self.asset(db.execute(
                "SELECT * FROM assets WHERE kind=? AND id=?", (kind, key)
            ).fetchone())

    def create_many(self, kind: str, items: list[BaseModel]) -> list[StoredAsset]:
        now = datetime.now(UTC).isoformat()
        rows = [(kind, str(uuid4()), 1, now, item.model_dump_json()) for item in items]
        with self.connect() as db:
            db.executemany("INSERT INTO assets VALUES (?, ?, ?, ?, ?)", rows)
        return [StoredAsset(key, rev, stamp, json.loads(data)) for _, key, rev, stamp, data in rows]

    def put(self, kind: str, key: str, item: BaseModel, revision: int | None) -> StoredAsset:
        now = datetime.now(UTC).isoformat()
        data = item.model_dump_json()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT revision FROM assets WHERE kind=? AND id=?", (kind, key)
            ).fetchone()
            if old is None and kind != "settings":
                raise MissingAsset("记录不存在")
            previous = old["revision"] if old else 0
            if revision is not None and revision != previous:
                raise EditConflict("记录已有更新，请重新加载后保存")
            version = previous + 1
            db.execute("""
                INSERT INTO assets VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(kind,id) DO UPDATE SET
                    revision=excluded.revision, updated_at=excluded.updated_at, data=excluded.data
                """, (kind, key, version, now, data))
        return StoredAsset(key, version, now, json.loads(data))

    def delete(self, kind: str, key: str, *, revision: int | None = None) -> None:
        with self.connect() as db:
            deleted = db.execute(
                "DELETE FROM assets WHERE kind=? AND id=? AND (? IS NULL OR revision=?)",
                (kind, key, revision, revision),
            )
            if deleted.rowcount:
                return
            if revision is not None and db.execute(
                "SELECT 1 FROM assets WHERE kind=? AND id=?", (kind, key),
            ).fetchone() is not None:
                raise EditConflict("记录已有更新，请重新加载后删除")
            raise MissingAsset("记录不存在")

    def groups(self) -> list[str]:
        with self.connect() as db:
            rows = db.execute("""
                SELECT name FROM api_groups
                UNION
                SELECT json_extract(data, '$.group') FROM assets
                WHERE kind='api' AND coalesce(json_extract(data, '$.group'), '') != ''
                ORDER BY 1
            """).fetchall()
        return [row[0] for row in rows]

    def put_group(self, name: str, previous: str | None = None) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if previous != name and self._group_exists(db, name):
                raise EditConflict("已有同名分组")
            if previous is not None:
                if not self._group_exists(db, previous):
                    raise MissingAsset("分组已删除，请刷新目录后重试")
                self._move_group(db, previous, name)
                db.execute("DELETE FROM api_groups WHERE name=?", (previous,))
            db.execute("INSERT OR IGNORE INTO api_groups (name) VALUES (?)", (name,))

    def delete_group(self, name: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._move_group(db, name, "")
            db.execute("DELETE FROM api_groups WHERE name=?", (name,))

    @staticmethod
    def _group_exists(db: sqlite3.Connection, name: str) -> bool:
        return db.execute("""
            SELECT 1 FROM api_groups WHERE name=?
            UNION ALL
            SELECT 1 FROM assets WHERE kind='api' AND json_extract(data, '$.group')=?
            LIMIT 1
        """, (name, name)).fetchone() is not None

    @staticmethod
    def _move_group(db: sqlite3.Connection, previous: str, name: str) -> None:
        db.execute("""
            UPDATE assets
            SET data=json_set(data, '$.group', ?), revision=revision + 1
            WHERE kind='api' AND json_extract(data, '$.group') = ? AND ? != ?
        """, (name, previous, name, previous))

    def move_apis(self, keys: list[str], name: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for key in keys:
                result = db.execute("""
                    UPDATE assets
                    SET data=json_set(data, '$.group', ?), revision=revision + 1
                    WHERE kind='api' AND id=? AND json_extract(data, '$.group') IS NOT ?
                """, (name, key, name))
                if not result.rowcount and db.execute(
                    "SELECT 1 FROM assets WHERE kind='api' AND id=?", (key,)
                ).fetchone() is None:
                    raise MissingAsset("有接口已删除，请刷新目录后重试")
            if name:
                db.execute("INSERT OR IGNORE INTO api_groups (name) VALUES (?)", (name,))

    def upload(self, filename: str, content_type: str, content: bytes) -> dict:
        row = {
            "id": str(uuid4()), "filename": filename, "content_type": content_type,
            "size_bytes": len(content), "sha256": sha256(content).hexdigest(),
            "created_at": datetime.now(UTC).isoformat(),
        }
        with self.connect() as db:
            db.execute("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?)", (*row.values(), content))
        return row

    def files(self) -> list[dict]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("""
                SELECT id, filename, content_type, size_bytes, sha256, created_at
                FROM files ORDER BY created_at DESC
            """)]

    def file(self, key: str) -> sqlite3.Row:
        with self.connect() as db:
            row = db.execute("SELECT * FROM files WHERE id=?", (key,)).fetchone()
        if row is None:
            raise MissingAsset("请求附件不存在，请重新选择文件")
        return row

    def delete_file(self, key: str) -> None:
        with self.connect() as db:
            if not db.execute("DELETE FROM files WHERE id=?", (key,)).rowcount:
                raise MissingAsset("附件不存在")
