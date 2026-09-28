"""Authorized project folders and the context the agent reads from them.

Projects are registered only by the desktop app after the engineer confirms a native consent dialog.
Registration and removal require the X-OnCall-Client: desktop header, which also forces a CORS
preflight, so no web page can register a folder behind the engineer's back.
"""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from app.db import from_db_time, get_session, to_db_time, utc_now
from app.models import MemoryEvent, MemoryEventRow, ProjectContext, ProjectCreate, ProjectOut, ProjectRow
from app.services.project_context import (
    ProjectAccessError,
    count_files,
    git_context,
    recent_log_errors,
    validate_root,
)

router = APIRouter(prefix="/api")
DESKTOP_CLIENT = "desktop"


def out(row: ProjectRow) -> ProjectOut:
    return ProjectOut(id=row.id or 0, name=row.name, root_path=row.root_path, scope=row.scope,
                      created_at=from_db_time(row.created_at) or utc_now())


def forbidden() -> JSONResponse:
    return JSONResponse(status_code=403, content={"error": "desktop_only",
                                                  "message": "Projects can only be connected from the desktop app, after you confirm access."})


@router.post("/projects", response_model=ProjectOut, status_code=201)
async def register_project(body: ProjectCreate, session: Session = Depends(get_session),
                           x_oncall_client: str | None = Header(default=None)) -> ProjectOut | JSONResponse:
    if x_oncall_client != DESKTOP_CLIENT:
        return forbidden()
    try:
        root = validate_root(body.root_path)
    except ProjectAccessError as exc:
        return JSONResponse(status_code=400, content={"error": "invalid_project", "message": str(exc)})
    existing = session.exec(select(ProjectRow).where(ProjectRow.root_path == str(root))).first()
    if existing is not None:
        if body.scope == "always" and existing.scope != "always":
            existing.scope = "always"
            session.add(existing)
            session.commit()
            session.refresh(existing)
        return out(existing)
    row = ProjectRow(name=body.name or root.name, root_path=str(root), scope=body.scope, created_at=to_db_time(utc_now()))
    session.add(row)
    session.commit()
    session.refresh(row)
    return out(row)


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(session: Session = Depends(get_session)) -> list[ProjectOut]:
    return [out(row) for row in session.exec(select(ProjectRow).order_by(ProjectRow.id)).all()]  # type: ignore[arg-type]


@router.delete("/projects/{project_id}", response_model=None)
async def remove_project(project_id: int, session: Session = Depends(get_session),
                         x_oncall_client: str | None = Header(default=None)) -> dict[str, bool] | JSONResponse:
    if x_oncall_client != DESKTOP_CLIENT:
        return forbidden()
    row = session.get(ProjectRow, project_id)
    if row is not None:
        session.delete(row)
        session.commit()
    return {"removed": row is not None}


@router.get("/projects/{project_id}/context", response_model=ProjectContext)
async def project_context(project_id: int, minutes: int = Query(15, ge=1, le=24 * 60),
                          session: Session = Depends(get_session)) -> ProjectContext | JSONResponse:
    row = session.get(ProjectRow, project_id)
    if row is None:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": "That project is not connected."})
    try:
        root = validate_root(row.root_path)
    except ProjectAccessError as exc:
        return JSONResponse(status_code=409, content={"error": "project_unavailable", "message": str(exc)})
    files, logs, git = await asyncio.gather(
        asyncio.to_thread(count_files, root),
        asyncio.to_thread(recent_log_errors, root, minutes),
        asyncio.to_thread(git_context, root),
    )
    return ProjectContext(project=out(row), files_indexed=files, log_errors=logs, git=git)


@router.get("/projects/resolve-path", response_model=ProjectOut)
async def project_for_path(path: str, session: Session = Depends(get_session)) -> ProjectOut | JSONResponse:
    """Which authorized project contains this path; the desktop app uses it before opening a file."""
    target = Path(path).resolve()
    for row in session.exec(select(ProjectRow)).all():
        root = Path(row.root_path)
        if target == root or root in target.parents:
            return out(row)
    return JSONResponse(status_code=404, content={"error": "outside_projects", "message": "That file is not inside a connected project."})


@router.get("/memory/events", response_model=list[MemoryEvent])
async def memory_events(limit: int = Query(30, ge=1, le=200), session: Session = Depends(get_session)) -> list[MemoryEvent]:
    rows = session.exec(select(MemoryEventRow).order_by(MemoryEventRow.id.desc()).limit(limit)).all()  # type: ignore[union-attr]
    return [MemoryEvent(id=r.id or 0, kind=r.kind, detail=r.detail, ok=r.ok, count=r.count,  # type: ignore[arg-type]
                        incident_id=r.incident_id, created_at=from_db_time(r.created_at) or utc_now()) for r in rows]
