import re
from collections.abc import Mapping
from dataclasses import replace
from typing import Literal, cast
from urllib.parse import urljoin, urlsplit

from app.domain.api_assets import (
    APIVersionSpec,
    AuthKind,
    BodyKind,
    HttpMethod,
    JsonValue,
    QueryParameterSpec,
)
from app.domain.parameter_identity import parameter_identity
from app.importers.contracts import (
    ImportedOperation,
    ImportSourceType,
    empty_request,
    imported_value,
)
from app.importers.openapi_adapter import OperationAdapter
from app.importers.openapi_normalization import SourceNormalizer, pointer

HTTP_METHODS = {method.value.lower(): method for method in HttpMethod}


def parse_openapi(
    document: Mapping[str, object],
    source_type: ImportSourceType,
    *,
    document_url: str | None = None,
) -> tuple[ImportedOperation, ...]:
    paths = _mapping(document.get("paths"))
    schemes = _security_schemes(document, source_type)
    base_path = _swagger_base_path(document, source_type)
    default_security = _sequence(document.get("security"))
    operations: list[ImportedOperation] = []
    for raw_path, path_value in paths.items():
        path_normalizer = SourceNormalizer(document, "", raw_path, None)
        path_item, _, _ = path_normalizer.resolve(path_value, pointer("#/paths", raw_path), "$")
        common_parameters = _sequence(path_item.get("parameters"))
        for method_name, method in HTTP_METHODS.items():
            raw_operation = path_item.get(method_name)
            if not isinstance(raw_operation, Mapping):
                continue
            normalizer = SourceNormalizer(
                document, method.value, raw_path, _text(raw_operation.get("operationId")) or None
            )
            for diagnostic in path_normalizer.diagnostics:
                normalizer.diagnostics.append(
                    replace(diagnostic, method=method.value, operation_id=normalizer.operation_id)
                )
            normalizer.partial = path_normalizer.partial
            operation = OperationAdapter(
                normalizer, pointer("#/paths", raw_path) + "/" + method_name
            ).prepare(dict(raw_operation), common_parameters)
            target_base_url = _server_url(
                {
                    **document,
                    "servers": operation.get(
                        "servers", path_item.get("servers", document.get("servers"))
                    ),
                },
                source_type,
                document_url=document_url,
                normalizer=normalizer,
            )
            _security_diagnostics(operation, schemes, default_security, normalizer)
            parameters = _sequence(operation.get("parameters"))
            request = _operation_request(
                method=method,
                path=f"{base_path}{raw_path}",
                operation=operation,
                parameters=parameters,
                schemes=schemes,
                default_security=default_security,
                source_type=source_type,
            )
            if any(d.code == "SECURITY_REQUIRES_CONFIGURATION" for d in normalizer.diagnostics):
                request = replace(request, auth_kind=AuthKind.NONE, auth_config={})
            name = _operation_name(operation, method, raw_path)
            description = _text(operation.get("description")) or _text(operation.get("summary"))
            operations.append(
                ImportedOperation(
                    name=name,
                    description=description,
                    request=request,
                    target_base_url=target_base_url,
                    diagnostics=tuple(normalizer.diagnostics),
                )
            )
    return tuple(operations)


def _operation_request(
    *,
    method: HttpMethod,
    path: str,
    operation: Mapping[str, object],
    parameters: list[object],
    schemes: Mapping[str, object],
    default_security: list[object],
    source_type: ImportSourceType,
) -> APIVersionSpec:
    request = empty_request(method=method, path=_template_path(path))
    query: list[QueryParameterSpec] = []
    headers: dict[str, str] = {}
    variables: dict[str, str] = {}
    for raw_parameter in parameters:
        parameter = _mapping(raw_parameter)
        location = _text(parameter.get("in"))
        name = _text(parameter.get("name"))
        if not name:
            continue
        value = _parameter_value(parameter, name)
        if location == "query":
            query.extend(_query_values(parameter, name, value))
        elif location == "path" and value:
            variables[name] = value
        elif location == "header":
            headers[name] = imported_value(name, value)
    body_kind, body = _body(operation, parameters, source_type)
    content_type = _request_content_type(operation, parameters, source_type)
    if content_type and body_kind not in {BodyKind.NONE, BodyKind.MULTIPART}:
        headers["Content-Type"] = content_type
    auth_kind, auth_config = _auth(operation, schemes, default_security)
    return replace(
        request,
        query_parameters=tuple(query),
        headers=headers,
        variables=variables,
        body_kind=body_kind,
        body=body,
        auth_kind=auth_kind,
        auth_config=auth_config,
    )


def _body(
    operation: Mapping[str, object],
    parameters: list[object],
    source_type: ImportSourceType,
) -> tuple[BodyKind, JsonValue]:
    if source_type is ImportSourceType.OPENAPI3:
        return _openapi3_body(operation)
    return _swagger_body(operation, parameters)


def _openapi3_body(operation: Mapping[str, object]) -> tuple[BodyKind, JsonValue]:
    request_body = _mapping(operation.get("requestBody"))
    content = _mapping(request_body.get("content"))
    for media_type, raw_media in list(content.items())[:1]:
        media = _mapping(raw_media)
        example = _example(media)
        if media_type == "application/json" or media_type.endswith("+json"):
            return BodyKind.JSON, example
        if media_type == "application/x-www-form-urlencoded":
            return BodyKind.FORM, example if isinstance(example, dict) else {}
        if media_type == "multipart/form-data":
            properties = _mapping(_mapping(media.get("schema")).get("properties"))
            fields = {
                name: value
                for name, value in _mapping(example).items()
                if _mapping(properties.get(name)).get("format") != "binary"
            }
            return BodyKind.MULTIPART, {"fields": cast(dict[str, JsonValue], fields), "files": []}
        if media_type.startswith("text/"):
            return BodyKind.RAW, example if isinstance(example, str) else ""
    return BodyKind.NONE, None


def _swagger_body(
    operation: Mapping[str, object], parameters: list[object]
) -> tuple[BodyKind, JsonValue]:
    content_type = _swagger_content_type(operation, parameters)
    form_values: dict[str, JsonValue] = {}
    has_file = False
    for raw_parameter in parameters:
        parameter = _mapping(raw_parameter)
        if parameter.get("in") == "body":
            media_type = _swagger_content_type(operation, parameters)
            return _openapi3_body(
                {"requestBody": {"content": {media_type: {"example": _example(parameter)}}}}
            )
        if parameter.get("in") == "formData":
            name = _text(parameter.get("name"))
            if not name:
                continue
            has_file = has_file or _mapping(parameter.get("schema")).get("format") == "binary"
            if _mapping(parameter.get("schema")).get("format") != "binary":
                form_values[name] = _parameter_value(parameter, name)
    if has_file or content_type == "multipart/form-data":
        return BodyKind.MULTIPART, {"fields": form_values, "files": []}
    if form_values:
        return BodyKind.FORM, form_values
    return BodyKind.NONE, None


def _security_schemes(
    document: Mapping[str, object], source_type: ImportSourceType
) -> Mapping[str, object]:
    if source_type is ImportSourceType.SWAGGER2:
        return _mapping(document.get("securityDefinitions"))
    components = _mapping(document.get("components"))
    return _mapping(components.get("securitySchemes"))


def _auth(
    operation: Mapping[str, object],
    schemes: Mapping[str, object],
    default_security: list[object],
) -> tuple[AuthKind, dict[str, str]]:
    security = _sequence(operation.get("security")) if "security" in operation else default_security
    if not security:
        return AuthKind.NONE, {}
    requirement = _mapping(security[0])
    if not requirement:
        return AuthKind.NONE, {}
    scheme_name = next(iter(requirement))
    scheme = _mapping(schemes.get(scheme_name))
    scheme_type = _text(scheme.get("type"))
    http_scheme = _text(scheme.get("scheme")).lower()
    if scheme_type == "http" and http_scheme == "bearer":
        return AuthKind.BEARER, {"token": f"{{{{secret.{scheme_name}}}}}"}
    if (scheme_type == "http" and http_scheme == "basic") or scheme_type == "basic":
        return AuthKind.BASIC, {
            "username": f"{{{{secret.{scheme_name}_USERNAME}}}}",
            "password": f"{{{{secret.{scheme_name}_PASSWORD}}}}",
        }
    if scheme_type == "apiKey":
        return AuthKind.API_KEY, {
            "name": _text(scheme.get("name")) or "X-API-Key",
            "in": _text(scheme.get("in")) or "header",
            "value": f"{{{{secret.{scheme_name}}}}}",
        }
    return AuthKind.NONE, {}


def _example(value: Mapping[str, object]) -> JsonValue:
    if "example" in value:
        return _json_value(value.get("example"))
    examples = _mapping(value.get("examples"))
    if examples:
        example = _mapping(examples[sorted(examples)[0]])
        if "value" in example:
            return _json_value(example["value"])
    schema = _mapping(value.get("schema"))
    if "example" in schema:
        return _json_value(schema.get("example"))
    return _schema_example(schema)


def _schema_example(schema: Mapping[str, object]) -> JsonValue:
    schema_type = _text(schema.get("type"))
    if schema_type == "object":
        return {
            name: _schema_example(_mapping(raw_property))
            for name, raw_property in _mapping(schema.get("properties")).items()
        }
    if schema_type == "array":
        return [_schema_example(_mapping(schema.get("items")))]
    if schema_type in {"integer", "number"}:
        return 0
    if schema_type == "boolean":
        return False
    return ""


def _parameter_value(parameter: Mapping[str, object], name: str) -> str:
    example = parameter.get("example", parameter.get("default"))
    return str(example) if example is not None else f"{{{{{name}}}}}"


def _operation_name(operation: Mapping[str, object], method: HttpMethod, path: str) -> str:
    return (
        _text(operation.get("summary"))
        or _text(operation.get("operationId"))
        or f"{method.value} {path}"
    )[:200]


def _swagger_base_path(document: Mapping[str, object], source_type: ImportSourceType) -> str:
    if source_type is not ImportSourceType.SWAGGER2:
        return ""
    value = _text(document.get("basePath"))
    return value.rstrip("/") if value and value != "/" else ""


def _server_url(
    document: Mapping[str, object],
    source_type: ImportSourceType,
    *,
    document_url: str | None = None,
    normalizer: SourceNormalizer | None = None,
) -> str | None:
    if source_type is ImportSourceType.OPENAPI3:
        return _openapi_server(document, document_url)
    if source_type is not ImportSourceType.SWAGGER2:
        return None
    host = _text(document.get("host"))
    if not host:
        return None
    schemes = _sequence(document.get("schemes"))
    scheme = _text(schemes[0]) if schemes else urlsplit(document_url or "").scheme
    if not schemes and normalizer is not None:
        normalizer.warn(
            "#/schemes",
            "$.server",
            "schemes",
            "SERVER_SCHEME_FROM_SOURCE"
            if scheme in {"http", "https"}
            else "SERVER_REQUIRES_CONFIGURATION",
            "协议取自文档下载地址, 执行时以用户环境为准"
            if scheme in {"http", "https"}
            else "未猜测协议, 请选择执行环境",
        )
    if scheme not in {"http", "https"}:
        return None
    return f"{scheme}://{host}{_swagger_base_path(document, source_type)}".rstrip("/")


def _template_path(path: str) -> str:
    return re.sub(r"\{([A-Za-z_][A-Za-z0-9_.-]*)\}", r"{{\1}}", path)


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in value.items() if isinstance(key, str)}


def _sequence(value: object) -> list[object]:
    return list(value) if isinstance(value, list) else []


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _json_value(value: object) -> JsonValue:
    return cast(JsonValue, value)


def _swagger_content_type(operation: Mapping[str, object], parameters: list[object]) -> str:
    consumes = _sequence(operation.get("consumes"))
    form = [_mapping(item) for item in parameters if _mapping(item).get("in") == "formData"]
    preferred = "application/json"
    if form:
        has_file = any(_mapping(item.get("schema")).get("format") == "binary" for item in form)
        preferred = "multipart/form-data" if has_file else "application/x-www-form-urlencoded"
    if preferred in consumes:
        return preferred
    return str(consumes[0]) if consumes else preferred


def _query_values(
    parameter: Mapping[str, object], name: str, fallback: str
) -> list[QueryParameterSpec]:
    schema = _mapping(parameter.get("schema"))
    values = parameter.get("example", parameter.get("default", schema.get("default")))
    if not isinstance(values, list):
        return [QueryParameterSpec(name=name, value=imported_value(name, fallback))]
    encoded = [str(value) for value in values]
    style = parameter.get("style") or "form"
    explode = parameter.get("explode", style == "form")
    if explode is not True:
        separator = {"spaceDelimited": " ", "pipeDelimited": "|", "tabDelimited": "\t"}.get(
            str(parameter.get("style")), ","
        )
        encoded = [separator.join(encoded)]
    return [QueryParameterSpec(name=name, value=imported_value(name, value)) for value in encoded]


def _request_content_type(
    operation: Mapping[str, object], parameters: list[object], source_type: ImportSourceType
) -> str | None:
    if source_type is ImportSourceType.SWAGGER2:
        return _swagger_content_type(operation, parameters)
    content = _mapping(_mapping(operation.get("requestBody")).get("content"))
    return next(iter(content), None)


def _security_diagnostics(
    operation: Mapping[str, object],
    schemes: Mapping[str, object],
    default: list[object],
    normalizer: SourceNormalizer,
) -> None:
    security = _sequence(operation.get("security")) if "security" in operation else default
    if not security:
        return
    requirement = _mapping(security[0])
    unsupported = len(security) > 1 or len(requirement) > 1
    for name in requirement:
        scheme = _mapping(schemes.get(name))
        supported = scheme.get("type") in {"basic", "apiKey"} or (
            scheme.get("type") == "http"
            and _text(scheme.get("scheme")).lower() in {"basic", "bearer"}
        )
        unsupported |= not supported
    if unsupported:
        normalizer.warn(
            pointer("#/paths", normalizer.endpoint) + "/security",
            "$.auth",
            "security",
            "SECURITY_REQUIRES_CONFIGURATION",
            "认证组合或协议需人工配置; 不代表已实现完整认证",
            loss=True,
        )


def _openapi_server(document: Mapping[str, object], document_url: str | None) -> str | None:
    servers = _sequence(document.get("servers"))
    if not servers:
        return None
    server = _mapping(servers[0])
    url = _text(server.get("url"))
    variables = _mapping(server.get("variables"))
    for name, raw_variable in variables.items():
        variable = _mapping(raw_variable)
        default = _text(variable.get("default"))
        if default:
            url = url.replace("{" + name + "}", default)
    if "{" in url or "}" in url:
        return None
    if not urlsplit(url).scheme:
        url = urljoin(document_url, url) if document_url else ""
    return url.rstrip("/") or None
