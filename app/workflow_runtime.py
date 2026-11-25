import asyncio
import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from time import perf_counter
from typing import cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import jmespath
from jmespath.exceptions import JMESPathError
from pydantic import JsonValue

from app.domain.assertions import compare_values
from app.engine.contracts import (
    CONTROL_CONFIG_MODELS, ApiNodeConfig, InlineControlBody, MappingTargetLocation, NodeStatus,
    NodeType, RetryCategory, WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowPhase,
    control_bodies, parse_control_config, parse_node_config,
)
from app.engine.control_nodes import execute_control_node
from app.engine.mappings import MappingResolutionError, resolve_field_mappings
from app.engine.results import (
    HttpRequestSnapshot, HttpResponseSnapshot, NodeAssertion, NodeInputMapping, NodeObservation,
    NodeResult,
)
from app.engine.scheduler import CancellationToken, ExecutionContext, NodeExecutionError, WorkflowScheduler
from app.engine.structured_control import StructuredControlRunner
from app.http_runtime import (
    PreparedRequest, RequestError, elapsed_ms, http_snapshot, json_text, prepare_request,
    response_checks, response_data, send_request,
)
from app.models import ApiAsset, CommonSettings, Environment, WorkflowAsset
from app.storage import Store


def validate_definition(definition: WorkflowDefinition) -> dict[str, ApiNodeConfig]:
    requests = {}
    for node in definition.all_nodes():
        try:
            if node.bindings:
                raise ValueError("此节点的旧版能力绑定不受支持，请使用连线映射或流程变量")
            if node.capability_id == "flow.control.return":
                raise ValueError("返回调用方节点需要旧版被引用子流程")
            if node.capability_id in CONTROL_CONFIG_MODELS:
                config = parse_control_config(node)
                if any(not isinstance(body, InlineControlBody) for _, body in control_bodies(config)):
                    raise ValueError("流程控制只支持内联子画布")
                continue
            if node.effective_type is NodeType.CAPABILITY:
                raise ValueError(f"不支持的节点 {node.capability_id}@{node.capability_version}")
            config = parse_node_config(node)
            if isinstance(config, ApiNodeConfig):
                if config.service_override or config.endpoint_variant or config.api_version:
                    raise ValueError("节点需引用本地接口，请移除旧平台服务目标或版本绑定")
                requests[node.id] = config
        except ValueError as error:
            raise ValueError(f"节点「{node.name}」({node.id})：{error}") from error
    for edge in (*definition.edges, *(edge for region in definition.regions for edge in region.edges)):
        if edge.mappings and edge.target not in requests:
            raise ValueError(f"连线 {edge.id} 的参数映射需指向 HTTP 节点")
    return requests


def validate_inputs(definition: WorkflowDefinition, values: dict[str, JsonValue]) -> None:
    input_types = {
        "string": (str,), "integer": (int,), "number": (int, float), "boolean": (bool,),
        "object": (dict,), "array": (list,),
    }
    for item in definition.runtime_inputs:
        if item.name not in values:
            if item.required:
                raise ValueError(f"缺少流程输入 {item.name}")
            continue
        value = values[item.name]
        if value is None and item.nullable:
            continue
        if type(value) not in input_types[item.value_type]:
            raise ValueError(f"流程输入 {item.name} 应为 {item.value_type}")


@dataclass(frozen=True, slots=True)
class WorkflowPlan:
    definition: WorkflowDefinition
    requests: dict[str, ApiAsset]
    configs: dict[str, ApiNodeConfig]
    common: CommonSettings
    environment: Environment | None
    inputs: dict[str, JsonValue]
    store: Store

    @classmethod
    def prepare(
        cls, workflow: WorkflowAsset, common: CommonSettings, environment: Environment | None,
        inputs: dict[str, JsonValue], store: Store,
    ) -> "WorkflowPlan":
        configs = validate_definition(workflow.definition)
        validate_inputs(workflow.definition, inputs)
        assets = {item.id: item for item in store.list("api")}
        requests = {}
        for node_id, config in configs.items():
            current = assets.get(str(config.api_definition_id))
            if current is None:
                raise ValueError(f"节点 {node_id} 引用的接口已删除或不存在")
            requests[node_id] = ApiAsset.model_validate(current.data)
        return cls(workflow.definition, requests, configs, common, environment, inputs, store)

    async def execute(self, token: CancellationToken, on_node_status):
        async with httpx.AsyncClient(follow_redirects=False) as client:
            executor = WorkflowNodeExecutor(self, client)
            context = ExecutionContext(
                workflow_variables=dict(self.definition.variables), runtime_variables=self.inputs,
                retry_safe_node_ids=frozenset(
                    node_id for node_id, asset in self.requests.items()
                    if asset.request.method in {"GET", "HEAD", "OPTIONS"}
                ),
            )
            return await WorkflowScheduler(executor).run(
                self.definition, context=context, cancellation=token, on_node_status=on_node_status
            )


class WorkflowNodeExecutor:
    def __init__(self, plan: WorkflowPlan, client: httpx.AsyncClient) -> None:
        self.plan = plan
        self.client = client
        self.mapped_edges: dict[str, list[WorkflowEdge]] = {}
        for edge in (*plan.definition.edges, *(e for r in plan.definition.regions for e in r.edges)):
            if edge.mappings:
                self.mapped_edges.setdefault(edge.target, []).append(edge)

    async def close(self) -> None:
        await self.client.aclose()

    def fork_branch(self) -> "WorkflowNodeExecutor":
        client = httpx.AsyncClient(follow_redirects=False)
        client.cookies.update(self.client.cookies)
        return WorkflowNodeExecutor(self.plan, client)

    async def execute(self, node: WorkflowNode, context: ExecutionContext) -> NodeResult | JsonValue:
        if node.capability_id in CONTROL_CONFIG_MODELS:
            return await StructuredControlRunner(self.plan.definition, self).execute(node, context)
        if node.effective_type is NodeType.API:
            return await self._execute_api(node, context)
        if node.type is NodeType.CAPABILITY:
            node = node.model_copy(update={
                "type": node.effective_type, "config": node.effective_config,
                "capability_id": None, "capability_version": None,
                "configuration": None, "bindings": None,
            })
        result = await execute_control_node(node, context)
        if node.type is NodeType.ASSERT and isinstance(result, dict):
            return NodeResult(status=NodeStatus.PASSED, output=result, assertions=(
                NodeAssertion(name=node.name, passed=True, expected=result.get("expected"),
                              actual=result.get("actual"), message="断言通过"),
            ))
        return result

    async def _execute_api(self, node: WorkflowNode, context: ExecutionContext) -> NodeResult:
        config = self.plan.configs[node.id]
        asset = self.plan.requests[node.id]
        try:
            active_edges = context.active_incoming_edges.get(node.id)
            applicable_edges = (
                edge for edge in self.mapped_edges.get(node.id, ())
                if active_edges is None or edge.id in active_edges
            )
            mappings = resolve_field_mappings(
                (mapping for edge in applicable_edges for mapping in edge.mappings), context,
            )
            bound = {item.key: item.value for item in mappings if item.location is MappingTargetLocation.VARIABLE}
            request = prepare_request(
                asset, self.plan.common, self.plan.environment,
                {**context.resolved_variables(), **bound}, config.request_overrides,
            )
            trace = []
            for mapping in mappings:
                if mapping.location is MappingTargetLocation.QUERY:
                    request = replace(request, url=_set_query(request.url, mapping.key, mapping.value))
                if mapping.location is MappingTargetLocation.HEADER:
                    request.headers[mapping.key.lower()] = json_text(mapping.value)
                if mapping.location is MappingTargetLocation.BODY:
                    request = replace(request, body=_set_body(request.body, mapping.key, mapping.value))
                if mapping.location is MappingTargetLocation.VARIABLE:
                    context.record_variable(
                        mapping.key, mapping.value, node_id=mapping.source_node_id, path=mapping.source_path
                    )
                trace.append(NodeInputMapping(
                    source_node_id=mapping.source_node_id, source_path=mapping.source_path,
                    target_location=mapping.location.value, target_key=mapping.key, value=mapping.value,
                ))
        except (MappingResolutionError, RequestError) as error:
            raise NodeExecutionError(code=error.code, message=str(error)) from error
        except ValueError as error:
            raise NodeExecutionError(code="INVALID_REQUEST", message=str(error)) from error

        polling = config.polling
        started = perf_counter()
        timeout = config.timeout_seconds or self.plan.definition.settings.default_timeout_seconds
        result = NodeResult.passed(None)
        for index in range(polling.max_attempts if polling else 1):
            if index:
                await _claim_polling_request_budget(node, context)
            remaining = polling.timeout_seconds - (perf_counter() - started) if polling else timeout
            if remaining <= 0:
                break
            result = await self._api_attempt(node, asset, request, context, tuple(trace), min(timeout, remaining))
            if not polling or result.status is NodeStatus.FAILED:
                return result
            try:
                actual = jmespath.search(polling.expression, result.output)
                passed = compare_values(actual, polling.expected, polling.operator)
            except (JMESPathError, ValueError, TypeError) as error:
                raise NodeExecutionError(code="INVALID_POLLING", message=str(error)) from error
            if actual in polling.terminal_failure_values:
                raise NodeExecutionError(code="POLLING_TERMINAL_FAILURE", message="轮询收到业务失败终态",
                                         output={**result.output, "actual": actual, "expected": polling.expected})
            if passed:
                return result.model_copy(update={"output": {
                    **result.output, "polling_attempts": index + 1, "polling_value": actual,
                }})
            if index + 1 >= polling.max_attempts or (
                perf_counter() - started + polling.interval_seconds >= polling.timeout_seconds
            ):
                break
            await asyncio.sleep(polling.interval_seconds)
        raise NodeExecutionError(
            code="POLLING_BUDGET_EXHAUSTED", message="未在轮询预算内达到条件",
            output={**(result.output or {}), "expected": polling.expected,
                    "actual": actual if result.output is not None else None},
        )

    async def _api_attempt(
        self, node: WorkflowNode, asset: ApiAsset, request: PreparedRequest, context: ExecutionContext,
        mappings: tuple[NodeInputMapping, ...], timeout: float,
    ) -> NodeResult:
        start = perf_counter()
        started_at = datetime.now(UTC)
        attempt = len(context.observations_of(node.id)) + 1
        try:
            response = await send_request(self.client, request, self.plan.store, timeout)
        except (RequestError, ValueError) as error:
            code = error.code if isinstance(error, RequestError) else "INVALID_REQUEST"
            context.record_observation(node.id, NodeObservation(
                request=HttpRequestSnapshot.model_validate(http_snapshot(request)), attempt=attempt,
                mappings=mappings, started_at=started_at, completed_at=datetime.now(UTC),
                duration_ms=elapsed_ms(start), error_code=code, error_message=str(error)[:1000],
            ))
            raise NodeExecutionError(
                code=code, message=str(error),
                category=RetryCategory.NETWORK_ERROR if code.startswith("NETWORK_") else None,
            ) from error

        duration = elapsed_ms(start)
        output = response_data(response, duration)
        context.record_observation(node.id, NodeObservation(
            request=HttpRequestSnapshot.model_validate(http_snapshot(request, response)),
            response=HttpResponseSnapshot(**{
                key: output[key] for key in ("status_code", "headers", "body", "size_bytes")
            }),
            attempt=attempt, mappings=mappings, started_at=started_at,
            completed_at=datetime.now(UTC), duration_ms=duration,
        ))
        config = self.plan.configs[node.id]
        expected = list(config.expected_statuses) if config.expected_statuses is not None else None
        status = response.status_code
        failed_status = status not in expected if expected is not None else status >= 400
        if failed_status:
            raise NodeExecutionError(
                code="HTTP_UNEXPECTED_STATUS", message=f"收到未预期的 HTTP 状态 {status}",
                category=RetryCategory.SERVER_ERROR if status >= 500 else None,
                output={**output, "expected": expected if expected is not None else "100–399",
                        "actual": status},
            )
        try:
            checks, extracted = response_checks(asset, output, response)
        except RequestError as error:
            raise NodeExecutionError(code=error.code, message=str(error), output=output) from error
        output.update({"extracted": extracted, "assertions": checks})
        failure = next((item for item in checks if not item["passed"]), None)
        if failure is not None:
            return NodeResult.failed(code="HTTP_ASSERTION_FAILED", message=failure["message"][:1000],
                                     output=output).model_copy(update={"assertions": _node_assertions(checks)})
        for name, value in extracted.items():
            context.record_variable(name, value, node_id=node.id, path=f"extracted.{name}")
        return NodeResult(status=NodeStatus.PASSED, output=output, assertions=_node_assertions(checks))


def _node_assertions(checks: list[dict]) -> tuple[NodeAssertion, ...]:
    return tuple(NodeAssertion(
        name=f"{item['kind']} {item['target'] or ''}".strip()[:200],
        passed=item["passed"], expected=item["expected"], actual=item["actual"],
        message=item["message"][:1000],
    ) for item in checks)


def _set_query(url: str, key: str, value: JsonValue) -> str:
    parsed = urlsplit(url)
    query = [(name, current) for name, current in parse_qsl(parsed.query, keep_blank_values=True)
             if name != key]
    query.append((key, json_text(value)))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


async def _claim_polling_request_budget(node: WorkflowNode, context: ExecutionContext) -> None:
    budget = context.request_budget
    if budget is not None and not budget.claim():
        is_cleanup = node.phase is WorkflowPhase.CLEANUP
        raise NodeExecutionError(
            code="CLEANUP_REQUEST_BUDGET_EXHAUSTED" if is_cleanup else "REQUEST_BUDGET_EXHAUSTED",
            message="清理请求预算已耗尽" if is_cleanup else "请求预算已耗尽",
        )
    reserve = context.request_reservers.get(node.id)
    if reserve is not None:
        # Await durable acknowledgement before issuing the next outbound request.
        await reserve()


def _set_body(body: JsonValue, path: str, value: JsonValue) -> JsonValue:
    if not isinstance(body, dict):
        raise MappingResolutionError(
            code="MAPPING_TARGET_INVALID",
            message="Body 映射要求目标请求体为 JSON 对象",
        )
    root = _copy_json_object(body)
    current = root
    parts = path.split(".")
    for part in parts[:-1]:
        nested = current.get(part)
        if nested is None:
            nested = {}
            current[part] = nested
        if not isinstance(nested, dict):
            raise MappingResolutionError(
                code="MAPPING_TARGET_INVALID",
                message=f"Body 映射路径 {path} 与现有值冲突",
            )
        current = nested
    current[parts[-1]] = value
    return cast(JsonValue, root)


def _copy_json_object(value: dict[str, JsonValue]) -> dict[str, JsonValue]:
    return cast(dict[str, JsonValue], json.loads(json.dumps(value)))
