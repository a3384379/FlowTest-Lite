import argparse
import json
import shutil
import subprocess
from pathlib import Path
from tempfile import NamedTemporaryFile

from app.service_launcher import APP_ROOT, DEFAULT_PORT, data_directory, frontend_ready

PLUGIN = "flowtest-lite"
MARKETPLACE = "flowtest-lite-local"
PLUGIN_ID = f"{PLUGIN}@{MARKETPLACE}"
PLUGIN_PATH = Path("plugins") / PLUGIN
MARKETPLACE_PATH = Path(".agents/plugins/marketplace.json")
MANIFEST_PATH = Path(".codex-plugin/plugin.json")
PACKAGE_OWNER = ".flowtest-lite-marketplace.json"


def write_json(path: Path, content: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", dir=path.parent, encoding="utf-8", delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(content, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.close()
            temp.replace(path)
        finally:
            file.close()
            temp.unlink(missing_ok=True)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def package_plugin(root: Path, port: int, data_dir: Path) -> None:
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("找不到 uv。请将 uv 加入 PATH 后重新安装插件。")
    owner = {"package": PLUGIN_ID, "project": str(APP_ROOT)}
    owner_path = root / PACKAGE_OWNER
    manifest = load_json(APP_ROOT / PLUGIN_PATH / MANIFEST_PATH)
    marketplace = {
        "name": MARKETPLACE,
        "interface": {"displayName": "FlowTest-Lite 本地插件"},
        "plugins": [{
            "name": PLUGIN,
            "source": {"source": "local", "path": f"./{PLUGIN_PATH.as_posix()}"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Developer Tools",
        }],
    }
    mcp = {"mcpServers": {PLUGIN: {
        "command": str(Path(uv).absolute()),
        "args": ["run", "--directory", str(APP_ROOT), "--locked", "--extra", "mcp",
                 "python", "-m", "app.mcp_server", "--auto-start", "--port", str(port)],
        "cwd": ".",
        "env": {"FLOWTEST_DATA_DIR": str(data_dir)},
        "startup_timeout_sec": 60,
    }}}
    files = {
        owner_path: owner,
        root / PLUGIN_PATH / MANIFEST_PATH: manifest,
        root / PLUGIN_PATH / ".mcp.json": mcp,
        root / MARKETPLACE_PATH: marketplace,
    }
    if not all(path.resolve() == path for path in files):
        raise RuntimeError(f"插件目录包含符号链接，请选择其他目录。{root}")
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if owner_path.exists():
        previous = load_json(owner_path)
        old_project = previous.get("project") if isinstance(previous, dict) else None
        if not isinstance(old_project, str) or not Path(old_project).is_absolute() or previous.get("package") != PLUGIN_ID:
            raise RuntimeError(f"该插件目录属于不同项目。{root}")
        if Path(old_project) != APP_ROOT and Path(old_project).exists():
            raise RuntimeError(f"插件仍属于现有项目目录 {old_project}，请核对使用的仓库。")
    elif any(root.iterdir()):
        raise RuntimeError(f"插件目录已有其他内容，请选择空目录。{root}")
    catalogue = root / MARKETPLACE_PATH
    if catalogue.exists() and load_json(catalogue) != marketplace:
        raise RuntimeError(f"Marketplace 配置已被修改，请选择空目录。{catalogue}")
    for path, content in files.items():
        write_json(path, content)


def codex_json(codex: str, *args: str) -> dict:
    result = subprocess.run([codex, "plugin", *args, "--json"], cwd=APP_ROOT,
                            capture_output=True, encoding="utf-8", timeout=60, check=False)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or str(result.returncode)
        raise RuntimeError(f"Codex 插件命令失败。{detail}")
    return json.loads(result.stdout)


def marketplace_registered(codex: str, root: Path) -> bool:
    registered = False
    for item in codex_json(codex, "marketplace", "list")["marketplaces"]:
        if item.get("name") != MARKETPLACE:
            continue
        source = item.get("marketplaceSource") or {}
        if source.get("sourceType") != "local" or not item.get("root") or Path(item["root"]).resolve() != root:
            raise RuntimeError(f"Codex 已有同名 marketplace {MARKETPLACE}。请先核对现有来源。")
        registered = True
    for item in codex_json(codex, "list", "--marketplace", MARKETPLACE)["installed"]:
        if item.get("pluginId") != PLUGIN_ID:
            continue
        source = item.get("source") or {}
        if source.get("source") != "local" or not source.get("path") or Path(source["path"]).resolve() != root / PLUGIN_PATH:
            raise RuntimeError(f"Codex 已有同名插件 {PLUGIN_ID}。请先核对现有来源。")
    return registered


def main() -> None:
    parser = argparse.ArgumentParser(description="打包并安装本机 FlowTest-Lite Codex 插件")
    parser.add_argument("--package-only", action="store_true", help="生成本地 marketplace，便于检查或自行安装")
    parser.add_argument("--marketplace-dir", type=Path, default=Path.home() / ".flowtest-lite" / "codex-marketplace")
    parser.add_argument("--data-dir", type=Path, default=data_directory(), help="插件连接的 Lite 数据目录")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="本地 Lite 服务端口")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    if not frontend_ready():
        parser.error("请先执行 npm --prefix frontend ci 和 npm --prefix frontend run build")
    root = args.marketplace_dir.expanduser().resolve()
    try:
        codex = None if args.package_only else shutil.which("codex")
        if codex is None and not args.package_only:
            raise RuntimeError("找不到 Codex CLI。请把 codex 加入 PATH，或使用 --package-only 生成 marketplace。")
        registered = marketplace_registered(codex, root) if codex else False
        package_plugin(root, args.port, args.data_dir.expanduser().resolve())
        if codex:
            if not registered:
                codex_json(codex, "marketplace", "add", str(root))
            codex_json(codex, "add", PLUGIN_ID)
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")
    print(f"Marketplace: {root}")
    if codex:
        print(f"已安装 {PLUGIN_ID}。请在 Codex 新会话中使用 FlowTest-Lite。")


if __name__ == "__main__":
    main()
