from dataclasses import dataclass
from enum import StrEnum

from app.domain.api_assets import APIVersionSpec, AuthKind, BodyKind, HttpMethod
from app.importers.openapi_normalization import ImportDiagnostic

class ImportSourceType(StrEnum):
    AUTO = "auto"
    OPENAPI3 = "openapi3"
    SWAGGER2 = "swagger2"
    POSTMAN = "postman"
    HAR = "har"
    CURL = "curl"
    BRUNO = "bruno"


@dataclass(frozen=True, slots=True)
class ImportedOperation:
    name: str
    description: str
    request: APIVersionSpec
    target_base_url: str | None = None
    diagnostics: tuple[ImportDiagnostic, ...] = ()

def imported_value(_name: str, value: str) -> str:
    return value


def empty_request(*, method: HttpMethod, path: str) -> APIVersionSpec:
    return APIVersionSpec(
        method=method,
        path=path,
        query_parameters=(),
        headers={},
        body_kind=BodyKind.NONE,
        body=None,
        auth_kind=AuthKind.NONE,
        auth_config={},
    )
