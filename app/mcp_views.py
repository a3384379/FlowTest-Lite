from typing import Any
from urllib.parse import unquote_plus, urlsplit, urlunsplit

Payload = dict[str, Any]

_CREDENTIAL_NAMES = {
    "authorization", "proxy_authorization", "cookie", "set_cookie", "api_key", "apikey",
    "token", "secret", "password", "passwd", "signature", "sessionid", "session_id",
}
_CREDENTIAL_SUFFIXES = ("_token", "_api_key", "_secret", "_password", "_cookie")


def credential_name(name: str, custom: str = "") -> bool:
    normalized = name.casefold().replace("-", "_")
    return (
        normalized in _CREDENTIAL_NAMES or normalized.endswith(_CREDENTIAL_SUFFIXES)
        or bool(custom and name.casefold() == custom.casefold())
    )


def api_auth_key(asset: Payload) -> str:
    request = asset["request"]
    if request.get("auth_kind") == "api_key":
        return request.get("auth_config", {}).get("name", "x-api-key")
    return ""


def masked_fields(data: Payload, custom: str = "") -> Payload:
    return {key: None if credential_name(key, custom) else value for key, value in data.items()}


def masked_url(url: str, custom: str = "") -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
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
    request["query_parameters"] = [
        {**param, "value": None} if credential_name(param["name"], custom) else param
        for param in request["query_parameters"]
    ]
    return {**asset, "base_url": masked_url(asset["base_url"], custom), "request": request}


def http_view(snapshot: Payload, custom: str = "") -> Payload:
    safe = snapshot.copy()
    if "headers" in safe:
        safe["headers"] = masked_fields(safe["headers"], custom)
    if "url" in safe:
        safe["url"] = masked_url(safe["url"], custom)
    return safe


def observation_view(item: Payload) -> Payload:
    response = item["response"]
    mappings = [
        {**mapping, "value": None} if credential_name(mapping["target_key"]) else mapping
        for mapping in item["mappings"]
    ]
    return {**item, "request": http_view(item["request"]),
            "response": http_view(response) if response is not None else None, "mappings": mappings}


def run_node_view(node: Payload) -> Payload:
    result = node.get("result")
    if result is None:
        return node
    output = result.get("output")
    if isinstance(output, dict) and "status_code" in output and isinstance(output.get("headers"), dict):
        output = http_view(output)
    observations = [observation_view(item) for item in result["observations"]]
    return {**node, "result": {**result, "observations": observations, "output": output}}
