import asyncio
import json
import re
from base64 import b64encode
from dataclasses import dataclass
from hashlib import sha256
from time import perf_counter
from typing import cast
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx
from pydantic import JsonValue

from app.domain.api_assets import (
    TEMPLATE_PATTERN, AuthKind, BodyKind, merge_headers, render_json, render_template,
)
from app.domain.assertions import AssertionSpec, AssertionKind, ResponseSnapshot, evaluate_assertions
from app.domain.scopes import HeaderScope, ResolvedValue, VariableScope, resolve_variables
from app.engine.contracts import ApiNodeMultipartBody, ApiNodeRequestOverrides
from app.models import ApiAsset, CommonSettings, Environment
from app.storage import Store

MAX_BODY_BYTES = 10 * 1024 * 1024


class RequestError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(slots=True)
class ResponseContent:
    response: httpx.Response
    body: httpx.Response

    @property
    def status_code(self) -> int:
        return self.response.status_code

    @property
    def content(self) -> bytes:
        return self.body.content

    @property
    def headers(self) -> httpx.Headers:
        return self.response.headers

    @property
    def request(self) -> httpx.Request:
        return self.response.request


@dataclass(slots=True)
class PreparedRequest:
    method: str
    url: str
    headers: dict[str, str]
    body_kind: BodyKind
    body: JsonValue


def json_text(value: JsonValue) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def validate_http_url(url: str) -> str:
    try:
        parsed = httpx.URL(url)
    except (httpx.InvalidURL, httpx.UnsupportedProtocol) as error:
        raise RequestError("INVALID_URL", "HTTP URL 无效") from error
    if parsed.scheme not in ("http", "https") or not parsed.host or parsed.userinfo:
        raise RequestError("INVALID_URL", "请输入 HTTP(S) 地址，鉴权请使用 Auth 或 Headers")
    return str(parsed.copy_with(fragment=None))


def _request_url(
    path: str, base_url: str, variables: dict[str, ResolvedValue]
) -> tuple[str, list[tuple[str, str]]]:
    # Encode values placed in path segments. URL templates may also set the origin.
    path = path.partition("#")[0]
    leading = TEMPLATE_PATTERN.match(path)
    if leading:
        value = variables.get(leading[1])
        if value and value.value.startswith(("http://", "https://")):
            path = value.value.rstrip("/") + path[leading.end():]
    absolute = re.match(r"^([A-Za-z][A-Za-z0-9+.-]*://[^/?#]*)(.*)$", path)
    if absolute:
        origin = render_template(absolute[1], variables)
        raw_path = absolute[2]
    else:
        origin = render_template(base_url, variables).rstrip("/")
        raw_path = path
    segment, _, raw_query = raw_path.partition("?")
    segment = TEMPLATE_PATTERN.sub(
        lambda match: quote(render_template(match[0], variables), safe=""), segment
    )
    url = validate_http_url(f"{origin}/{segment.lstrip('/')}")
    query = parse_qsl(raw_query, keep_blank_values=True)
    return url, [(render_template(k, variables), render_template(v, variables)) for k, v in query]


def prepare_request(
    asset: ApiAsset,
    common: CommonSettings,
    environment: Environment | None,
    workflow_variables: dict[str, JsonValue],
    overrides: ApiNodeRequestOverrides,
) -> PreparedRequest:
    request = asset.request
    variables = resolve_variables({
        VariableScope.GLOBAL: common.variables,
        VariableScope.ENVIRONMENT: environment.variables if environment else {},
        VariableScope.API: request.variables,
        VariableScope.RUNTIME: {key: json_text(value) for key, value in workflow_variables.items()},
    })
    base = (environment.base_url if environment else "") or asset.base_url or common.base_url
    url, query = _request_url(request.path, base, variables)
    suppressed_query = set(overrides.suppressed_query_parameters)
    params = request.query_parameters if overrides.query_parameters is None else overrides.query_parameters
    query.extend(
        (render_template(row.name, variables), render_template(row.value, variables))
        for row in params if row.enabled and row.name not in suppressed_query
    )
    query = [(name, value) for name, value in query if name not in suppressed_query]
    merged = merge_headers({
        HeaderScope.PROJECT: common.headers,
        HeaderScope.ENVIRONMENT: environment.headers if environment else {},
        HeaderScope.API: {} if overrides.replace_headers else request.headers,
        HeaderScope.RUNTIME: overrides.headers or {},
    })
    suppressed_headers = {name.lower() for name in overrides.suppressed_headers}
    headers = {
        name: render_template(header.value, variables)
        for name, header in merged.items() if name not in suppressed_headers
    }
    _remove_cookies(headers, set(overrides.suppressed_cookies))
    if overrides.effective_auth_mode != "disabled":
        _apply_auth(request.auth_kind, request.auth_config, headers, query, variables)
        for name in suppressed_headers:
            headers.pop(name, None)
        _remove_cookies(headers, set(overrides.suppressed_cookies))
        query = [(name, value) for name, value in query if name not in suppressed_query]
    parsed = urlsplit(url)
    url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query, doseq=True), ""))
    body_kind = overrides.body.kind if overrides.body else request.body_kind
    body = overrides.body.value if overrides.body else request.body
    return PreparedRequest(request.method.value, url, headers, body_kind, render_json(body, variables))


def _remove_cookies(headers: dict[str, str], suppressed: set[str]) -> None:
    if "cookie" not in headers or not suppressed:
        return
    remaining = [
        part.strip() for part in headers.pop("cookie").split(";")
        if part.split("=", 1)[0].strip() not in suppressed
    ]
    if remaining:
        headers["cookie"] = "; ".join(remaining)


def _request_payload(request: PreparedRequest, store: Store) -> dict:
    if request.body_kind is BodyKind.NONE:
        return {}
    if request.body_kind is BodyKind.JSON:
        return {"json": request.body} if request.body is not None else {"content": b"null"}
    if request.body_kind is BodyKind.RAW:
        return {"content": json_text(request.body) if request.body is not None else ""}
    if request.body_kind is BodyKind.FORM:
        if not isinstance(request.body, dict):
            raise RequestError("INVALID_FORM", "表单请求体必须是对象")
        return {"data": request.body}
    payload = ApiNodeMultipartBody.model_validate(request.body)
    files = [(name, (None, value)) for name, value in payload.fields.items()]
    size = sum(len(value.encode()) for value in payload.fields.values())
    for reference in payload.files:
        item = store.file(str(reference.artifact_id))
        size += item["size_bytes"]
        if size > MAX_BODY_BYTES:
            raise RequestError("REQUEST_TOO_LARGE", "请求附件总大小超过 10 MiB")
        files.append((reference.field, (item["filename"], item["content"], item["content_type"])))
    if not files:
        raise RequestError("EMPTY_MULTIPART", "请添加 multipart 字段或文件")
    request.headers.pop("content-type", None)
    return {"files": files}


async def send_request(
    client: httpx.AsyncClient, request: PreparedRequest, store: Store, timeout: float
) -> ResponseContent:
    """Send the locally prepared request and bound the decoded response size."""
    request.url = validate_http_url(request.url)
    try:
        payload = _request_payload(request, store)
        if request.body_kind is BodyKind.JSON:
            request.headers.setdefault("content-type", "application/json")
        async with asyncio.timeout(timeout):
            async with client.stream(
                request.method, request.url, headers=request.headers, timeout=timeout, **payload
            ) as response:
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(chunks) + len(chunk) > MAX_BODY_BYTES:
                        raise RequestError("RESPONSE_TOO_LARGE", "响应体超过 10 MiB")
                    chunks.extend(chunk)
                return ResponseContent(response, httpx.Response(
                    response.status_code, content=bytes(chunks),
                    default_encoding=response.encoding or "utf-8",
                ))
    except (TimeoutError, httpx.TimeoutException) as error:
        raise RequestError("NETWORK_TIMEOUT", "目标接口请求超时") from error
    except httpx.HTTPError as error:
        raise RequestError("NETWORK_ERROR", f"请求失败（{type(error).__name__}）") from error


def http_snapshot(request: PreparedRequest, response: ResponseContent | None = None) -> dict:
    return {
        "method": response.request.method if response is not None else request.method,
        "url": str(response.request.url) if response is not None else request.url,
        "headers": dict(response.request.headers) if response is not None else request.headers,
        "body": request.body,
    }


def elapsed_ms(started: float) -> float:
    return round((perf_counter() - started) * 1000, 2)


def response_data(response: ResponseContent, duration_ms: float) -> dict:
    return {
        "status_code": response.status_code,
        "headers": dict(response.headers),
        "body": _response_body(response.body),
        "duration_ms": duration_ms,
        "size_bytes": len(response.content),
    }


def response_checks(asset: ApiAsset, data: dict, response: ResponseContent) -> tuple[list[dict], dict]:
    snapshot = ResponseSnapshot(
        status_code=data["status_code"], elapsed_ms=data["duration_ms"],
        headers=data["headers"], body=data["body"], content_size=data["size_bytes"],
        content_type=response.headers.get("content-type", ""),
        content_sha256=sha256(response.content).hexdigest(),
    )
    specs = tuple(AssertionSpec(**item.model_dump()) for item in asset.request.assertions)
    outcomes = evaluate_assertions(snapshot, specs)
    checks = [
        {"id": str(i), "kind": outcome.spec.kind.value, "target": outcome.spec.target,
         "operator": outcome.spec.operator.value, "expected": outcome.spec.expected,
         "actual": outcome.actual, "passed": outcome.passed, "message": outcome.message}
        for i, outcome in enumerate(outcomes)
    ]
    kinds = {"header": AssertionKind.HEADER, "jsonpath": AssertionKind.JSONPATH,
             "jmespath": AssertionKind.JMESPATH}
    rules = asset.request.extraction_rules
    extractions = evaluate_assertions(snapshot, tuple(
        AssertionSpec(kind=kinds[rule.kind.value], target=rule.expression, expected=None)
        for rule in rules
    ))
    for rule, extracted in zip(rules, extractions, strict=True):
        if extracted.message.startswith("断言配置或取值失败"):
            raise RequestError("EXTRACTION_ERROR", f"{rule.name}：{extracted.message}")
    return checks, {
        rule.name: extracted.actual for rule, extracted in zip(rules, extractions, strict=True)
    }


def _apply_auth(
    auth_kind: str,
    auth_config: dict[str, str],
    headers: dict[str, str],
    query: list[tuple[str, str]],
    variables: dict[str, ResolvedValue],
) -> None:
    if auth_kind == AuthKind.NONE.value:
        return
    if auth_kind == AuthKind.BEARER.value:
        token = render_template(auth_config.get("token", ""), variables)
        headers["authorization"] = f"Bearer {token}"
        return
    if auth_kind == AuthKind.BASIC.value:
        username = render_template(auth_config.get("username", ""), variables)
        password = render_template(auth_config.get("password", ""), variables)
        encoded = b64encode(f"{username}:{password}".encode()).decode()
        headers["authorization"] = f"Basic {encoded}"
        return
    name = auth_config.get("name", "x-api-key")
    value = render_template(auth_config.get("value", ""), variables)
    location = auth_config.get("in", "header")
    if location == "query":
        query.append((name, value))
    elif location == "cookie":
        existing = headers.get("cookie")
        headers["cookie"] = f"{existing}; {name}={value}" if existing else f"{name}={value}"
    else:
        headers[name.lower()] = value


def _response_body(response: httpx.Response) -> JsonValue:
    if not response.content:
        return None
    try:
        return cast(JsonValue, response.json())
    except ValueError:
        return response.text
