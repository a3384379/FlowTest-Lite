import argparse
from typing import Annotated, Any, Literal
from uuid import UUID

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field, JsonValue

from app.engine.contracts import WorkflowDefinition, WorkflowEdge, WorkflowNode
from app.models import ApiAsset, ImportOptions, Model, RunOptions, SendOptions, WorkflowAsset
from app.workflow_runtime import validate_definition

Revision = Annotated[int, Field(ge=1, description="最近一次读取到的 revision")]
Offset = Annotated[int, Field(ge=0)]
Limit = Annotated[int, Field(ge=1, le=200)]
Payload = dict[str, Any]

READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
CREATE = ToolAnnotations(destructiveHint=False, idempotentHint=False, openWorldHint=False)
WRITE = ToolAnnotations(destructiveHint=True, idempotentHint=False, openWorldHint=False)
EXECUTE = ToolAnnotations(destructiveHint=True, idempotentHint=False, openWorldHint=True)


class GraphChanges(Model):
    upsert_nodes: list[WorkflowNode] = Field(default_factory=list, description=(
        "按 ID 添加或替换完整节点。HTTP 节点使用 type=api 和 config.api_definition_id。"
        "提取、断言、条件节点在 config 中用 source_node_id 和 JMESPath expression 读取上游结果。"
    ))
    upsert_edges: list[WorkflowEdge] = Field(default_factory=list, description="按 ID 添加或替换完整连线")
    remove_node_ids: list[str] = Field(default_factory=list, description="需要删除的节点 ID")
    remove_edge_ids: list[str] = Field(default_factory=list, description="需要删除的连线 ID，含被删节点的相关连线")


class LiteClient:
    def __init__(self, port: int) -> None:
        self.port = port

    async def request(self, method: str, path: str, *, body: JsonValue = None, revision: int | None = None) -> Any:
        params = {"revision": revision} if revision is not None else None
        try:
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{self.port}/api/",
                timeout=httpx.Timeout(330, connect=3),
                trust_env=False,
            ) as client:
                response = await client.request(method, path, json=body, params=params)
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

    async def for_update(self, path: str, revision: int) -> Payload:
        current = await self.request("GET", path)
        if current["revision"] != revision:
            raise ToolError("FlowTest-Lite HTTP 409：记录已有更新，请重新读取 revision 和内容")
        return {key: value for key, value in current.items() if key not in {"id", "revision", "updated_at"}}


def asset_info(asset: Payload) -> Payload:
    return {key: asset[key] for key in ("id", "name", "revision", "updated_at")}


def api_info(asset: Payload) -> Payload:
    request = asset["request"]
    return {**asset_info(asset), "group": asset["group"], "method": request["method"], "path": request["path"]}


def workflow_info(asset: Payload) -> Payload:
    return {**asset_info(asset), "node_count": len(asset["definition"]["nodes"])}


def page(items: list[Payload], offset: int, limit: int) -> Payload:
    end = offset + limit
    return {"items": items[offset:end], "total": len(items), "next_offset": end if end < len(items) else None}


def edit_items(
    label: str, existing: list[Payload], upserts: list[WorkflowNode] | list[WorkflowEdge], removals: list[str],
) -> list[Payload]:
    by_id = {item["id"]: item for item in existing}
    updated = {item.id: item.model_dump(mode="json") for item in upserts}
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


def run_summary(run: Payload) -> Payload:
    nodes = [{key: value for key, value in node.items() if key != "result"} for node in run["nodes"]]
    return {**run, "nodes": nodes}


def create_server(port: int) -> FastMCP:
    api = LiteClient(port)
    server = FastMCP("FlowTest-Lite", instructions=(
        "管理本机 FlowTest-Lite 保存的接口和流程。查找资源后使用其 ID 操作，更新需要最新 revision。"
        "运行流程返回 run ID，用 workflow_run_get 查状态，按 node_id 读取实际请求、响应和断言。"
    ))

    @server.tool(annotations=READ)
    async def api_list(query: str = "", group: str | None = None, offset: Offset = 0, limit: Limit = 50) -> Payload:
        """分页查找已保存的接口。按名称、路径或描述搜索，可按分组筛选。空字符串分组代表未分组。"""
        query = query.strip().casefold()
        matches = [api_info(asset) for asset in await api.request("GET", "assets/api")
                   if (group is None or asset["group"] == group) and any(
                       query in value.casefold() for value in (asset["name"], asset["request"]["path"], asset["description"])
                   )]
        return page(matches, offset, limit)

    @server.tool(annotations=READ)
    async def api_get(api_id: UUID) -> Payload:
        """读取完整接口定义、提取规则和断言，包含该接口配置的鉴权及请求参数。"""
        return await api.request("GET", f"assets/api/{api_id}")

    @server.tool(annotations=CREATE)
    async def api_create(asset: ApiAsset) -> Payload:
        """创建本地接口。asset.request.path 接受完整 HTTP(S) URL 或相对路径。"""
        return api_info(await api.request("POST", "assets/api", body=asset.model_dump(mode="json")))

    @server.tool(annotations=WRITE)
    async def api_update(api_id: UUID, revision: Revision, changes: dict[str, JsonValue]) -> Payload:
        """修改接口字段。changes 可传 name、group、description、base_url、request。request 按其字段合并，传入的对象或数组整体替换。"""
        if not changes or changes == {"request": {}}:
            raise ToolError("请提供需要修改的接口字段")
        path = f"assets/api/{api_id}"
        current = await api.for_update(path, revision)
        body = {**current, **changes}
        if isinstance(changes.get("request"), dict):
            body["request"] = {**current["request"], **changes["request"]}
        return api_info(await api.request("PUT", path, body=body, revision=revision))

    @server.tool(annotations=WRITE)
    async def api_delete(api_id: UUID) -> Payload:
        """永久删除一个本地接口。引用此接口的流程再次运行时会报找不到接口。"""
        await api.request("DELETE", f"assets/api/{api_id}")
        return {"id": str(api_id), "deleted": True}

    @server.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True))
    async def api_import_preview(source: ImportOptions) -> Payload:
        """预览 cURL、OpenAPI、Postman、HAR 或 Bruno 导入。提供 content 或文档 url，返回待选择的接口和诊断。"""
        return {"candidates": await api.request("POST", "import/preview", body=source.model_dump(mode="json"))}

    @server.tool(annotations=CREATE)
    async def api_import_save(assets: Annotated[list[ApiAsset], Field(min_length=1, max_length=1000)]) -> Payload:
        """保存导入预览中选中的 asset 对象。也可一次新增多条手工定义的接口。"""
        saved = await api.request("POST", "import/save", body=[asset.model_dump(mode="json") for asset in assets])
        return {"items": [api_info(asset) for asset in saved]}

    @server.tool(annotations=READ)
    async def api_preview(api_id: UUID, options: SendOptions | None = None) -> Payload:
        """解析保存的接口和本次变量，查看实际待发 URL、请求头和请求体，无业务 HTTP 请求发出。"""
        return await api.request("POST", f"requests/{api_id}/preview", body=(options or SendOptions()).model_dump(mode="json"))

    @server.tool(annotations=EXECUTE)
    async def api_send(api_id: UUID, options: SendOptions | None = None,
                       detail: Literal["response", "summary", "full"] = "response") -> Payload:
        """发送保存的 HTTP 接口，返回响应、提取值和断言。full 另附实际请求。summary 省略请求和响应体、响应头。"""
        result = await api.request("POST", f"requests/{api_id}/send", body=(options or SendOptions()).model_dump(mode="json"))
        if detail != "full":
            del result["request"]
        if detail == "summary" and result["response"] is not None:
            result["response"] = {key: value for key, value in result["response"].items() if key not in {"body", "headers"}}
        return result

    @server.tool(annotations=READ)
    async def environment_list() -> Payload:
        """列出可用于请求和流程执行的环境 ID 和名称。"""
        return {"items": [asset_info(asset) for asset in await api.request("GET", "assets/environment")]}

    @server.tool(annotations=READ)
    async def workflow_list(query: str = "", offset: Offset = 0, limit: Limit = 50) -> Payload:
        """分页按名称查找流程，返回 ID、当前 revision 和节点数量。"""
        query = query.strip().casefold()
        matches = [workflow_info(asset) for asset in await api.request("GET", "assets/workflow")
                   if query in asset["name"].casefold()]
        return page(matches, offset, limit)

    @server.tool(annotations=READ)
    async def workflow_get(workflow_id: UUID) -> Payload:
        """读取已保存的流程定义、流程输入和 revision。"""
        return await api.request("GET", f"assets/workflow/{workflow_id}")

    @server.tool(annotations=READ)
    async def workflow_validate(definition: WorkflowDefinition) -> Payload:
        """检查流程结构、节点配置和映射，用于保存前校验。接口引用和环境在实际运行时检查。"""
        validate_definition(definition)
        return {"valid": True, "node_count": len(definition.all_nodes())}

    @server.tool(annotations=CREATE)
    async def workflow_create(name: str, definition: WorkflowDefinition | None = None,
                              inputs: dict[str, JsonValue] | None = None) -> Payload:
        """创建并保存流程。省略 definition 时创建从开始直达结束的空流程。"""
        asset = WorkflowAsset(name=name, definition=definition or starter_definition(), inputs=inputs or {})
        return workflow_info(await api.request("POST", "assets/workflow", body=asset.model_dump(mode="json")))

    @server.tool(annotations=WRITE)
    async def workflow_update(workflow_id: UUID, revision: Revision, name: str | None = None,
                              inputs: dict[str, JsonValue] | None = None,
                              definition: WorkflowDefinition | None = None, graph: GraphChanges | None = None) -> Payload:
        """保存流程。可替换完整 definition，或用 graph 按 ID 成组增删改主画布节点和连线。内联区域及流程设置通过 definition 修改。"""
        if definition is not None and graph is not None:
            raise ToolError("definition 和 graph 只能指定一个")
        if all(value is None for value in (name, inputs, definition, graph)):
            raise ToolError("请提供需要修改的流程内容")
        path = f"assets/workflow/{workflow_id}"
        current = await api.for_update(path, revision)
        if name is not None:
            current["name"] = name
        if inputs is not None:
            current["inputs"] = inputs
        if definition is not None:
            current["definition"] = definition.model_dump(mode="json")
        if graph is not None:
            saved = current["definition"]
            saved["nodes"] = edit_items("节点", saved["nodes"], graph.upsert_nodes, graph.remove_node_ids)
            saved["edges"] = edit_items("连线", saved["edges"], graph.upsert_edges, graph.remove_edge_ids)
        return workflow_info(await api.request("PUT", path, body=current, revision=revision))

    @server.tool(annotations=WRITE)
    async def workflow_delete(workflow_id: UUID) -> Payload:
        """永久删除一个本地流程。"""
        await api.request("DELETE", f"assets/workflow/{workflow_id}")
        return {"id": str(workflow_id), "deleted": True}

    @server.tool(annotations=EXECUTE)
    async def workflow_run(workflow_id: UUID, options: RunOptions | None = None) -> Payload:
        """运行当前保存的流程，返回 run ID。传 options 可选择环境或临时流程输入。"""
        return await api.request("POST", f"workflows/{workflow_id}/run", body=(options or RunOptions()).model_dump(mode="json"))

    @server.tool(annotations=READ)
    async def workflow_run_get(run_id: UUID, node_id: str | None = None, include_details: bool = False) -> Payload:
        """查询运行状态。传 node_id 可读取该步的实际请求、响应、输出和断言，也可以显式读取全部详情。"""
        run = await api.request("GET", f"runs/{run_id}")
        if node_id is not None:
            node = next((item for item in run["nodes"] if item["node_id"] == node_id), None)
            if node is None:
                raise ToolError(f"本次运行还没有节点 {node_id} 的记录（状态 {run['status']}）")
            return {"id": run["id"], "workflow_id": run["workflow_id"], "status": run["status"], "node": node}
        return run if include_details else run_summary(run)

    @server.tool(annotations=WRITE)
    async def workflow_run_cancel(run_id: UUID) -> Payload:
        """请求取消当前运行，随后用 workflow_run_get 查询最终状态。"""
        return run_summary(await api.request("POST", f"runs/{run_id}/cancel"))

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="运行 FlowTest-Lite 本地 MCP（stdio）")
    parser.add_argument("--port", type=int, default=8765, help="本地 FlowTest-Lite Web/API 服务端口")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    create_server(args.port).run(transport="stdio")


if __name__ == "__main__":
    main()
