from collections.abc import Iterator
from typing import Any
from urllib.parse import unquote_plus, urlsplit, urlunsplit

from app.domain.api_assets import api_key_name

Payload = dict[str, Any]

_CREDENTIAL_NAMES = {
    "authorization", "proxy_authorization", "cookie", "set_cookie", "api_key", "apikey",
    "token", "accesstoken", "refreshtoken", "idtoken", "clientsecret", "secret", "password",
    "passwd", "signature", "sessionid", "session_id",
}
_CREDENTIAL_SUFFIXES = ("_token", "_api_key", "_secret", "_password", "_cookie")


def credential_name(name: str, custom: str | None = "") -> bool:
    # An older HTTP snapshot may not identify its configured API key.
    if custom is None:
        return True
    normalized = name.casefold().replace("-", "_")
    return (
        normalized in _CREDENTIAL_NAMES or normalized.endswith(_CREDENTIAL_SUFFIXES)
        or bool(custom and name.casefold() == custom.casefold())
    )


def api_auth_key(asset: Payload) -> str:
    request = asset["request"]
    return api_key_name(request["auth_kind"], request["auth_config"])


def masked_fields(data: Payload, custom: str | None = "") -> Payload:
    return {key: None if credential_name(key, custom) else value for key, value in data.items()}


def masked_url(url: str, custom: str | None = "") -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return "[redacted]"
    fields = []
    for field in parts.query.split("&"):
        name, delimiter, _ = field.partition("=")
        if delimiter and credential_name(unquote_plus(name), custom):
            field = name + "=%5Bredacted%5D"
        fields.append(field)
    query = "&".join(fields)
    authority = parts.netloc.rsplit("@", 1)[-1]
    if authority == parts.netloc and query == parts.query:
        return url
    return urlunsplit((parts.scheme, authority, parts.path, query, parts.fragment))


def masked_parameters(parameters: list[Payload], custom: str | None) -> list[Payload]:
    return [{**param, "value": None} if credential_name(param["name"], custom) else param for param in parameters]


def is_credential_assertion(check: Payload, custom: str | None) -> bool:
    kind, _, target = check.get("name", "").partition(" ")
    return check.get("kind", kind) == "header" and credential_name(check.get("target") or target, custom)


def masked_assertions(checks: list[Payload], custom: str | None) -> list[Payload]:
    safe = []
    for check in checks:
        if is_credential_assertion(check, custom):
            check = {**check, "expected": None}
            if "actual" in check:
                check.update(actual=None, message="鉴权字段断言通过" if check["passed"] else "鉴权字段断言失败")
        safe.append(check)
    return safe


def api_definition_view(asset: Payload) -> Payload:
    request = asset["request"].copy()
    custom = api_auth_key(asset)
    request["path"] = masked_url(request["path"], custom)
    request["headers"] = masked_fields(request["headers"], custom)
    request["variables"] = masked_fields(request["variables"], custom)
    request["auth_config"] = {
        key: value if request["auth_kind"] == "api_key" and key in {"name", "in"} else None
        for key, value in request["auth_config"].items()
    }
    request["query_parameters"] = masked_parameters(request["query_parameters"], custom)
    request["assertions"] = masked_assertions(request["assertions"], custom)
    return {**asset, "base_url": masked_url(asset["base_url"], custom), "request": request}


def workflow_overrides(definition: Payload) -> Iterator[tuple[str, Payload]]:
    for graph in (definition, *definition.get("regions", [])):
        for node in graph["nodes"]:
            config = node.get("configuration") or node["config"]
            overrides = config.get("request_overrides")
            if isinstance(overrides, dict) and (overrides.get("headers") or overrides.get("query_parameters")):
                yield config["api_definition_id"], overrides


def http_view(snapshot: Payload, custom: str | None) -> Payload:
    safe = snapshot.copy()
    if "headers" in safe:
        safe["headers"] = masked_fields(safe["headers"], custom)
    if "url" in safe:
        safe["url"] = masked_url(safe["url"], custom)
    if "extracted" in safe:
        safe["extracted"] = masked_fields(safe["extracted"], custom)
    if "assertions" in safe:
        safe["assertions"] = masked_assertions(safe["assertions"], custom)
    return safe


def observation_view(item: Payload) -> Payload:
    custom = item["request"].get("auth_key_name")
    response = item["response"]
    mappings = [
        {**mapping, "value": None} if credential_name(mapping["target_key"], custom) else mapping
        for mapping in item["mappings"]
    ]
    return {**item, "request": http_view(item["request"], custom),
            "response": http_view(response, custom) if response is not None else None, "mappings": mappings}


def run_node_view(node: Payload) -> Payload:
    result = node.get("result")
    if result is None:
        return node
    output = result.get("output")
    if isinstance(output, dict) and "status_code" in output and isinstance(output.get("headers"), dict):
        attempts = result["observations"]
        custom = attempts[-1]["request"].get("auth_key_name") if attempts else None
        first_failure = next((check for check in output.get("assertions", []) if not check["passed"]), None)
        if first_failure and is_credential_assertion(first_failure, custom):
            node = {**node, "error_message": "鉴权字段断言失败"}
            if result.get("error"):
                result = {**result, "error": {**result["error"], "message": "鉴权字段断言失败"}}
        result = {**result, "assertions": masked_assertions(result["assertions"], custom)}
        output = http_view(output, custom)
    elif isinstance(output, dict) and isinstance(output.get("variables"), dict):
        output = {**output, "variables": masked_fields(output["variables"])}
    elif isinstance(output, dict) and isinstance(output.get("variable"), str) and credential_name(output["variable"]):
        output = {**output, "value": None}
    observations = [observation_view(item) for item in result["observations"]]
    return {**node, "result": {**result, "observations": observations, "output": output}}
