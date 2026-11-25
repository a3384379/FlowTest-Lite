from dataclasses import asdict

import json

import httpx
import yaml

from app.http_runtime import send_request, validate_http_url, PreparedRequest
from app.domain.api_assets import BodyKind
from app.importers.contracts import ImportSourceType
from app.importers.http_formats import parse_bruno, parse_curl, parse_har
from app.importers.openapi import parse_openapi
from app.importers.openapi_dialects import source_dialect
from app.importers.postman import parse_postman
from app.models import ApiAsset, ImportOptions, RequestDefinition
from app.storage import Store


async def parse_import(options: ImportOptions, store: Store) -> list[dict]:
    url = None
    if options.url:
        url = validate_http_url(options.url)
        async with httpx.AsyncClient(follow_redirects=True, max_redirects=3) as client:
            response = await send_request(client, PreparedRequest("GET", url, {}, BodyKind.NONE, None), store, 30)
        if not 200 <= response.status_code < 300:
            raise ValueError(f"读取文档失败（HTTP {response.status_code}）")
        content = response.content
        url = str(response.request.url)
    else:
        content = options.content.encode()
    kind = ImportSourceType(options.source_type)
    if kind is ImportSourceType.CURL or (
        kind is ImportSourceType.AUTO and content.decode("utf-8-sig").lstrip().lower().startswith("curl ")
    ):
        operations = parse_curl(content)
    elif kind is ImportSourceType.BRUNO:
        try:
            document = json.loads(content)
        except json.JSONDecodeError:
            document = None
        operations = parse_bruno(content, document if isinstance(document, dict) else None)
    else:
        try:
            document = yaml.safe_load(content)
        except yaml.YAMLError as error:
            raise ValueError("导入文档的 JSON 或 YAML 格式无效") from error
        if not isinstance(document, dict):
            raise ValueError("导入文档应为 JSON 或 YAML 对象")
        _validate_tree(document)
        if kind is ImportSourceType.HAR or (kind is ImportSourceType.AUTO and "log" in document):
            operations = parse_har(document)
        elif kind is ImportSourceType.POSTMAN or (
            kind is ImportSourceType.AUTO and "info" in document and "item" in document
        ):
            operations = parse_postman(document)
        else:
            dialect = source_dialect(document)
            kind = ImportSourceType.SWAGGER2 if dialect.startswith("SWAGGER") else ImportSourceType.OPENAPI3
            operations = parse_openapi(document, kind, document_url=url)
    if not operations:
        raise ValueError("文档中没有可导入的 HTTP 操作")
    if len(operations) > 1000:
        raise ValueError("每次最多导入 1000 个接口")
    return [{
        "asset": ApiAsset(
            name=operation.name[:200], description=operation.description[:2000],
            base_url=operation.target_base_url or "",
            request=RequestDefinition.model_validate(asdict(operation.request)),
        ).model_dump(mode="json"),
        "diagnostics": [asdict(item) for item in operation.diagnostics],
    } for operation in operations]


def _validate_tree(root: dict) -> None:
    pending = [(root, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if count > 200_000 or depth > 100:
            raise ValueError("导入文档结构过大或包含递归别名")
        if isinstance(node, dict):
            if any(not isinstance(key, (str, int)) for key in node):
                raise ValueError("导入文档的属性名必须是字符串或数字")
            pending.extend((child, depth + 1) for child in node.values())
        elif isinstance(node, list):
            pending.extend((child, depth + 1) for child in node)
