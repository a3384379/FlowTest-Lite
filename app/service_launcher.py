import errno
import json
import os
import subprocess
import sys
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from time import monotonic, sleep

import httpx

SERVICE_NAME = "FlowTest-Lite"
SERVICE_API_VERSION = 1
DEFAULT_PORT = 8765
APP_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = APP_ROOT / "frontend" / "dist"
STARTUP_SECONDS = 8
PROBE_LIMIT = 256 * 1024


class ServiceLaunchError(RuntimeError):
    pass


def data_directory() -> Path:
    return Path(os.environ.get("FLOWTEST_DATA_DIR") or (Path.home() / ".flowtest-lite")).expanduser().resolve()


def data_store_id(path: Path) -> str:
    # Normalize Windows path casing before comparing the same SQLite file across processes.
    return sha256(os.fsencode(os.path.normcase(str(path.resolve())))).hexdigest()


def frontend_ready() -> bool:
    return (FRONTEND_DIST / "index.html").is_file() and any(
        asset.is_file() for asset in (FRONTEND_DIST / "assets").glob("*.js")
    )


def _read_json(client: httpx.Client, path: str, *, optional: bool = False) -> dict | None:
    with client.stream("GET", path) as response:
        if optional and response.status_code == 404:
            return None
        response.raise_for_status()
        data = bytearray()
        for chunk in response.iter_bytes():
            if len(data) + len(chunk) > PROBE_LIMIT:
                raise ValueError("响应超出服务探测大小")
            data.extend(chunk)
    decoded = json.loads(data)
    if not isinstance(decoded, dict):
        raise ValueError("服务探测响应格式错误")
    return decoded


def _legacy_lite_ready(client: httpx.Client, directory: Path) -> bool:
    schema = _read_json(client, "/openapi.json") or {}
    routes = schema.get("paths")
    info = schema.get("info")
    if not isinstance(info, dict) or info.get("title") != SERVICE_NAME or not isinstance(routes, dict):
        return False
    signature = {"/api/assets/{kind}/{key}", "/api/requests/{key}/send",
                 "/api/workflows/{key}/run", "/api/runs/{key}/cancel", "/api/import/preview"}
    if not signature.issubset(routes):
        return False
    if directory != (Path.home() / ".flowtest-lite").resolve():
        raise ServiceLaunchError("正在运行的旧版 FlowTest-Lite 无法确认数据目录。请使用新版服务或选择其他端口。")
    with client.stream("GET", "/flows") as response:
        if response.status_code != 200 or not response.headers.get("content-type", "").startswith("text/html"):
            raise ServiceLaunchError("正在运行的 FlowTest-Lite 尚未提供页面，请构建前端并重启该服务。")
    return True


def _service_ready(client: httpx.Client, port: int, directory: Path) -> bool:
    try:
        status = _read_json(client, "/api/health", optional=True)
    except httpx.ConnectError:
        return False
    except (httpx.HTTPError, ValueError) as exc:
        raise ServiceLaunchError(f"端口 {port} 上的服务未通过 FlowTest-Lite 校验。请选择其他端口。") from exc
    try:
        if status is None:
            if _legacy_lite_ready(client, directory):
                return True
        elif status.get("application") == SERVICE_NAME:
            if status.get("api_version") != SERVICE_API_VERSION:
                raise ServiceLaunchError(f"端口 {port} 上的 FlowTest-Lite API 版本不兼容。")
            if status.get("data_store") != data_store_id(directory / "library.sqlite3"):
                raise ServiceLaunchError(f"端口 {port} 上的 FlowTest-Lite 使用其他数据目录。请选择相同目录或其他端口。")
            if status.get("web_ready") is not True:
                raise ServiceLaunchError("正在运行的 FlowTest-Lite 尚未提供页面，请构建前端并重启该服务。")
            return True
    except httpx.ConnectError:
        return False
    except (httpx.HTTPError, ValueError) as exc:
        raise ServiceLaunchError(f"端口 {port} 上的服务未通过 FlowTest-Lite 校验。请选择其他端口。") from exc
    raise ServiceLaunchError(f"端口 {port} 已被其他服务占用。请选择其他端口。")


@contextmanager
def _startup_lock(path: Path, deadline: float):
    with path.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt

            def change_lock(acquire: bool) -> None:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK if acquire else msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            def change_lock(acquire: bool) -> None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB if acquire else fcntl.LOCK_UN)

        while True:
            try:
                change_lock(True)
                break
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                if monotonic() >= deadline:
                    raise ServiceLaunchError("等待另一个 FlowTest-Lite 启动超时，请稍后重新连接。") from exc
                sleep(0.08)
        try:
            yield
        finally:
            change_lock(False)


def _start_service(port: int, directory: Path, log_path: Path) -> subprocess.Popen:
    detached = (
        {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt" else {"start_new_session": True}
    )
    log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(log_fd, "wb") as log:
        return subprocess.Popen(
            [sys.executable, "-m", "app", "--port", str(port)],
            cwd=APP_ROOT,
            env={**os.environ, "FLOWTEST_DATA_DIR": str(directory)},
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            **detached,
        )


def ensure_service(port: int) -> None:
    """Reuse a compatible local service or wait for a detached instance to become ready."""
    try:
        directory = data_directory()
        deadline = monotonic() + STARTUP_SECONDS
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=0.7, trust_env=False) as client:
            if _service_ready(client, port, directory):
                return
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            with _startup_lock(directory / f"launch-{port}.lock", deadline):
                if _service_ready(client, port, directory):
                    return
                if not frontend_ready():
                    raise ServiceLaunchError("找不到 FlowTest-Lite 的前端构建产物。请先构建前端或重新准备插件。")
                log_path = directory / f"launch-{port}.log"
                process = _start_service(port, directory, log_path)
                try:
                    while monotonic() < deadline:
                        if _service_ready(client, port, directory):
                            return
                        if process.poll() is not None:
                            break
                        sleep(0.08)
                    raise ServiceLaunchError(f"FlowTest-Lite 未能启动。启动日志位于 {log_path}。")
                except (Exception, KeyboardInterrupt):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                    raise
    except OSError as exc:
        raise ServiceLaunchError(f"无法启动 FlowTest-Lite。{exc}") from exc
