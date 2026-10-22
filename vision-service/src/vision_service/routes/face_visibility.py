"""Detection-only numeric observations on the shared face runtime's 640 detector (CPU, or GPU with FACE_FALLBACK_ON_GPU)."""
from fastapi import APIRouter, Depends, Request
from ..config import Settings, get_settings
from ..runtime import VisionRuntime
from .detect import get_runtime, require_internal_auth
from .v1 import AnalyzeResponse, analyze

router = APIRouter(prefix="/v1", tags=["vision"])

class _VisibilityRuntime:
    """Reuse bounded multipart parsing without registering a second detector."""
    def __init__(self, runtime):
        self.runtime = runtime

    def has_capability(self, name):
        return name == "face_visibility" and self.runtime.has_capability("faces")

    def activity(self, *capabilities):
        return self.runtime.activity("faces")

    async def analyze_batch(self, capability, images):
        return await self.runtime.analyze_visibility_batch(images)

@router.post("/face-visibility", response_model=AnalyzeResponse)
async def face_visibility(
    request: Request, runtime: VisionRuntime = Depends(get_runtime),
    settings: Settings = Depends(get_settings),
    _authenticated: None = Depends(require_internal_auth),
) -> AnalyzeResponse:
    try:
        return await analyze(request, _VisibilityRuntime(runtime), settings, None)
    finally:
        # Request-scoped cached uploads are disposed even after cancellation.
        form = getattr(request, "_form", None)
        if form is not None:
            await form.close()
