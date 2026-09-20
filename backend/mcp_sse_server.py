"""
Velxio MCP Server — HTTP/SSE entry point

Run this script to start the MCP server using the SSE transport, which is
compatible with HTTP-based MCP clients (e.g. web applications, Cursor IDE).

The SSE server runs on port 8002 by default (separate from the main FastAPI
backend on port 8001) to avoid Starlette version conflicts. It binds to
127.0.0.1 unless you explicitly pass --host 0.0.0.0, and supports a bearer
token via --token — use it whenever anything you do not control can reach
the port (the server runs sketch compilation on request).

Usage:
    python mcp_sse_server.py [--port 8002] [--host 127.0.0.1] [--token SECRET]

The server binds to 127.0.0.1 by default — it can run sketch-compilation
requests, so do not expose it to a network without a reverse proxy that
authenticates clients. Pass --token to require an Authorization: Bearer
header on every request (stdin transport needs no token).

MCP client configuration (SSE transport):
    {
      "mcpServers": {
        "velxio": {
          "url": "http://localhost:8002/sse"
        }
      }
    }
"""

import sys
import argparse
from pathlib import Path

import uvicorn

# Ensure the backend package is importable when run as a script
sys.path.insert(0, str(Path(__file__).parent))

from app.mcp.server import mcp  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Velxio MCP SSE Server")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Host to bind to (default 127.0.0.1; use 0.0.0.0 only behind an authenticating proxy)")
    parser.add_argument("--port", type=int, default=8002, help="Port to listen on")
    parser.add_argument("--token", default="",
                        help="Require 'Authorization: Bearer <token>' on every request")
    args = parser.parse_args()

    print(f"Starting Velxio MCP SSE server on {args.host}:{args.port}")
    print(f"SSE endpoint: http://{args.host}:{args.port}/sse")
    print(f"Tools: compile_project, run_project, import_wokwi_json, export_wokwi_json,")
    print(f"       create_circuit, update_circuit, generate_code_files, validate_circuit")

    sse_app = mcp.sse_app()

    if args.token:
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.responses import JSONResponse

        class BearerTokenMiddleware(BaseHTTPMiddleware):
            """Reject requests without the expected bearer token.

            The MCP protocol surface has no auth of its own; without this the
            SSE endpoint would let anything on the network compile sketches.
            """

            async def dispatch(self, request, call_next):
                header = request.headers.get("authorization", "")
                import secrets as _secrets

                if not _secrets.compare_digest(header.encode(), f"Bearer {args.token}".encode()):
                    return JSONResponse({"error": "Unauthorized"}, status_code=401)
                return await call_next(request)

        sse_app.add_middleware(BearerTokenMiddleware)
        print("Auth: bearer token required")

    uvicorn.run(sse_app, host=args.host, port=args.port)
