import asyncio
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import io
import time
import zipfile
import httpx

from bananabatch.core.engine import BatchEditProcessor, FileManager
from bananabatch.core.models import (
    EditJobConfig,
    EditType,
    ImageResult,
    JobStatus,
    ModelName,
)
from bananabatch.providers.gemini import GeminiProvider

# Load environment
if Path(".env").exists():
    load_dotenv(".env")
elif Path(".env.example").exists():
    load_dotenv(".env.example")
else:
    load_dotenv()

# CORS: Only allow the frontend origin (set ALLOWED_ORIGIN in .env for production)
_ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "http://localhost:5173")

app = FastAPI(title="BananaBatch API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[_ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Auth: validate Supabase JWT on every protected route
# ---------------------------------------------------------------------------
_SUPABASE_URL = os.getenv("SUPABASE_API_URL", "")
_SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

_bearer = HTTPBearer(auto_error=False)

async def require_auth(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> dict:
    """Validate Supabase Bearer JWT and return the user payload."""
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Authentication required")

    token = credentials.credentials

    # Ask Supabase to validate the token and return the user
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
        return resp.json()  # contains `id`, `email`, etc.
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Could not reach authentication server")

# In-memory job state for MVP - now includes owner_id
JBS: Dict[str, dict] = {}

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

async def process_job(job_id: str, prompt: str, edit_type: str, strength: float, model: str, file_paths: dict, temp_dir: Path):
    start_time = time.time()
    print(f"\n\033[92m🚀 INICIANDO NOVO LOTE [{job_id[:8]}]\033[0m")
    try:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            JBS[job_id]["status"] = "error"
            JBS[job_id]["error_msg"] = "Missing GEMINI_API_KEY"
            return
            
        model_enum = ModelName(model)
        records = []
        for item in JBS[job_id]["items"]:
            path = file_paths[item["filename"]]
            records.append({
                "id": item["id"],
                "base_image": str(path),
                "edit_prompt": prompt,
                "strength": float(strength),
                "edit_type": edit_type,
                "model": model_enum.value
            })
            
        temp_json = temp_dir / "batch_input.json"
        with open(temp_json, "w") as f:
            json.dump(records, f)
            
        output_dir = Path("outputs") / job_id
        output_dir.mkdir(parents=True, exist_ok=True)
        
        edit_config = EditJobConfig(
            input_file=temp_json,
            output_dir=output_dir,
            default_edit_type=EditType(edit_type),
            default_strength=float(strength),
            model=model_enum,
            max_workers=3,
            api_key=api_key,
        )
        
        provider = GeminiProvider(api_key=api_key, default_model=model_enum.value)
        file_manager = FileManager(edit_config.output_dir)
        file_manager.set_output_dir(edit_config.output_dir) # Disable timestamp subfolder
        processor = BatchEditProcessor(provider=provider, config=edit_config, file_manager=file_manager)
        
        def update_substatus(req_id: str, msg: str):
            for item in JBS[job_id]["items"]:
                if item["id"] == req_id:
                    item["sub_status"] = msg
                    curr_time = time.strftime("%H:%M:%S")
                    print(f"\033[94m[{curr_time}]\033[0m \033[93m[{item['filename'][:15]}]\033[0m {msg}")
                    break
                    
        processor.set_status_callback(update_substatus)
        
        total_job_cost = 0.0
        
        async for r in processor.process_stream():
            for item in JBS[job_id]["items"]:
                if item["id"] == r.request_id:
                    if r.status == JobStatus.COMPLETED:
                         item["status"] = "ok"
                         item["output_url"] = f"/api/jobs/{job_id}/files/{Path(r.output_path).name}"
                         # Update metrics
                         item["processing_time"] = r.generation_time_ms / 1000.0 if r.generation_time_ms else 0.0
                         item["estimated_cost"] = 0.03 # Fixed cost per image for Gemini Pro
                         total_job_cost += 0.03
                    else:
                         item["status"] = "error"
                         item["error_msg"] = r.error_message
                    break
        
        JBS[job_id]["status"] = "completed"
        JBS[job_id]["total_time"] = time.time() - start_time
        curr_cost = JBS[job_id].get("total_cost", 0.0)
        JBS[job_id]["total_cost"] = curr_cost + total_job_cost
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        JBS[job_id]["status"] = "error"
        JBS[job_id]["error_msg"] = str(e)
        JBS[job_id]["total_time"] = time.time() - start_time
        for item in JBS[job_id]["items"]:
            if item["status"] == "processing":
                item["status"] = "error"
                item["error_msg"] = f"Global error: {e}"

@app.post("/api/jobs")
async def create_job(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    prompt: str = Form(...),
    edit_type: str = Form("transform"),
    strength: float = Form(0.75),
    model: str = Form("gemini-3.1-flash-image-preview"),
    user: dict = Depends(require_auth),   # <- auth guard
):
    job_id = str(uuid.uuid4())
    temp_dir = Path(tempfile.mkdtemp(prefix=f"banana_{job_id}"))
    
    file_paths = {}
    items = []
    
    for f in files:
        file_path = temp_dir / f.filename
        with open(file_path, "wb") as out:
            shutil.copyfileobj(f.file, out)
        file_paths[f.filename] = file_path
        
        items.append({
            "id": str(uuid.uuid4()),
            "filename": f.filename,
            "status": "processing",
        })
        
    JBS[job_id] = {
        "job_id": job_id,
        "status": "processing",
        "items": items,
        "temp_dir": temp_dir,
        "owner_id": user["id"],  # <- store owner
    }
    
    background_tasks.add_task(process_job, job_id, prompt, edit_type, strength, model, file_paths, temp_dir)
    return {"job_id": job_id, "status": "processing"}

@app.get("/api/jobs/{job_id}", response_model=JobResponse)
async def get_job(job_id: str, user: dict = Depends(require_auth)):
    if job_id not in JBS:
        raise HTTPException(status_code=404, detail="Job not found")
    job = JBS[job_id]
    if job.get("owner_id") and job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return job

@app.get("/api/jobs/{job_id}/files/{filename}")
async def get_file(job_id: str, filename: str, user: dict = Depends(require_auth)):
    # Ownership check
    if job_id not in JBS:
        raise HTTPException(status_code=404, detail="Job not found")
    job = JBS[job_id]
    if job.get("owner_id") and job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    
    # Path traversal protection: ensure filename has no directory components
    safe_filename = Path(filename).name
    if safe_filename != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    file_path = Path("outputs") / job_id / safe_filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    return FileResponse(
        file_path,
        headers={
            "Cache-Control": "no-store",  # never cache sensitive images
            "X-Content-Type-Options": "nosniff",
        }
    )

@app.get("/api/jobs/{job_id}/download")
async def download_job(job_id: str, user: dict = Depends(require_auth)):
    if job_id not in JBS:
        raise HTTPException(status_code=404, detail="Job not found")
    job = JBS[job_id]
    if job.get("owner_id") and job["owner_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
        
    output_dir = Path("outputs") / job_id
    if not output_dir.exists():
        raise HTTPException(status_code=404, detail="Outputs not found")
        
    memory_file = io.BytesIO()
    with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
        for item in JBS[job_id]["items"]:
            if item["status"] == "ok" and item["output_url"]:
                filename = Path(item["output_url"]).name
                file_path = output_dir / filename
                if file_path.exists():
                    zf.write(file_path, filename)
                    
    memory_file.seek(0)
    return StreamingResponse(
        memory_file,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=bananabatch_{job_id}.zip"}
    )

@app.post("/api/jobs/{job_id}/reprocess/{item_id}")
async def reprocess_item(
    job_id: str,
    item_id: str,
    background_tasks: BackgroundTasks,
    prompt: str = Form(...),
    edit_type: str = Form("transform"),
    strength: float = Form(0.75),
    model: str = Form("gemini-3.1-flash-image-preview")
):
    if job_id not in JBS:
        raise HTTPException(status_code=404, detail="Job not found")
        
    job = JBS[job_id]
    item = next((i for i in job["items"] if i["id"] == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
        
    # Determine base image for reprocessing (use latest generated image if available)
    base_file_path = job["temp_dir"] / item["filename"]
    if item.get("output_url"):
        # Extract filename from url: /api/jobs/{job_id}/files/{filename}
        out_filename = Path(item["output_url"]).name
        out_file_path = Path("outputs") / job_id / out_filename
        if out_file_path.exists():
            base_file_path = out_file_path
            
    # Mark item as processing
    item["status"] = "processing"
    item["error_msg"] = None
    item["output_url"] = None
    
    # Reprocess single item reusing the process_job flow
    file_paths = {item["filename"]: base_file_path}
    JBS[job_id]["status"] = "processing" # Reset job state
    
    background_tasks.add_task(process_job, job_id, prompt, edit_type, strength, model, file_paths, job["temp_dir"])
    return {"status": "processing"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
