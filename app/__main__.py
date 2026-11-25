import argparse

import uvicorn

from app.service_launcher import DEFAULT_PORT


def main() -> None:
    parser = argparse.ArgumentParser(description="运行 FlowTest-Lite")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, access_log=False, workers=1)


if __name__ == "__main__":
    main()
