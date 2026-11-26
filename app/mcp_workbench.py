from __future__ import annotations

import re
from typing import TYPE_CHECKING

from app.service_launcher import FRONTEND_DIST

if TYPE_CHECKING:
    from mcp.server.fastmcp import FastMCP

WORKBENCH_NAME = "FlowTest-Lite"
WORKBENCH_URI = "ui://flowtest-lite/workbench-0.3.1.html"
WORKBENCH_TOOL_META = {
    "ui": {"resourceUri": WORKBENCH_URI},
    "openai/ui": {"entrypoints": [{"type": "global"}]},
}
WORKBENCH_SCRIPT = FRONTEND_DIST / "mcp-app" / "workbench.js"


def register_workbench_resource(server: FastMCP) -> None:
    @server.resource(
        WORKBENCH_URI, title=WORKBENCH_NAME, mime_type="text/html;profile=mcp-app",
        meta={
            "ui": {"prefersBorder": False},
            "openai/ui": {"availableDisplayModes": ["fullscreen"]},
        },
    )
    def workbench_resource() -> str:
        script = WORKBENCH_SCRIPT.read_text(encoding="utf-8")
        # The self-contained bundle can include HTML-like text in string literals.
        script = re.sub(r"</script", lambda match: r"<\/" + match[0][2:], script, flags=re.IGNORECASE)
        return (
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>FlowTest-Lite</title></head><body><div id="root"></div>'
            f'<script>{script}</script></body></html>'
        )
