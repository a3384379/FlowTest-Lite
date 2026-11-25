import argparse

import uvicorn

parser = argparse.ArgumentParser(description="运行 FlowTest-Lite")
parser.add_argument("--port", type=int, default=8765)
args = parser.parse_args()
uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, access_log=False)
