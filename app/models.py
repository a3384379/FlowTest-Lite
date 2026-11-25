from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints, model_validator

from app.domain.api_assets import AuthKind, BodyKind, ExtractionKind, HttpMethod
from app.domain.assertions import AssertionKind, ComparisonOperator
from app.engine.contracts import ApiNodeRequestOverrides, ApiNodeRequestParameter, WorkflowDefinition


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Extraction(Model):
    name: Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_.-]*$", max_length=160)]
    kind: ExtractionKind
    expression: str = Field(min_length=1, max_length=1000)


class Assertion(Model):
    kind: AssertionKind
    operator: ComparisonOperator = ComparisonOperator.EQUALS
    target: str | None = None
    expected: JsonValue = None


class RequestDefinition(Model):
    method: HttpMethod = HttpMethod.GET
    path: str = Field(default="/", min_length=1, max_length=4096)
    query_parameters: list[ApiNodeRequestParameter] = Field(default_factory=list, max_length=200)
    headers: dict[str, str] = Field(default_factory=dict)
    variables: dict[str, str] = Field(default_factory=dict)
    body_kind: BodyKind = BodyKind.NONE
    body: JsonValue = None
    auth_kind: AuthKind = AuthKind.NONE
    auth_config: dict[str, str] = Field(default_factory=dict)
    extraction_rules: list[Extraction] = Field(default_factory=list, max_length=100)
    assertions: list[Assertion] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_extraction_names(self) -> "RequestDefinition":
        names = [rule.name for rule in self.extraction_rules]
        if len(set(names)) != len(names):
            raise ValueError("提取变量名称必须唯一")
        return self


class ApiAsset(Model):
    name: str = Field(min_length=1, max_length=200)
    group: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=2000)
    base_url: str = Field(default="", max_length=4096)
    request: RequestDefinition = Field(default_factory=RequestDefinition)


class ApiGroupName(Model):
    name: Annotated[str, StringConstraints(min_length=1, max_length=100, strip_whitespace=True)]
    previous: str | None = Field(default=None, min_length=1, max_length=100)


class MoveApis(Model):
    ids: list[UUID] = Field(min_length=1, max_length=1000)
    group: str = Field(default="", max_length=100)


class Environment(Model):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(default="", max_length=4096)
    variables: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)


class CommonSettings(Model):
    base_url: str = Field(default="", max_length=4096)
    variables: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)


class WorkflowAsset(Model):
    name: str = Field(min_length=1, max_length=200)
    definition: WorkflowDefinition
    inputs: dict[str, JsonValue] = Field(default_factory=dict)


class SendOptions(Model):
    environment_id: UUID | None = None
    runtime_variables: dict[str, JsonValue] = Field(default_factory=dict)
    timeout_seconds: float = Field(default=30, ge=0.1, le=300)
    request_overrides: ApiNodeRequestOverrides = Field(default_factory=ApiNodeRequestOverrides)


class RunOptions(Model):
    environment_id: UUID | None = None
    runtime_variables: dict[str, JsonValue] | None = None


class ImportOptions(Model):
    source_type: str = "auto"
    content: str = Field(default="", max_length=4_000_000)
    url: str = Field(default="", max_length=4096)

    @model_validator(mode="after")
    def one_source(self) -> "ImportOptions":
        if bool(self.content.strip()) == bool(self.url.strip()):
            raise ValueError("请选择文档内容或文档 URL")
        return self
