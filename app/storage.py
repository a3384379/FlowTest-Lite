from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from copy import copy
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel

from app.projects import DEFAULT_PROJECT_ID

SCOPED_TABLES = {
    "assets": ("""
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (project_id, kind, id)
        """, "kind, id, revision, updated_at, data"),
    "api_groups": ("name TEXT NOT NULL, PRIMARY KEY (project_id, name)", "name"),
    "files": ("""
        id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content BLOB NOT NULL,
        PRIMARY KEY (project_id, id)
        """, "id, filename, content_type, size_bytes, sha256, created_at, content"),
}


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
        self.project_id = str(DEFAULT_PROJECT_ID)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            db.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT NOT NULL PRIMARY KEY,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE
                )
                """)
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (self.project_id,)).fetchone():
                db.execute("INSERT INTO projects (id, name) VALUES (?, ?)", (self.project_id, "默认项目"))
            for table, (schema, columns) in SCOPED_TABLES.items():
                existing = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
                if "project_id" in existing:
                    continue
                if existing:
                    db.execute(f"ALTER TABLE {table} RENAME TO {table}_before_projects")
                db.execute(f"CREATE TABLE {table} (project_id TEXT NOT NULL REFERENCES projects(id), {schema})")
                if existing:
                    db.execute(
                        f"INSERT INTO {table} (project_id, {columns}) "
                        f"SELECT ?, {columns} FROM {table}_before_projects", (self.project_id,),
                    )
                    db.execute(f"DROP TABLE {table}_before_projects")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def for_project(self, project_id: str) -> Store:
        if project_id == self.project_id:
            return self
        with self.connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise MissingAsset("项目不存在")
        scoped = copy(self)
        scoped.project_id = project_id
        return scoped

    def projects(self) -> list[dict]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT id, name FROM projects ORDER BY id != ?, name", (
                str(DEFAULT_PROJECT_ID),
            ))]

    def save_project(self, name: str, project_id: str | None = None) -> dict:
        try:
            with self.connect() as db:
                if project_id is None:
                    project_id = str(uuid4())
                    db.execute("INSERT INTO projects (id, name) VALUES (?, ?)", (project_id, name))
                elif not db.execute("UPDATE projects SET name=? WHERE id=?", (name, project_id)).rowcount:
                    raise MissingAsset("项目不存在")
        except sqlite3.IntegrityError as error:
            raise EditConflict("已有同名项目") from error
        return {"id": project_id, "name": name}

    @staticmethod
    def asset(row: sqlite3.Row | None) -> StoredAsset:
        if row is None:
            raise MissingAsset("记录不存在")
        return StoredAsset(row["id"], row["revision"], row["updated_at"], json.loads(row["data"]))

    def list(self, kind: str) -> list[StoredAsset]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM assets WHERE project_id=? AND kind=? ORDER BY updated_at DESC, id",
                (self.project_id, kind),
            ).fetchall()
        return [self.asset(row) for row in rows]

    def get(self, kind: str, key: str) -> StoredAsset:
        with self.connect() as db:
            return self.asset(db.execute(
                "SELECT * FROM assets WHERE project_id=? AND kind=? AND id=?", (self.project_id, kind, key)
            ).fetchone())

    def asset_ids(self, kind: str) -> set[str]:
        with self.connect() as db:
            return {row["id"] for row in db.execute(
                "SELECT id FROM assets WHERE project_id=? AND kind=?", (self.project_id, kind),
            )}

    def create_many(self, kind: str, items: list[BaseModel]) -> list[StoredAsset]:
        now = datetime.now(UTC).isoformat()
        rows = [(kind, str(uuid4()), 1, now, item.model_dump_json()) for item in items]
        with self.connect() as db:
            db.executemany(
                "INSERT INTO assets (project_id, kind, id, revision, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)",
                ((self.project_id, *row) for row in rows),
            )
        return [StoredAsset(key, rev, stamp, json.loads(data)) for _, key, rev, stamp, data in rows]

    def put(self, kind: str, key: str, item: BaseModel, revision: int | None) -> StoredAsset:
        now = datetime.now(UTC).isoformat()
        data = item.model_dump_json()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT revision FROM assets WHERE project_id=? AND kind=? AND id=?", (self.project_id, kind, key)
            ).fetchone()
            if old is None and kind != "settings":
                raise MissingAsset("记录不存在")
            previous = old["revision"] if old else 0
            if revision is not None and revision != previous:
                raise EditConflict("记录已有更新，请重新加载后保存")
            version = previous + 1
            db.execute("""
                INSERT INTO assets (project_id, kind, id, revision, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id,kind,id) DO UPDATE SET
                    revision=excluded.revision, updated_at=excluded.updated_at, data=excluded.data
                """, (self.project_id, kind, key, version, now, data))
        return StoredAsset(key, version, now, json.loads(data))

    def delete(self, kind: str, key: str, *, revision: int | None = None) -> None:
        with self.connect() as db:
            deleted = db.execute(
                "DELETE FROM assets WHERE project_id=? AND kind=? AND id=? AND (? IS NULL OR revision=?)",
                (self.project_id, kind, key, revision, revision),
            )
            if deleted.rowcount:
                return
            if revision is not None and db.execute(
                "SELECT 1 FROM assets WHERE project_id=? AND kind=? AND id=?", (self.project_id, kind, key),
            ).fetchone() is not None:
                raise EditConflict("记录已有更新，请重新加载后删除")
            raise MissingAsset("记录不存在")

    def groups(self) -> list[str]:
        with self.connect() as db:
            rows = db.execute("""
                SELECT name FROM api_groups WHERE project_id=?
                UNION
                SELECT json_extract(data, '$.group') FROM assets
                WHERE project_id=? AND kind='api' AND coalesce(json_extract(data, '$.group'), '') != ''
                ORDER BY 1
            """, (self.project_id, self.project_id)).fetchall()
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
                db.execute("DELETE FROM api_groups WHERE project_id=? AND name=?", (self.project_id, previous))
            db.execute("INSERT OR IGNORE INTO api_groups (project_id, name) VALUES (?, ?)", (self.project_id, name))

    def delete_group(self, name: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._move_group(db, name, "")
            db.execute("DELETE FROM api_groups WHERE project_id=? AND name=?", (self.project_id, name))

    def _group_exists(self, db: sqlite3.Connection, name: str) -> bool:
        return db.execute("""
            SELECT 1 FROM api_groups WHERE project_id=? AND name=?
            UNION ALL
            SELECT 1 FROM assets WHERE project_id=? AND kind='api' AND json_extract(data, '$.group')=?
            LIMIT 1
        """, (self.project_id, name, self.project_id, name)).fetchone() is not None

    def _move_group(self, db: sqlite3.Connection, previous: str, name: str) -> None:
        db.execute("""
            UPDATE assets
            SET data=json_set(data, '$.group', ?), revision=revision + 1
            WHERE project_id=? AND kind='api' AND json_extract(data, '$.group') = ? AND ? != ?
        """, (name, self.project_id, previous, name, previous))

    def move_apis(self, keys: list[str], name: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for key in keys:
                result = db.execute("""
                    UPDATE assets
                    SET data=json_set(data, '$.group', ?), revision=revision + 1
                    WHERE project_id=? AND kind='api' AND id=? AND json_extract(data, '$.group') IS NOT ?
                """, (name, self.project_id, key, name))
                if not result.rowcount and db.execute(
                    "SELECT 1 FROM assets WHERE project_id=? AND kind='api' AND id=?", (self.project_id, key)
                ).fetchone() is None:
                    raise MissingAsset("有接口已删除，请刷新目录后重试")
            if name:
                db.execute("INSERT OR IGNORE INTO api_groups (project_id, name) VALUES (?, ?)", (self.project_id, name))

    def upload(self, filename: str, content_type: str, content: bytes) -> dict:
        row = {
            "id": str(uuid4()), "filename": filename, "content_type": content_type,
            "size_bytes": len(content), "sha256": sha256(content).hexdigest(),
            "created_at": datetime.now(UTC).isoformat(),
        }
        with self.connect() as db:
            db.execute("""
                INSERT INTO files (project_id, id, filename, content_type, size_bytes, sha256, created_at, content)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (self.project_id, *row.values(), content))
        return row

    def files(self) -> list[dict]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("""
                SELECT id, filename, content_type, size_bytes, sha256, created_at
                FROM files WHERE project_id=? ORDER BY created_at DESC
            """, (self.project_id,))]

    def file(self, key: str) -> sqlite3.Row:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM files WHERE project_id=? AND id=?", (self.project_id, key),
            ).fetchone()
        if row is None:
            raise MissingAsset("请求附件不存在，请重新选择文件")
        return row

    def delete_file(self, key: str) -> None:
        with self.connect() as db:
            if not db.execute("DELETE FROM files WHERE project_id=? AND id=?", (self.project_id, key)).rowcount:
                raise MissingAsset("附件不存在")
