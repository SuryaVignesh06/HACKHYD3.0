"""Current-context helpers for the desktop agent. The screen is only read when the engineer asks."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.services.llm import LLMService, LLMUnavailable

router = APIRouter(prefix="/api")
MAX_IMAGE_CHARS = 8 * 1024 * 1024


class ScreenRequest(BaseModel):
    image_data_url: str = Field(min_length=100, max_length=MAX_IMAGE_CHARS)


class ScreenResponse(BaseModel):
    found: bool
    summary: str
    text: str
    model: str


def get_llm(request: Request) -> LLMService:
    llm: LLMService = request.app.state.llm
    return llm


@router.post("/context/screen", response_model=ScreenResponse)
async def read_screen(body: ScreenRequest, llm: LLMService = Depends(get_llm)) -> ScreenResponse | JSONResponse:
    if not body.image_data_url.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
        return JSONResponse(status_code=400, content={"error": "invalid_image", "message": "Expected a PNG or JPEG screenshot."})
    try:
        reading, model = await llm.read_screen(body.image_data_url)
    except LLMUnavailable:
        return JSONResponse(status_code=503, content={
            "error": "vision_unavailable",
            "message": "The vision model is unavailable right now. Copy the error to the clipboard or paste it instead.",
        })
    return ScreenResponse(found=reading.found and bool(reading.text.strip()), summary=reading.summary,
                          text=reading.text, model=model.split("/")[-1])
