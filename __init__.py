import asyncio
from aiohttp import web
from server import PromptServer
from .monitor import sampler, validate_query

WEB_DIRECTORY = './web'
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

@PromptServer.instance.routes.get('/magik_resources/status')
async def resources_status(request):
    try:
        _, disk = validate_query(request.query)
        result = await asyncio.to_thread(sampler.snapshot, disk)
        return web.json_response(result, headers={'Cache-Control': 'no-store'})
    except ValueError as exc:
        return web.json_response({'error': str(exc)}, status=400)
    except Exception:
        # Keep hardware/driver failure local to this request; the next poll retries.
        return web.json_response({'error': 'Hardware sampling failed; retrying on next update'}, status=503)
