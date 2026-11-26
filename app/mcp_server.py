import argparse
import asyncio
import hmac
import json
import secrets
import sys
import webbrowser
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field, JsonValue

from app.engine.contracts import NodeNote, WorkflowDefinition, WorkflowEdge, WorkflowNode
from app.mcp_views import (
    api_auth_key, api_definition_view, http_view, masked_assertions, masked_fields, masked_parameters, masked_url,
    run_node_view, workflow_overrides,
)
from app.mcp_workbench import WORKBENCH_NAME, WORKBENCH_TOOL_META, register_workbench_resource
from app.models import ApiAsset, ImportOptions, Model, ProjectName, RunOptions, SendOptions, WorkflowAsset
from app.projects import DEFAULT_PROJECT_ID, PROJECT_HEADER
from app.service_launcher import (
    DEFAULT_PORT, SERVICE_API_VERSION, SERVICE_NAME, ServiceLaunchError, data_directory, data_store_id, ensure_service,
)
from app.workflow_runtime import validate_definition

Revision = Annotated[int, Field(ge=1, description="最近一次读取到的 revision")]
Offset = Annotated[int, Field(ge=0)]
Limit = Annotated[int, Field(ge=1, le=200)]
ImportAssets = Annotated[list[ApiAsset], Field(min_length=1, max_length=1000)]
ImportIndices = Annotated[list[Annotated[int, Field(ge=0)]], Field(min_length=1, max_length=1000)]
ProjectId = Annotated[UUID | None, Field(description="project_list 返回的项目 ID。省略时使用默认项目。")]
NodeNotes = Annotated[dict[Annotated[str, Field(min_length=1, max_length=128)], NodeNote], Field(
    min_length=1, max_length=200, description="按节点 ID 修改备注，支持主画布和子画布。空字符串清除备注。",
)]
Payload = dict[str, Any]

READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
CREATE = ToolAnnotations(destructiveHint=False, idempotentHint=False, openWorldHint=False)
WRITE = ToolAnnotations(destructiveHint=True, idempotentHint=False, openWorldHint=False)
EXECUTE = ToolAnnotations(destructiveHint=True, idempotentHint=False, openWorldHint=True)
OPEN = ToolAnnotations(destructiveHint=False, idempotentHint=False, openWorldHint=False)


class GraphChanges(Model):
    upsert_nodes: list[WorkflowNode] = Field(default_factory=list, description=(
        "按 ID 添加或替换完整节点。HTTP 节点使用 type=api 和 config.api_definition_id。"
        "提取、断言、条件节点在 config 中用 source_node_id 和 JMESPath expression 读取上游结果。"
    ))
    upsert_edges: list[WorkflowEdge] = Field(default_factory=list, description="按 ID 添加或替换完整连线")
    remove_node_ids: list[str] = Field(default_factory=list, description="需要删除的节点 ID")
    remove_edge_ids: list[str] = Field(default_factory=list, description="需要删除的连线 ID，含被删节点的相关连线")


class LiteClient:
    def __init__(self, port: int, auto_start: bool) -> None:
        self.port = port
        self.auto_start = auto_start
        self.origin = f"http://127.0.0.1:{port}"
        self.expected_store = data_store_id(data_directory() / "library.sqlite3") if auto_start else None

    async def ready(self) -> None:
        try:
            await asyncio.to_thread(ensure_service, self.port)
        except ServiceLaunchError as error:
            raise ToolError(str(error)) from error

    async def request(
        self, method: str, path: str, *, body: JsonValue = None, params: dict[str, str | int] | None = None,
        project_id: UUID | None = None,
    ) -> Any:
        if self.auto_start:
            await self.ready()
        try:
            async with httpx.AsyncClient(
                base_url=f"{self.origin}/api/",
                timeout=httpx.Timeout(330, connect=3),
                trust_env=False,
            ) as client:
                scoped = project_id is not None or path.split("/", 1)[0] == "projects"
                if scoped or (method != "GET" and not path.endswith("/preview")):
                    await self.verify_target(client, require_projects=scoped)
                headers = {PROJECT_HEADER: str(project_id)} if project_id is not None else None
                response = await client.request(method, path, json=body, params=params, headers=headers)
        except httpx.ConnectError as error:
            raise ToolError(f"无法连接 FlowTest-Lite。请先运行 uv run --locked python -m app --port {self.port}") from error
        except httpx.RequestError as error:
            raise ToolError(f"FlowTest-Lite API 请求中断（{type(error).__name__}），请核对服务状态和操作结果") from error
        if response.status_code == 204:
            return None
        try:
            payload = response.json()
        except ValueError as error:
            raise ToolError(f"FlowTest-Lite API 未返回 JSON（HTTP {response.status_code}）") from error
        if not response.is_success:
            detail = payload.get("detail") if isinstance(payload, dict) else None
            raise ToolError(f"FlowTest-Lite HTTP {response.status_code}：{detail or '请求失败'}")
        return payload

    async def for_update(self, path: str, revision: int, project_id: UUID | None) -> Payload:
        current = await self.request("GET", path, project_id=project_id)
        if current["revision"] != revision:
            raise ToolError("FlowTest-Lite HTTP 409：记录已有更新，请重新读取 revision 和内容")
        return {key: value for key, value in current.items() if key not in {"id", "revision", "updated_at"}}

    async def verify_target(self, client: httpx.AsyncClient, *, require_projects: bool) -> None:
        response = await client.get("health", timeout=3)
        try:
            health = response.json() if response.is_success else None
        except ValueError:
            health = None
        if (not isinstance(health, dict) or health.get("application") != SERVICE_NAME
                or health.get("api_version") != SERVICE_API_VERSION):
            raise ToolError("当前运行的 Lite 版本不支持此操作。请重启 Lite 加载新版。")
        if self.expected_store is not None and health.get("data_store") != self.expected_store:
            raise ToolError("当前 Lite 的数据目录与插件配置不同，请核对端口和数据目录。")
        if require_projects and health.get("projects") is not True:
            raise ToolError("当前运行的 Lite 尚不支持项目隔离。请重启 Lite 加载新版。")


def asset_info(asset: Payload) -> Payload:
    return {key: asset[key] for key in ("id", "name", "revision", "updated_at")}


def api_info(asset: Payload) -> Payload:
    request = asset["request"]
    return {**asset_info(asset), "group": asset["group"], "method": request["method"],
            "path": masked_url(request["path"], api_auth_key(asset))}


def workflow_info(asset: Payload) -> Payload:
    return {**asset_info(asset), "node_count": len(asset["definition"]["nodes"])}


def page(items: list[Payload], offset: int, limit: int) -> Payload:
    end = offset + limit
    return {"items": items[offset:end], "total": len(items), "next_offset": end if end < len(items) else None}


def edit_items(
    label: str, existing: list[Payload], upserts: list[WorkflowNode] | list[WorkflowEdge], removals: list[str],
) -> list[Payload]:
    by_id = {item["id"]: item for item in existing}
    updated = {}
    for item in upserts:
        value = item.model_dump(mode="json")
        if isinstance(item, WorkflowNode) and item.id in by_id and "note" not in item.model_fields_set:
            value["note"] = by_id[item.id].get("note", "")
        updated[item.id] = value
    removing = set(removals)
    if len(updated) != len(upserts) or len(removing) != len(removals) or removing.intersection(updated):
        raise ToolError(f"{label}变更含重复 ID 或同时更新和删除的 ID")
    missing = removing.difference(by_id)
    if missing:
        raise ToolError(f"找不到要删除的{label}：{', '.join(sorted(missing))}")
    for item_id in removing:
        del by_id[item_id]
    by_id.update(updated)
    return list(by_id.values())


def starter_definition() -> WorkflowDefinition:
    return WorkflowDefinition.model_validate({
        "nodes": [
            {"id": "start", "name": "开始", "type": "start", "position": {"x": 100, "y": 160}},
            {"id": "end", "name": "结束", "type": "end", "position": {"x": 296, "y": 160}},
        ],
        "edges": [{"id": "start-end", "source": "start", "target": "end"}],
    })


def run_summary(run: Payload, *, include_sensitive: bool = False) -> Payload:
    nodes = [{key: value for key, value in node.items() if key != "result"} for node in run["nodes"]]
    if not include_sensitive:
        for node in nodes:
            if node.get("error_code") == "HTTP_ASSERTION_FAILED":
                node["error_message"] = "HTTP 断言失败，可按 node_id 查看断言明细"
    return {**run, "nodes": nodes}


def create_server(port: int, *, auto_start: bool = False, codex_app: bool = False) -> FastMCP:
    api = LiteClient(port, auto_start)
    preview_key = secrets.token_bytes(32)

    def import_preview_id(candidates: list[Payload], project_id: UUID | None) -> str:
        content = json.dumps([str(project_id or DEFAULT_PROJECT_ID), candidates], ensure_ascii=True,
                             sort_keys=True, separators=(",", ":"))
        return hmac.digest(preview_key, content.encode("ascii"), "sha256").hex()

    server = FastMCP(SERVICE_NAME, log_level="WARNING", instructions=(
        "管理本机 FlowTest-Lite 保存的接口和流程。用 project_list 查项目，后续工具传同一个 project_id。"
        "查找资源后使用其 ID 操作，更新和删除接口或流程需要最新 revision。"
        + ("用户要求在 Codex 中打开工作台时调用 workbench_view。"
           if codex_app else "")
        + "用户要求在浏览器打开工作台时调用 workbench_open 并将 open_browser 设为 true。"
        "运行流程返回 run ID，用 workflow_run_get 查状态，按 node_id 读取实际请求、响应和断言。"
    ))

    if codex_app:
        register_workbench_resource(server)

        @server.tool(title=WORKBENCH_NAME, annotations=READ, meta=WORKBENCH_TOOL_META)
        async def workbench_view() -> Payload:
            """在 Codex 内打开 FlowTest-Lite 接口和流程工作台。"""
            return {"opened": True}

    @server.tool(annotations=OPEN)
    async def workbench_open(page: Literal["apis", "flows"] = "apis", open_browser: bool = True,
                             asset_id: UUID | None = None, project_id: ProjectId = None) -> Payload:
        """启动或复用 Lite。可用 asset_id 直达接口或流程，open_browser=true 时打开默认浏览器。"""
        await api.ready()
        url = f"{api.origin}/{page}"
        query = []
        if project_id is not None:
            projects = await api.request("GET", "projects")
            if not any(item["id"] == str(project_id) for item in projects):
                raise ToolError("项目不存在")
            query.append(f"project={project_id}")
        if asset_id is not None:
            query.append(f"id={asset_id}")
        if query:
            url += "?" + "&".join(query)
        opened = False
        if open_browser:
            try:
                opened = await asyncio.to_thread(webbrowser.open, url, new=2)
            except (webbrowser.Error, OSError):
                pass
        return {"url": url, "opened": opened}

    @server.tool(annotations=READ)
    async def project_list() -> Payload:
        """列出本机项目，返回其他工具可用的 project_id。"""
        return {"items": await api.request("GET", "projects"), "default_project_id": str(DEFAULT_PROJECT_ID)}

    @server.tool(annotations=CREATE)
    async def project_create(name: str) -> Payload:
        """新建空项目，返回项目名称与 ID。"""
        return await api.request("POST", "projects", body=ProjectName(name=name).model_dump())

    @server.tool(annotations=WRITE)
    async def project_rename(project_id: UUID, name: str) -> Payload:
        """修改项目名称，保留项目 ID 及项目内的资产。"""
        return await api.request("PUT", f"projects/{project_id}", body=ProjectName(name=name).model_dump())

    @server.tool(annotations=WRITE)
    async def project_delete(
        project_id: UUID, delete_contents: Annotated[bool, Field(
            description="确认一并永久删除项目内的接口、流程、环境、分组、公共配置、附件和运行记录。",
        )] = False,
    ) -> Payload:
        """删除指定项目。默认只删除空项目。带数据的项目需显式指定 delete_contents=true。"""
        await api.request("DELETE", f"projects/{project_id}", params={"delete_contents": str(delete_contents).lower()})
        return {"id": str(project_id), "deleted": True}

    @server.tool(annotations=READ)
    async def api_list(query: str = "", group: str | None = None, offset: Offset = 0, limit: Limit = 50, project_id: ProjectId = None) -> Payload:
        """分页查找已保存的接口。按名称、路径或描述搜索，可按分组筛选。空字符串分组代表未分组。"""
        query = query.strip().casefold()
        matches = [api_info(asset) for asset in await api.request("GET", "assets/api", project_id=project_id)
                   if (group is None or asset["group"] == group) and any(
                       query in value.casefold() for value in (asset["name"], asset["request"]["path"], asset["description"])
                   )]
        return page(matches, offset, limit)

    @server.tool(annotations=READ)
    async def api_get(api_id: UUID, include_sensitive: bool = False, project_id: ProjectId = None) -> Payload:
        """读取接口定义、提取规则和断言。默认隐藏专用鉴权配置和常见凭据字段，修改时只提交目标字段。"""
        asset = await api.request("GET", f"assets/api/{api_id}", project_id=project_id)
        return asset if include_sensitive else api_definition_view(asset)

    @server.tool(annotations=CREATE)
    async def api_create(asset: ApiAsset, project_id: ProjectId = None) -> Payload:
        """创建本地接口。asset.request.path 接受完整 HTTP(S) URL 或相对路径。"""
        return api_info(await api.request("POST", "assets/api", body=asset.model_dump(mode="json"), project_id=project_id))

    @server.tool(annotations=WRITE)
    async def api_update(api_id: UUID, revision: Revision, changes: dict[str, JsonValue], project_id: ProjectId = None) -> Payload:
        """修改接口字段。changes 可传 name、group、description、base_url、request。request 按其字段合并，传入的对象或数组整体替换。"""
        if not changes or changes == {"request": {}}:
            raise ToolError("请提供需要修改的接口字段")
        path = f"assets/api/{api_id}"
        current = await api.for_update(path, revision, project_id)
        body = {**current, **changes}
        if isinstance(changes.get("request"), dict):
            body["request"] = {**current["request"], **changes["request"]}
        return api_info(await api.request("PUT", path, body=body, params={"revision": revision}, project_id=project_id))

    @server.tool(annotations=WRITE)
    async def api_delete(api_id: UUID, revision: Revision, project_id: ProjectId = None) -> Payload:
        """按最新版本删除一个本地接口。引用此接口的流程再次运行时会报找不到接口。"""
        await api.request("DELETE", f"assets/api/{api_id}", params={"revision": revision}, project_id=project_id)
        return {"id": str(api_id), "deleted": True}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True))
    async def api_import_preview(source: ImportOptions, include_sensitive: bool = False, project_id: ProjectId = None) -> Payload:
        """预览 cURL、OpenAPI、Postman、HAR 或 Bruno。返回候选及 preview_id。按原 source、preview_id 和从 0 起的 indices 保存原始定义。"""
        candidates = await api.request("POST", "import/preview", body=source.model_dump(mode="json"), project_id=project_id)
        preview_id = import_preview_id(candidates, project_id)
        if not include_sensitive:
            candidates = [{**item, "asset": api_definition_view(item["asset"])} for item in candidates]
        return {"preview_id": preview_id, "candidates": candidates}

    @server.tool(annotations=ToolAnnotations(destructiveHint=False, idempotentHint=False, openWorldHint=True))
    async def api_import_save(assets: ImportAssets | None = None, source: ImportOptions | None = None,
                              preview_id: str | None = None, indices: ImportIndices | None = None, project_id: ProjectId = None) -> Payload:
        """提供 source、preview_id 及 indices，保存选中接口的完整原值，文档变化需重新预览。也可只传完整 assets 批量新增。"""
        if assets is not None:
            if any(item is not None for item in (source, preview_id, indices)):
                raise ToolError("请单独传完整 assets，或传 source、preview_id 和 indices")
            definitions = [asset.model_dump(mode="json") for asset in assets]
        else:
            if source is None or not preview_id or indices is None:
                raise ToolError("请选择导入来源 source、preview_id 和候选下标 indices")
            candidates = await api.request("POST", "import/preview", body=source.model_dump(mode="json"), project_id=project_id)
            if not hmac.compare_digest(preview_id.encode(), import_preview_id(candidates, project_id).encode()):
                raise ToolError("导入预览已过期或内容已变化，请重新预览后选择")
            if len(set(indices)) != len(indices) or max(indices) >= len(candidates):
                raise ToolError("导入候选下标重复或超出预览范围")
            definitions = [candidates[index]["asset"] for index in indices]
        saved = await api.request("POST", "import/save", body=definitions, project_id=project_id)
        return {"items": [api_info(asset) for asset in saved]}

    @server.tool(annotations=READ)
    async def api_preview(api_id: UUID, options: SendOptions | None = None, include_sensitive: bool = False, project_id: ProjectId = None) -> Payload:
        """查看待发 URL、请求头和请求体。默认隐藏常见凭据及接口配置的 API Key，无业务 HTTP 请求发出。"""
        preview = await api.request("POST", f"requests/{api_id}/preview", body=(options or SendOptions()).model_dump(mode="json"), project_id=project_id)
        return preview if include_sensitive else http_view(preview, preview.get("auth_key_name"))

    @server.tool(annotations=EXECUTE)
    async def api_send(api_id: UUID, options: SendOptions | None = None, include_sensitive: bool = False,
                       detail: Literal["response", "summary", "full"] = "response", project_id: ProjectId = None) -> Payload:
        """发送保存的接口，返回响应、提取和断言。full 另附实际请求，默认遮蔽常见鉴权值。summary 省略请求、响应体和响应头。"""
        result = await api.request("POST", f"requests/{api_id}/send", body=(options or SendOptions()).model_dump(mode="json"), project_id=project_id)
        custom = (result["request"] or {}).get("auth_key_name")
        if not include_sensitive:
            result["extracted"] = masked_fields(result["extracted"], custom)
            result["assertions"] = masked_assertions(result["assertions"], custom)
        if detail != "full":
            del result["request"]
        elif result["request"] is not None and not include_sensitive:
            result["request"] = http_view(result["request"], custom)
        response = result["response"]
        if response is not None:
            if detail == "summary":
                result["response"] = {key: value for key, value in response.items() if key not in {"body", "headers"}}
            elif not include_sensitive:
                result["response"] = http_view(response, custom)
        return result

    @server.tool(annotations=READ)
    async def environment_list(project_id: ProjectId = None) -> Payload:
        """列出可用于请求和流程执行的环境 ID 和名称。"""
        return {"items": [asset_info(asset) for asset in await api.request("GET", "assets/environment", project_id=project_id)]}

    @server.tool(annotations=READ)
    async def workflow_list(query: str = "", offset: Offset = 0, limit: Limit = 50, project_id: ProjectId = None) -> Payload:
        """分页按名称查找流程，返回 ID、当前 revision 和节点数量。"""
        query = query.strip().casefold()
        matches = [workflow_info(asset) for asset in await api.request("GET", "assets/workflow", project_id=project_id)
                   if query in asset["name"].casefold()]
        return page(matches, offset, limit)

    @server.tool(annotations=READ)
    async def workflow_get(workflow_id: UUID, include_sensitive: bool = False, project_id: ProjectId = None) -> Payload:
        """读取流程定义、输入和 revision，默认遮蔽常见凭据和 HTTP 覆盖中的鉴权值。完整替换定义或输入时请使用原值。"""
        asset = await api.request("GET", f"assets/workflow/{workflow_id}", project_id=project_id)
        if include_sensitive:
            return asset
        definition = asset["definition"]
        asset["inputs"] = masked_fields(asset["inputs"])
        definition["variables"] = masked_fields(definition["variables"])
        overrides = list(workflow_overrides(definition))
        if overrides:
            keys = {
                item["id"]: api_auth_key(item)
                for item in await api.request("GET", "assets/api", project_id=project_id)
            }
            for api_id, fields in overrides:
                custom = keys.get(api_id)
                if fields.get("headers"):
                    fields["headers"] = masked_fields(fields["headers"], custom)
                if fields.get("query_parameters"):
                    fields["query_parameters"] = masked_parameters(fields["query_parameters"], custom)
        return asset

    @server.tool(annotations=READ)
    async def workflow_validate(definition: WorkflowDefinition) -> Payload:
        """检查流程结构、节点配置和映射，用于保存前校验。接口引用在保存时检查，环境在实际运行时检查。"""
        validate_definition(definition)
        return {"valid": True, "node_count": len(definition.all_nodes())}

    @server.tool(annotations=CREATE)
    async def workflow_create(name: str, definition: WorkflowDefinition | None = None,
                              inputs: dict[str, JsonValue] | None = None, project_id: ProjectId = None) -> Payload:
        """创建并保存流程。省略 definition 时创建从开始直达结束的空流程。"""
        asset = WorkflowAsset(name=name, definition=definition or starter_definition(), inputs=inputs or {})
        return workflow_info(await api.request("POST", "assets/workflow", body=asset.model_dump(mode="json"), project_id=project_id))

    @server.tool(annotations=WRITE)
    async def workflow_update(
        workflow_id: UUID, revision: Revision, name: str | None = None, inputs: dict[str, JsonValue] | None = None,
        definition: WorkflowDefinition | None = None, graph: GraphChanges | None = None,
        project_id: ProjectId = None, node_notes: NodeNotes | None = None,
    ) -> Payload:
        """保存流程。node_notes 按 ID 修改主画布和子画布节点备注。也可替换完整 definition，或用 graph 修改主画布节点和连线。"""
        if definition is not None and graph is not None:
            raise ToolError("definition 和 graph 只能指定一个")
        if all(value is None for value in (name, inputs, definition, graph, node_notes)):
            raise ToolError("请提供需要修改的流程内容")
        path = f"assets/workflow/{workflow_id}"
        current = await api.for_update(path, revision, project_id)
        if name is not None:
            current["name"] = name
        if inputs is not None:
            current["inputs"] = inputs
        if definition is not None:
            current["definition"] = definition.model_dump(mode="json")
        saved = current["definition"]
        if graph is not None:
            saved["nodes"] = edit_items("节点", saved["nodes"], graph.upsert_nodes, graph.remove_node_ids)
            saved["edges"] = edit_items("连线", saved["edges"], graph.upsert_edges, graph.remove_edge_ids)
        if node_notes is not None:
            nodes_by_id = {node["id"]: node for scope in [saved, *saved.get("regions", [])] for node in scope["nodes"]}
            unknown = node_notes.keys() - nodes_by_id.keys()
            if unknown:
                raise ToolError(f"找不到要修改备注的节点：{', '.join(sorted(unknown))}")
            for node_id, note in node_notes.items():
                nodes_by_id[node_id]["note"] = note
        return workflow_info(await api.request("PUT", path, body=current, params={"revision": revision}, project_id=project_id))

    @server.tool(annotations=WRITE)
    async def workflow_delete(workflow_id: UUID, revision: Revision, project_id: ProjectId = None) -> Payload:
        """按最新版本删除一个本地流程。"""
        await api.request("DELETE", f"assets/workflow/{workflow_id}", params={"revision": revision}, project_id=project_id)
        return {"id": str(workflow_id), "deleted": True}

    @server.tool(annotations=EXECUTE)
    async def workflow_run(workflow_id: UUID, options: RunOptions | None = None, project_id: ProjectId = None) -> Payload:
        """运行当前保存的流程，返回 run ID。传 options 可选择环境或临时流程输入。"""
        return await api.request("POST", f"workflows/{workflow_id}/run", body=(options or RunOptions()).model_dump(mode="json"), project_id=project_id)

    @server.tool(annotations=READ)
    async def workflow_run_get(run_id: UUID, node_id: str | None = None, include_details: bool = False,
                               include_sensitive: bool = False, project_id: ProjectId = None) -> Payload:
        """查询运行状态。传 node_id 可读取该步的请求、响应、输出和断言。全部详情和常见鉴权值均需显式开启。"""
        params = {"view": "full" if node_id is not None or include_details else "summary"}
        if node_id is not None:
            params["node_id"] = node_id
        run = await api.request("GET", f"runs/{run_id}", params=params, project_id=project_id)
        if node_id is not None:
            node = next((item for item in run["nodes"] if item["node_id"] == node_id), None)
            if node is None:
                raise ToolError(f"本次运行还没有节点 {node_id} 的记录（状态 {run['status']}）")
            return {"id": run["id"], "workflow_id": run["workflow_id"], "status": run["status"],
                    "node": node if include_sensitive else run_node_view(node)}
        if not include_details:
            return run_summary(run, include_sensitive=include_sensitive)
        return run if include_sensitive else {**run, "nodes": [run_node_view(item) for item in run["nodes"]]}

    @server.tool(annotations=WRITE)
    async def workflow_run_cancel(run_id: UUID, project_id: ProjectId = None) -> Payload:
        """请求取消当前运行，随后用 workflow_run_get 查询最终状态。"""
        return run_summary(await api.request("POST", f"runs/{run_id}/cancel", params={"view": "summary"}, project_id=project_id))

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="运行 FlowTest-Lite 本地 MCP（stdio）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="本地 FlowTest-Lite Web/API 服务端口")
    parser.add_argument("--auto-start", action="store_true", help="连接时自动启动或复用本地工作台")
    parser.add_argument("--codex-app", action="store_true", help="提供 Codex 全屏工作台")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    if args.auto_start:
        try:
            ensure_service(args.port)
        except ServiceLaunchError as error:
            # Keep tool discovery available. Calls will surface the startup failure and can retry it.
            print(error, file=sys.stderr)
    create_server(args.port, auto_start=args.auto_start, codex_app=args.codex_app).run(transport="stdio")


if __name__ == "__main__":
    main()
