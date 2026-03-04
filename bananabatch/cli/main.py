"""BananaBatch CLI application."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Annotated, Optional

import typer
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

from bananabatch.core.engine import BatchEditProcessor, FileManager
from bananabatch.core.models import EditJobConfig, EditType, JobStatus, ModelName
from bananabatch.providers.gemini import GeminiProvider

load_dotenv()

app = typer.Typer(
    name="bananabatch",
    help="🍌 BananaBatch - Simplified Image Processing",
    add_completion=False,
)
console = Console()

def get_api_key() -> str:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        console.print("[red]Error: GEMINI_API_KEY environment variable not set.[/red]")
        raise typer.Exit(1)
    return key

def print_banner() -> None:
    banner = "[yellow]🍌 BananaBatch[/yellow]\n[dim]AI Image Processing[/dim]"
    console.print(Panel(banner.strip(), border_style="yellow"))

@app.command()
def process(
    target: Annotated[Path, typer.Argument(help="Image file or directory of images to process", exists=True)],
    config: Annotated[Path, typer.Argument(help="JSON file with 'prompt' and 'model'", exists=True)],
    output: Annotated[Path, typer.Option("-o", "--output", help="Output directory")] = Path("outputs"),
    workers: Annotated[int, typer.Option("-w", "--workers", help="Concurrent workers")] = 2,
):
    """Process images using AI instructions from a JSON file."""
    print_banner()
    api_key = get_api_key()

    with open(config) as f:
        config_data = json.load(f)
        
    if "prompt" not in config_data:
        console.print("[red]Error: The JSON config must contain a 'prompt' property.[/red]")
        raise typer.Exit(1)
        
    # Gather images
    image_extensions = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
    images = []
    if target.is_dir():
        for file in target.iterdir():
            if file.suffix.lower() in image_extensions:
                images.append(file.absolute())
    elif target.is_file() and target.suffix.lower() in image_extensions:
        images.append(target.absolute())
        
    if not images:
        console.print(f"[red]Error: No images found at {target}[/red]")
        raise typer.Exit(1)
        
    console.print(f"[dim]Command:[/dim] Process {len(images)} images based on {config.name}")
    
    # Create temp instructions file (which translates user inputs into the engine's expected CSV/JSON batch layout)
    records = []
    for img in images:
        record = config_data.copy()
        record["base_image"] = str(img)
        if "model" not in record:
            record["model"] = "gemini-3.1-flash-image-preview"
        if "edit_type" not in record:
            record["edit_type"] = "transform"
        records.append(record)
        
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(records, f)
        temp_input = Path(f.name)
        
    try:
        model_str = config_data.get("model", "gemini-3.1-flash-image-preview")
        try:
            model_enum = ModelName(model_str)
        except ValueError:
            console.print(f"[yellow]Warning: Invalid model '{model_str}', using default.[/yellow]")
            model_enum = ModelName.GEMINI_FLASH
            
        edit_type_str = config_data.get("edit_type", "transform")
        try:
            edit_type_enum = EditType(edit_type_str)
        except ValueError:
            edit_type_enum = EditType.TRANSFORM

        # We inject the temp config so we reuse the full robust engine processing pipeline
        job_config = EditJobConfig(
            input_file=temp_input,
            output_dir=output,
            default_edit_type=edit_type_enum,
            default_strength=float(config_data.get("strength", 0.75)),
            model=model_enum,
            max_workers=workers,
            api_key=api_key,
        )
        
        provider = GeminiProvider(api_key=api_key, default_model=model_enum.value)
        file_manager = FileManager(job_config.output_dir)
        processor = BatchEditProcessor(provider=provider, config=job_config, file_manager=file_manager)
        
        asyncio.run(_run_edit_with_progress(processor, file_manager))
        
    finally:
        if temp_input.exists():
            temp_input.unlink()

@app.callback(invoke_without_command=True)
def main(ctx: typer.Context):
    if ctx.invoked_subcommand is None:
        print_banner()
        console.print("Usage:")
        console.print("  bananabatch process <IMAGE_OR_DIR> <CONFIG.JSON>")
        console.print("\nExample:")
        console.print("  bananabatch process cat.png config.json\n")

async def _run_edit_with_progress(processor: BatchEditProcessor, file_manager: FileManager) -> None:
    from rich.live import Live
    from rich.spinner import Spinner

    results = []
    completed_count = 0

    with Live(Spinner("dots", text="[cyan]Initializing...[/cyan]"), console=console, refresh_per_second=10) as live:
        async for result in processor.process_stream():
            results.append(result)
            completed_count += 1

            if completed_count == 1:
                progress = Progress(
                    TextColumn("[progress.description]{task.description}"),
                    BarColumn(),
                    MofNCompleteColumn(),
                    TaskProgressColumn(),
                    TimeElapsedColumn(),
                    console=console,
                )
                task = progress.add_task("[cyan]Processing...", total=processor.progress.total)
                live.update(progress)

            if result.status == JobStatus.COMPLETED:
                desc = f"[green]✓[/green] {result.request_id[:8]}..."
            else:
                desc = f"[red]✗[/red] {result.request_id[:8]}..."

            progress.update(task, completed=completed_count, description=desc)

    console.print()

    table = Table(title="Results", show_header=True, header_style="bold cyan")
    table.add_column("Status", justify="center")
    table.add_column("File")
    table.add_column("Time (ms)", justify="right")

    for result in results:
        status = "[green]✓[/green]" if result.status == JobStatus.COMPLETED else "[red]✗[/red]"
        time_str = f"{result.generation_time_ms:.0f}" if result.generation_time_ms else "-"
        output = result.output_path.name if result.output_path else str(result.error_message)
        table.add_row(status, output[:50], time_str)

    console.print(table)
    console.print(f"\n[dim]Output saved to:[/dim] {file_manager.output_dir}")

if __name__ == "__main__":
    app()
