"""BananaBatch API v2

Fixes vs v1 (in-memory JBS):
  - SQLite persistence (aiosqlite + WAL): state survives restarts, enables
    multiple Gunicorn workers
  - Per-image retry: up to 3 attempts with exponential backoff
  - Server-Sent Events: frontend receives live updates without polling
  - Unicode-safe filenames: X-Accel-Redirect headers are URL-encoded
  - Automatic cleanup: expired jobs (>24 h) are deleted by a background task
  - Startup recovery: jobs stuck in 'processing' after a crash are marked error
"""

import asyncio
import io
import json
import logging
import os
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from typing import AsyncIterator, List, Optional
from urllib.parse import quote

import aiosqlite
import httpx
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from bananabatch.core.engine import BatchEditProcessor, FileManager
from bananabatch.core.models import EditJobConfig, EditType, JobStatus, ModelName
from bananabatch.providers.gemini import GeminiProvider

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

for _env in (".env", ".env.example"):
    if Path(_env).exists():
        load_dotenv(_env)
        break
else:
    load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("bananabatch")

_ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "http://localhost:5173")
_SUPABASE_URL = os.getenv("SUPABASE_API_URL", "")
_SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

# Paths — configurable via env so the same code works locally and in Docker
_DB_DIR = Path(os.getenv("DB_DIR", "/app/data"))
_DB_PATH = _DB_DIR / "bananabatch.db"
_OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/app/outputs"))

# In production nginx handles file delivery via X-Accel-Redirect.
# In local dev (no nginx) we serve files directly with FileResponse.
_USE_NGINX_ACCEL = os.getenv("USE_NGINX_ACCEL", "0") == "1"

MAX_RETRIES = 3

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="BananaBatch API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[_ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Database helpers (one connection per call — SQLite WAL handles concurrency)
# ---------------------------------------------------------------------------


async def _db(
    sql: str,
    params: tuple = (),
    *,
    fetchone: bool = False,
    fetchall: bool = False,
    commit: bool = False,
):
    _DB_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(_DB_PATH)) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA synchronous=NORMAL")
        if fetchone:
            async with conn.execute(sql, params) as cur:
                row = await cur.fetchone()
                return dict(row) if row else None
        if fetchall:
            async with conn.execute(sql, params) as cur:
                rows = await cur.fetchall()
                return [dict(r) for r in rows]
        await conn.execute(sql, params)
        if commit:
            await conn.commit()


async def _db_init():
    _DB_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(_DB_PATH)) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA synchronous=NORMAL")
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id          TEXT PRIMARY KEY,
                owner_id    TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'collecting',
                prompt      TEXT,
                edit_type   TEXT DEFAULT 'transform',
                strength    REAL DEFAULT 0.75,
                model       TEXT DEFAULT 'gemini-3.1-flash-image-preview',
                total_files INTEGER DEFAULT 0,
                items       TEXT NOT NULL DEFAULT '[]',
                temp_dir    TEXT,
                total_cost  REAL DEFAULT 0.0,
                total_time  REAL DEFAULT 0.0,
                error_msg   TEXT,
                created_at  REAL DEFAULT (unixepoch()),
                expires_at  REAL DEFAULT (unixepoch() + 86400)
            )
            """
        )
        await conn.commit()
    log.info("DB ready at %s", _DB_PATH)


async def db_create_job(
    job_id: str,
    owner_id: str,
    prompt: str,
    edit_type: str,
    strength: float,
    model: str,
    total_files: int,
    temp_dir: str,
):
    await _db(
        """INSERT INTO jobs
           (id, owner_id, status, prompt, edit_type, strength, model, total_files, temp_dir)
           VALUES (?, ?, 'collecting', ?, ?, ?, ?, ?, ?)""",
        (job_id, owner_id, prompt, edit_type, strength, model, total_files, temp_dir),
        commit=True,
    )


async def db_get_job(job_id: str) -> Optional[dict]:
    row = await _db("SELECT * FROM jobs WHERE id = ?", (job_id,), fetchone=True)
    if row is None:
        return None
    row["items"] = json.loads(row["items"])
    return row


async def db_update_job(job_id: str, **kwargs):
    if not kwargs:
        return
    if "items" in kwargs:
        kwargs["items"] = json.dumps(kwargs["items"])
    cols = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [job_id]
    await _db(f"UPDATE jobs SET {cols} WHERE id = ?", tuple(vals), commit=True)


async def db_append_item(job_id: str, item: dict) -> int:
    """Atomically append an item to the job's items array. Returns new count."""
    async with aiosqlite.connect(str(_DB_PATH)) as conn:
        await conn.execute("PRAGMA journal_mode=WAL")
        # json_insert with '$[#]' appends atomically inside SQLite
        await conn.execute(
            "UPDATE jobs SET items = json_insert(items, '$[#]', json(?)) WHERE id = ?",
            (json.dumps(item), job_id),
        )
        await conn.commit()
        async with conn.execute(
            "SELECT json_array_length(items) FROM jobs WHERE id = ?", (job_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else 0


async def db_update_item(job_id: str, item_id: str, **kwargs):
    """Atomically update one item inside the job's JSON items array."""
    # Read → mutate → write under SQLite's serialized write lock
    async with aiosqlite.connect(str(_DB_PATH)) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        async with conn.execute("SELECT items FROM jobs WHERE id = ?", (job_id,)) as cur:
            row = await cur.fetchone()
        if row is None:
            return
        items = json.loads(row["items"])
        for item in items:
            if item["id"] == item_id:
                item.update(kwargs)
                break
        await conn.execute(
            "UPDATE jobs SET items = ? WHERE id = ?",
            (json.dumps(items), job_id),
        )
        await conn.commit()


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------


@app.on_event("startup")
async def startup():
    await _db_init()
    # Recover jobs that were mid-flight when the server last crashed
    await _db(
        """UPDATE jobs SET status = 'error', error_msg = 'Servidor reiniciado durante o processamento'
           WHERE status IN ('processing', 'collecting')""",
        commit=True,
    )
    log.info("Startup: recovered stuck jobs (if any)")
    asyncio.create_task(_cleanup_loop())


@app.on_event("shutdown")
async def shutdown():
    log.info("Shutdown complete")


async def _cleanup_loop():
    """Every hour: delete jobs older than 24 h and their files."""
    while True:
        await asyncio.sleep(3600)
        try:
            rows = await _db(
                "SELECT id, temp_dir FROM jobs WHERE expires_at < unixepoch()",
                fetchall=True,
            )
            if not rows:
                continue
            for row in rows:
                jid, tmp = row["id"], row["temp_dir"]
                out_dir = _OUTPUT_DIR / jid
                if out_dir.exists():
                    shutil.rmtree(out_dir, ignore_errors=True)
                if tmp and Path(tmp).exists():
                    shutil.rmtree(tmp, ignore_errors=True)
                await _db("DELETE FROM jobs WHERE id = ?", (jid,), commit=True)
                log.info("Cleaned up expired job %s", jid[:8])
        except Exception as exc:
            log.warning("Cleanup error: %s", exc)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

_bearer = HTTPBearer(auto_error=False)


async def _validate_token(token: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_SUPABASE_URL}/auth/v1/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": _SUPABASE_ANON_KEY,
                },
            )
        if resp.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return resp.json()
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Could not reach authentication server")


async def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await _validate_token(credentials.credentials)


async def require_auth_query(token: str = Query(None)) -> dict:
    """Auth via ?token= query param — needed for EventSource (can't set headers)."""
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    return await _validate_token(token)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class JobItem(BaseModel):
    id: str
    filename: str
    status: str
    sub_status: Optional[str] = None
    error_msg: Optional[str] = None
    output_url: Optional[str] = None
    processing_time: Optional[float] = None
    estimated_cost: Optional[float] = None


class JobResponse(BaseModel):
    job_id: str
    status: str
    total_time: Optional[float] = None
    total_cost: Optional[float] = None
    items: List[JobItem]


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------


async def _process_item_with_retry(
    job_id: str,
    item: dict,
    prompt: str,
    edit_type: str,
    strength: float,
    model: str,
    file_path: Path,
    output_dir: Path,
    api_key: str,
) -> None:
    """Run one image through the AI pipeline with up to MAX_RETRIES attempts."""
    item_id = item["id"]
    last_error: str = "Unknown error"

    for attempt in range(1, MAX_RETRIES + 1):
        sub = (
            f"Tentativa {attempt}/{MAX_RETRIES}: enviando para IA..."
            if attempt > 1
            else "Enviando para IA..."
        )
        await db_update_item(job_id, item_id, sub_status=sub)
        log.info("[%s] %s — attempt %d/%d", job_id[:8], item["filename"], attempt, MAX_RETRIES)

        tmp_json: Optional[Path] = None
        try:
            # Build a single-record JSON for the engine
            records = [
                {
                    "id": item_id,
                    "base_image": str(file_path),
                    "edit_prompt": prompt,
                    "strength": strength,
                    "edit_type": edit_type,
                    "model": ModelName(model).value,
                }
            ]
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, dir=str(output_dir.parent)
            ) as tmp:
                json.dump(records, tmp)
                tmp_json = Path(tmp.name)

            edit_config = EditJobConfig(
                input_file=tmp_json,
                output_dir=output_dir,
                default_edit_type=EditType(edit_type),
                default_strength=strength,
                model=ModelName(model),
                max_workers=1,
                api_key=api_key,
            )
            provider = GeminiProvider(api_key=api_key, default_model=ModelName(model).value)
            file_manager = FileManager(edit_config.output_dir)
            file_manager.set_output_dir(edit_config.output_dir)
            processor = BatchEditProcessor(
                provider=provider, config=edit_config, file_manager=file_manager
            )

            async for result in processor.process_stream():
                if result.status == JobStatus.COMPLETED:
                    out_name = Path(result.output_path).name
                    await db_update_item(
                        job_id,
                        item_id,
                        status="ok",
                        sub_status=None,
                        error_msg=None,
                        output_url=f"/api/jobs/{job_id}/files/{out_name}",
                        processing_time=(
                            result.generation_time_ms / 1000.0
                            if result.generation_time_ms
                            else 0.0
                        ),
                        estimated_cost=0.03,
                    )
                    log.info("[%s] %s — OK", job_id[:8], item["filename"])
                    return  # success — exit retry loop
                else:
                    last_error = result.error_message or "Provider returned failure"
                    raise RuntimeError(last_error)

        except Exception as exc:
            last_error = str(exc)
            log.warning(
                "[%s] %s — attempt %d failed: %s",
                job_id[:8],
                item["filename"],
                attempt,
                last_error,
            )
            if attempt < MAX_RETRIES:
                backoff = 2**attempt  # 2 s, 4 s
                await db_update_item(
                    job_id,
                    item_id,
                    sub_status=f"Falhou. Nova tentativa em {backoff}s...",
                )
                await asyncio.sleep(backoff)
        finally:
            if tmp_json and tmp_json.exists():
                tmp_json.unlink(missing_ok=True)

    # All retries exhausted
    await db_update_item(
        job_id, item_id, status="error", sub_status=None, error_msg=last_error
    )
    log.error("[%s] %s — failed after %d retries", job_id[:8], item["filename"], MAX_RETRIES)


async def _process_job(job_id: str) -> None:
    """Background task: process every item in the job concurrently (semaphore=3)."""
    start = time.time()
    log.info("Job %s started", job_id[:8])

    try:
        job = await db_get_job(job_id)
        if not job:
            return

        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            await db_update_job(job_id, status="error", error_msg="Missing GEMINI_API_KEY")
            return

        _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output_dir = _OUTPUT_DIR / job_id
        output_dir.mkdir(parents=True, exist_ok=True)

        # Mark all items as processing
        items = job["items"]
        for item in items:
            item["status"] = "processing"
        await db_update_job(job_id, items=items, status="processing")

        sem = asyncio.Semaphore(3)

        async def _run_one(item: dict):
            fp = Path(job["temp_dir"]) / item["filename"]
            async with sem:
                await _process_item_with_retry(
                    job_id=job_id,
                    item=item,
                    prompt=job["prompt"],
                    edit_type=job["edit_type"],
                    strength=job["strength"],
                    model=job["model"],
                    file_path=fp,
                    output_dir=output_dir,
                    api_key=api_key,
                )

        await asyncio.gather(*[_run_one(item) for item in items])

        # Tally results
        elapsed = time.time() - start
        final_job = await db_get_job(job_id)
        final_items = final_job["items"]
        ok_count = sum(1 for i in final_items if i["status"] == "ok")
        total_cost = ok_count * 0.03

        await db_update_job(
            job_id, status="completed", total_time=elapsed, total_cost=total_cost
        )
        log.info(
            "Job %s done: %d/%d OK in %.1fs", job_id[:8], ok_count, len(final_items), elapsed
        )

    except Exception as exc:
        import traceback

        traceback.print_exc()
        await db_update_job(
            job_id, status="error", error_msg=str(exc), total_time=time.time() - start
        )
        log.error("Job %s crashed: %s", job_id[:8], exc)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/jobs")          # compat alias (old frontend)
@app.post("/api/jobs/init")     # canonical v2 route
async def init_job(
    total_files: int = Form(...),
    prompt: str = Form(...),
    edit_type: str = Form("transform"),
    strength: float = Form(0.75),
    model: str = Form("gemini-3.1-flash-image-preview"),
    user: dict = Depends(require_auth),
):
    """Create an empty job; files are uploaded one-by-one via /upload."""
    job_id = str(uuid.uuid4())
    tmp = Path(tempfile.mkdtemp(prefix=f"banana_{job_id[:8]}_"))
    await db_create_job(
        job_id, user["id"], prompt, edit_type, float(strength), model, int(total_files), str(tmp)
    )
    log.info("Job %s created — expecting %d file(s)", job_id[:8], total_files)
    return {"job_id": job_id, "status": "collecting"}


@app.post("/api/jobs/{job_id}/upload")
async def upload_file(
    job_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: dict = Depends(require_auth),
):
    """Upload a single file. Processing starts automatically when all files arrive."""
    job = await db_get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if job["status"] != "collecting":
        raise HTTPException(status_code=400, detail="Job is not in collecting state")

    safe_name = Path(file.filename or "upload").name
    file_path = Path(job["temp_dir"]) / safe_name
    with open(file_path, "wb") as out:
        shutil.copyfileobj(file.file, out)

    item_id = str(uuid.uuid4())
    total = job["total_files"]
    # Atomic append — no read-modify-write race with concurrent uploads
    received = await db_append_item(job_id, {"id": item_id, "filename": safe_name, "status": "queued"})

    log.info("[%s] %s received (%d/%d)", job_id[:8], safe_name, received, total)

    if received >= total:
        background_tasks.add_task(_process_job, job_id)

    return {"item_id": item_id, "received": received, "total": total, "status": job["status"]}


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: str, user: dict = Depends(require_auth)):
    job = await db_get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return job


@app.get("/api/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    request: Request,
    user: dict = Depends(require_auth_query),
):
    """
    SSE stream for real-time job progress.
    Auth is via ?token=<supabase_jwt> because EventSource cannot set headers.
    Nginx must forward the X-Accel-Buffering: no header to disable buffering.
    """
    job = await db_get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")

    async def _generate() -> AsyncIterator[str]:
        while True:
            if await request.is_disconnected():
                break
            j = await db_get_job(job_id)
            if not j:
                yield f"event: error\ndata: {json.dumps({'error': 'Job not found'})}\n\n"
                break
            payload = {
                "job_id": j["id"],
                "status": j["status"],
                "items": j["items"],
                "total_cost": j["total_cost"],
                "total_time": j["total_time"],
                "error_msg": j.get("error_msg"),
            }
            yield f"data: {json.dumps(payload)}\n\n"
            if j["status"] in ("completed", "error"):
                yield "event: done\ndata: {}\n\n"
                break
            await asyncio.sleep(1.5)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disables nginx proxy buffering for SSE
        },
    )


@app.get("/api/jobs/{job_id}/files/{filename}")
async def get_file(job_id: str, filename: str, user: dict = Depends(require_auth)):
    """Auth-gated file download delegated to nginx via X-Accel-Redirect."""
    job = await db_get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")

    safe_name = Path(filename).name
    if safe_name != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    file_path = _OUTPUT_DIR / job_id / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if _USE_NGINX_ACCEL:
        # Production: let nginx serve the file via X-Accel-Redirect (faster, no Python I/O)
        # URL-encode so Portuguese accented names survive as ASCII in the header
        encoded = quote(safe_name, safe="")
        return Response(
            content=b"",
            status_code=200,
            headers={"X-Accel-Redirect": f"/internal-outputs/{job_id}/{encoded}"},
        )
    # Local dev: serve the file directly from Python
    return FileResponse(path=file_path, filename=safe_name)


@app.get("/api/jobs/{job_id}/download")
async def download_zip(job_id: str, user: dict = Depends(require_auth)):
    """Stream all completed images as a ZIP archive."""
    job = await db_get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")

    output_dir = _OUTPUT_DIR / job_id
    if not output_dir.exists():
        raise HTTPException(status_code=404, detail="Outputs not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in job["items"]:
            if item["status"] == "ok" and item.get("output_url"):
                fname = Path(item["output_url"]).name
                fpath = output_dir / fname
                if fpath.exists():
                    zf.write(fpath, fname)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=bananabatch_{job_id[:8]}.zip"},
    )


@app.post("/api/jobs/{job_id}/reprocess/{item_id}")
async def reprocess_item(
    job_id: str,
    item_id: str,
    background_tasks: BackgroundTasks,
    prompt: str = Form(...),
    edit_type: str = Form("transform"),
    strength: float = Form(0.75),
    model: str = Form("gemini-3.1-flash-image-preview"),
    user: dict = Depends(require_auth),
):
    """Re-run a single item with (optionally different) parameters."""
    job = await db_get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")

    item = next((i for i in job["items"] if i["id"] == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # Prefer the previously generated output as the new base image (iterative edits)
    base_path = Path(job["temp_dir"]) / item["filename"]
    if item.get("output_url"):
        out_name = Path(item["output_url"]).name
        candidate = _OUTPUT_DIR / job_id / out_name
        if candidate.exists():
            base_path = candidate

    await db_update_item(job_id, item_id, status="processing", sub_status=None, error_msg=None, output_url=None)
    await db_update_job(job_id, status="processing")

    api_key = os.getenv("GEMINI_API_KEY", "")
    output_dir = _OUTPUT_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    background_tasks.add_task(
        _process_item_with_retry,
        job_id=job_id,
        item=item,
        prompt=prompt,
        edit_type=edit_type,
        strength=float(strength),
        model=model,
        file_path=base_path,
        output_dir=output_dir,
        api_key=api_key,
    )

    # After this single item finishes, set job back to completed
    async def _finalize():
        await asyncio.sleep(0.5)  # let background task start first
        # Poll until item is no longer processing
        for _ in range(600):  # up to 10 min
            await asyncio.sleep(1)
            j = await db_get_job(job_id)
            if not j:
                return
            itm = next((i for i in j["items"] if i["id"] == item_id), None)
            if itm and itm["status"] not in ("processing", "queued"):
                ok_count = sum(1 for i in j["items"] if i["status"] == "ok")
                cost = ok_count * 0.03
                await db_update_job(job_id, status="completed", total_cost=cost)
                return

    background_tasks.add_task(_finalize)
    return {"status": "processing"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
