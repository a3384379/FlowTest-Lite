import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from time import perf_counter
from typing import Annotated, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.engine.scheduler import CancellationToken, NodeStatusUpdate
from app.http_runtime import (
    MAX_BODY_BYTES, RequestError, elapsed_ms, http_snapshot, prepare_request, response_checks,
    response_data, send_request,
)
from app.import_assets import parse_import
from app.models import (
    ApiAsset, ApiGroupName, CommonSettings, Environment, ImportOptions, MoveApis, ProjectName,
    RunOptions, SendOptions, WorkflowAsset,
)
from app.projects import DEFAULT_PROJECT_ID, PROJECT_HEADER
from app.service_launcher import (
    FRONTEND_DIST, SERVICE_API_VERSION, SERVICE_NAME, data_directory, data_store_id, frontend_ready,
)
from app.storage import EditConflict, MissingAsset, Store
from app.workflow_runtime import WorkflowPlan, validate_definition

AssetKind = Literal["api", "workflow", "environment"]
ASSET_MODELS = {"api": ApiAsset, "workflow": WorkflowAsset, "environment": Environment}
DIST = FRONTEND_DIST
ASSETS_MOUNTED = (DIST / "assets").is_dir()


@dataclass(slots=True)
class RunState:
    id: str
    workflow_id: str
    project_id: str
    token: CancellationToken
    status: str = "running"
    nodes: dict[str, dict] = field(default_factory=dict)
    error: str | None = None

    def payload(self, *, view: Literal["full", "summary"] = "full", node_id: str | None = None) -> dict:
        if node_id is None:
            nodes = list(self.nodes.values())
        else:
            node = self.nodes.get(node_id)
            if node is None:
                raise MissingAsset(f"本次运行没有节点 {node_id} 的记录（状态 {self.status}）")
            nodes = [node]
        if view == "summary":
            nodes = [{key: value for key, value in node.items() if key != "result"} for node in nodes]
        return {
            "id": self.id, "workflow_id": self.workflow_id, "status": self.status,
            "nodes": nodes, "error": self.error,
        }


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = Store(data_directory() / "library.sqlite3")
    app.state.data_store_id = data_store_id(app.state.store.path)
    app.state.runs = {}
    app.state.tasks = set()
    try:
        yield
    finally:
        for run in app.state.runs.values():
            if run.status == "running":
                run.token.cancel(force=True)
        if app.state.tasks:
            await asyncio.gather(*app.state.tasks, return_exceptions=True)


app = FastAPI(title=SERVICE_NAME, version="0.1.0", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])


@app.middleware("http")
async def local_origin(request: Request, call_next):
    origin = request.headers.get("origin")
    host = request.headers.get("host")
    if request.url.path.startswith("/api/") and origin and origin not in {
        f"{request.url.scheme}://{host}",
    }:
        return JSONResponse(status_code=403, content={"detail": "仅允许本地页面的同源操作"})
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def error_status(error: Exception) -> int:
    if isinstance(error, MissingAsset):
        return 404
    if isinstance(error, EditConflict):
        return 409
    return 422


@app.exception_handler(ValueError)
async def invalid_input(_request: Request, error: ValueError):
    detail = str(error)
    if isinstance(error, ValidationError):
        detail = "；".join(
            f"{'.'.join(map(str, item['loc'])) or '定义'} · {item['msg']}"
            for item in error.errors(include_input=False, include_context=False)
        )
    return JSONResponse(status_code=error_status(error), content={"detail": detail})


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, error: RequestValidationError):
    detail = "；".join(
        f"{'.'.join(map(str, item['loc']))} · {item['msg']}" for item in error.errors()
    )
    return JSONResponse(status_code=422, content={"detail": detail})


def store_of(
    request: Request, project_id: Annotated[UUID | None, Header(alias=PROJECT_HEADER)] = None,
) -> Store:
    return request.app.state.store.for_project(str(project_id or DEFAULT_PROJECT_ID))


ProjectStore = Annotated[Store, Depends(store_of)]


@app.get("/api/health", include_in_schema=False)
def health(request: Request) -> dict:
    return {
        "application": SERVICE_NAME,
        "api_version": SERVICE_API_VERSION,
        "data_store": request.app.state.data_store_id,
        "web_ready": ASSETS_MOUNTED and frontend_ready(),
        "projects": True,
    }


@app.get("/api/projects")
def list_projects(request: Request):
    return request.app.state.store.projects()


@app.post("/api/projects", status_code=201)
def create_project(value: ProjectName, request: Request):
    return request.app.state.store.save_project(value.name)


@app.put("/api/projects/{key}")
def rename_project(key: UUID, value: ProjectName, request: Request):
    return request.app.state.store.save_project(value.name, str(key))


@app.delete("/api/projects/{key}", status_code=204)
async def delete_project(key: UUID, request: Request, delete_contents: bool = False):
    project_id = str(key)
    runs = request.app.state.runs
    project_runs = [run for run in runs.values() if run.project_id == project_id]
    if any(run.status == "running" for run in project_runs):
        raise EditConflict("项目有正在运行的流程，请等待结束或取消运行")
    if project_runs and not delete_contents:
        raise EditConflict("项目中有运行记录。确认一起删除后，请传入 delete_contents=true")
    request.app.state.store.delete_project(project_id, delete_contents=delete_contents)
    for run in project_runs:
        del runs[run.id]


def validated(kind: AssetKind, value: dict, store: Store):
    model = ASSET_MODELS[kind].model_validate(value)
    if isinstance(model, WorkflowAsset):
        requests = validate_definition(model.definition)
        if requests:
            available = store.asset_ids("api")
            for node_id, config in requests.items():
                if str(config.api_definition_id) not in available:
                    raise ValueError(f"节点 {node_id} 引用的接口在当前项目中不存在")
    return model


@app.get("/api/assets/{kind}")
def list_assets(kind: AssetKind, store: ProjectStore):
    return [asset.payload() for asset in store.list(kind)]


@app.post("/api/assets/{kind}", status_code=201)
def create_asset(kind: AssetKind, value: dict, store: ProjectStore):
    return store.create_many(kind, [validated(kind, value, store)])[0].payload()


@app.get("/api/assets/{kind}/{key}")
def get_asset(kind: AssetKind, key: UUID, store: ProjectStore):
    return store.get(kind, str(key)).payload()


@app.put("/api/assets/{kind}/{key}")
def update_asset(
    kind: AssetKind, key: UUID, value: dict, store: ProjectStore, revision: int | None = Query(default=None, ge=1),
):
    return store.put(kind, str(key), validated(kind, value, store), revision).payload()


@app.delete("/api/assets/{kind}/{key}", status_code=204)
def delete_asset(kind: AssetKind, key: UUID, store: ProjectStore, revision: int | None = Query(default=None, ge=1)):
    store.delete(kind, str(key), revision=revision)


@app.get("/api/groups")
def list_api_groups(store: ProjectStore) -> list[str]:
    return store.groups()


@app.put("/api/groups", status_code=204)
def save_api_group(value: ApiGroupName, store: ProjectStore):
    store.put_group(value.name, value.previous)


@app.delete("/api/groups", status_code=204)
def delete_api_group(store: ProjectStore, name: str = Query(min_length=1, max_length=100)):
    store.delete_group(name)


@app.post("/api/groups/move", status_code=204)
def move_apis(value: MoveApis, store: ProjectStore):
    store.move_apis([str(key) for key in value.ids], value.group.strip())


def common_settings(store: Store) -> CommonSettings:
    try:
        return CommonSettings.model_validate(store.get("settings", "common").data)
    except MissingAsset:
        return CommonSettings()


def environment_for(store: Store, key: UUID | None) -> Environment | None:
    if key is None:
        return None
    return Environment.model_validate(store.get("environment", str(key)).data)


@app.get("/api/settings")
def get_settings(store: ProjectStore):
    return common_settings(store)


@app.put("/api/settings")
def update_settings(value: CommonSettings, store: ProjectStore):
    store.put("settings", "common", value, None)
    return value


@app.get("/api/files")
def list_files(store: ProjectStore):
    return store.files()


@app.post("/api/files", status_code=201)
async def upload_file(store: ProjectStore, file: UploadFile = File()):
    content = await file.read(MAX_BODY_BYTES + 1)
    if len(content) > MAX_BODY_BYTES:
        raise HTTPException(413, "单个附件最大 10 MiB")
    filename = (file.filename or "upload").replace("\\", "/").rsplit("/", 1)[-1]
    return store.upload(filename[:250], file.content_type or "application/octet-stream", content)


@app.delete("/api/files/{key}", status_code=204)
def delete_file(key: UUID, store: ProjectStore):
    store.delete_file(str(key))


@app.post("/api/import/preview")
async def import_preview(value: ImportOptions, store: ProjectStore):
    return await parse_import(value, store)


@app.post("/api/import/save", status_code=201)
def import_save(assets: list[ApiAsset], store: ProjectStore):
    if not 1 <= len(assets) <= 1000:
        raise HTTPException(422, "请选择 1–1000 个接口")
    return [item.payload() for item in store.create_many("api", assets)]


@app.post("/api/requests/{key}/preview")
def preview(key: UUID, options: SendOptions, store: ProjectStore):
    asset = ApiAsset.model_validate(store.get("api", str(key)).data)
    prepared = prepare_request(
        asset, common_settings(store), environment_for(store, options.environment_id),
        options.runtime_variables, options.request_overrides,
    )
    return http_snapshot(prepared)


@app.post("/api/requests/{key}/send")
async def send(key: UUID, options: SendOptions, store: ProjectStore):
    asset = ApiAsset.model_validate(store.get("api", str(key)).data)
    common = common_settings(store)
    environment = environment_for(store, options.environment_id)
    start = perf_counter()
    result = {"id": str(uuid4()), "started_at": datetime.now(UTC).isoformat(), "status": "error"}
    prepared = None
    response = None
    data = None
    checks: list[dict] = []
    extracted: dict = {}
    error_code = error_message = None
    try:
        prepared = prepare_request(asset, common, environment, options.runtime_variables, options.request_overrides)
        async with httpx.AsyncClient(follow_redirects=False) as client:
            response = await send_request(client, prepared, store, options.timeout_seconds)
        data = response_data(response, elapsed_ms(start))
        checks, extracted = response_checks(asset, data, response)
        result["status"] = "passed" if all(item["passed"] for item in checks) else "failed"
    except (RequestError, ValueError) as error:
        error_code = error.code if isinstance(error, RequestError) else "INVALID_REQUEST"
        error_message = str(error)
    return {
        "execution": {**result, "elapsed_ms": data["duration_ms"] if data else elapsed_ms(start),
                      "error_code": error_code, "error_message": error_message},
        "request": http_snapshot(prepared, response) if prepared else None,
        "response": data, "assertions": checks, "extracted": extracted,
    }


async def execute_run(plan: WorkflowPlan, run: RunState) -> None:
    async def report(update: NodeStatusUpdate) -> None:
        if update.request_reserved and run.nodes.get(update.node_id, {}).get("status") == "running":
            return
        run.nodes[update.node_id] = {
            "node_id": update.node_id, "name": update.name, "status": update.status,
            "attempts": update.attempts, "started_at": update.started_at,
            "occurred_at": update.occurred_at, "error_code": update.error_code,
            "error_message": update.error_message,
            "result": update.result.model_dump(mode="json") if update.result else None,
        }

    try:
        outcome = await plan.execute(run.token, report)
        run.status = outcome.status
    except Exception as error:
        run.status = "failed"
        run.error = f"流程调度失败（{type(error).__name__}）"


@app.post("/api/workflows/{key}/run", status_code=202)
async def start_run(key: UUID, options: RunOptions, request: Request, store: ProjectStore):
    runs = request.app.state.runs
    tasks = request.app.state.tasks
    if len(tasks) >= 4:
        raise HTTPException(409, "最多同时运行 4 条流程")
    workflow = WorkflowAsset.model_validate(store.get("workflow", str(key)).data)
    plan = WorkflowPlan.prepare(
        workflow, common_settings(store), environment_for(store, options.environment_id),
        workflow.inputs if options.runtime_variables is None else options.runtime_variables, store,
    )
    project_runs = [run for run in runs.values() if run.project_id == store.project_id]
    if len(project_runs) >= 12:
        oldest = next(run for run in project_runs if run.status != "running")
        del runs[oldest.id]
    run = RunState(str(uuid4()), str(key), store.project_id, CancellationToken())
    runs[run.id] = run
    task = asyncio.create_task(execute_run(plan, run))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return run.payload()


@app.get("/api/runs/{key}")
async def get_run(
    key: UUID, request: Request, store: ProjectStore, view: Literal["full", "summary"] = "full",
    node_id: str | None = Query(default=None, min_length=1, max_length=128),
):
    return require_run(key, request, store).payload(view=view, node_id=node_id)


@app.post("/api/runs/{key}/cancel")
async def cancel_run(key: UUID, request: Request, store: ProjectStore, view: Literal["full", "summary"] = "full"):
    run = require_run(key, request, store)
    if run.status == "running":
        run.token.cancel()
    return run.payload(view=view)


def require_run(key: UUID, request: Request, store: Store) -> RunState:
    run = request.app.state.runs.get(str(key))
    if run is None or run.project_id != store.project_id:
        raise MissingAsset("执行结果已过期或不存在")
    return run


if ASSETS_MOUNTED:
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/", include_in_schema=False)
@app.get("/apis", include_in_schema=False)
@app.get("/flows", include_in_schema=False)
def index():
    path = DIST / "index.html"
    if not path.is_file():
        raise HTTPException(503, "请先在 frontend 目录执行 npm ci 和 npm run build")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})
