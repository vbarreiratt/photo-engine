"""BananaBatch Streamlit GUI Application.

Dark theme interface matching 'sistema_pai' frontend MVP design.
"""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

import streamlit as st
from dotenv import load_dotenv

from bananabatch.core.engine import BatchEditProcessor, FileManager
from bananabatch.core.models import (
    BatchProgress,
    EditJobConfig,
    EditType,
    ImageResult,
    JobStatus,
    ModelName,
)
from bananabatch.providers.gemini import GeminiProvider

# We load .env if available, otherwise try .env.example
if Path(".env").exists():
    load_dotenv(".env")
elif Path(".env.example").exists():
    load_dotenv(".env.example")
else:
    load_dotenv()

st.set_page_config(
    page_title="Batch Photo Editor",
    page_icon="📸",
    layout="centered",
    initial_sidebar_state="collapsed",
)

def inject_dashboard_css():
    st.markdown("""
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        
        /* Global variables matching MVP */
        :root {
          --bg-color: #0f172a;
          --panel-bg: #1e293b;
          --text-main: #f8fafc;
          --text-muted: #94a3b8;
          --primary: #3b82f6;
          --primary-hover: #2563eb;
          --success: #10b981;
          --error: #ef4444;
          --border: #334155;
          --radius: 12px;
        }

        html, body, [class*="css"], .stMarkdown, p, span, div, label {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
            color: var(--text-main) !important;
        }

        .stApp, .main {
            background-color: var(--bg-color) !important;
        }

        /* Hide default UI elements */
        #MainMenu {visibility: hidden;}
        header {visibility: hidden;}
        footer {visibility: hidden;}
        [data-testid="collapsedControl"] { display: none; }
        
        .block-container {
            max-width: 1000px !important;
            padding-top: 40px !important;
            padding-bottom: 60px !important;
        }

        /* Input Elements */
        .stTextInput input, .stSelectbox [data-baseweb="select"], .stTextArea textarea, .stNumberInput input {
            background-color: var(--bg-color) !important;
            border: 1px solid var(--border) !important;
            border-radius: 8px !important;
            color: #fff !important;
            font-size: 1rem !important;
            padding: 12px !important;
        }
        
        .stTextInput input:focus, .stSelectbox [data-baseweb="select"]:focus, .stTextArea textarea:focus {
            outline: none !important;
            border-color: var(--primary) !important;
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2) !important;
        }
        
        div[data-baseweb="popover"], ul[role="listbox"] {
            background-color: var(--panel-bg) !important;
            border: 1px solid var(--border) !important;
        }
        
        /* Dropzone / Upload area mimicking 'Upload-area' class */
        [data-testid="stFileUploadDropzone"] {
            border: 2px dashed var(--border) !important;
            border-radius: var(--radius) !important;
            background-color: rgba(15, 23, 42, 0.5) !important;
            padding: 40px !important;
        }
        [data-testid="stFileUploadDropzone"]:hover {
            border-color: var(--primary) !important;
            background-color: rgba(59, 130, 246, 0.05) !important;
        }
        [data-testid="stFileUploadDropzone"] div div::before {
            content: '📸';
            font-size: 48px;
            display: block;
            margin-bottom: 16px;
            color: var(--primary);
        }
        
        /* Primary Green Process Button */
        button[data-testid="baseButton-primary"] {
            background-color: var(--success) !important;
            color: white !important;
            border: none !important;
            padding: 16px !important;
            border-radius: 8px !important;
            font-size: 1.2rem !important;
            font-weight: 600 !important;
            width: 100% !important;
            transition: all 0.2s;
            margin-top: 15px !important;
        }
        button[data-testid="baseButton-primary"]:hover {
            background-color: #059669 !important;
            transform: translateY(-1px);
        }
        button[data-testid="baseButton-primary"]:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        
        /* Typography */
        h1 {
            font-size: 2.5rem !important;
            margin-bottom: 8px !important;
            background: linear-gradient(135deg, #60a5fa, #a78bfa) !important;
            -webkit-background-clip: text !important;
            -webkit-text-fill-color: transparent !important;
            text-align: center;
            padding: 0;
        }
        .subtitle {
            color: var(--text-muted) !important;
            font-size: 1.1rem !important;
            text-align: center;
            margin-bottom: 40px !important;
        }

        /* Card Container Hack: we inject this HTML directly above Streamlit blocks */
        .card-container {
            background-color: var(--panel-bg);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 30px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
            margin-bottom: 24px;
        }

        /* Markdown HR to mimic borders */
        hr {
            border-color: var(--border) !important;
        }
        
        /* Slider styling */
        .stSlider [data-baseweb="slider"] {
            accent-color: var(--primary) !important;
        }
        </style>
    """, unsafe_allow_html=True)

def init_session_state() -> None:
    if "is_running" not in st.session_state:
        st.session_state.is_running = False
    if "edit_results" not in st.session_state:
        st.session_state.edit_results = []

async def run_batch_edit(images, prompt, edit_type, strength, model_enum, progress_bar_pl, progress_text_pl):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("API Key missing! Check your .env (or .env.example) file.")

    temp_dir = Path(tempfile.mkdtemp())
    image_paths = {}
    
    for img in images:
        img_path = temp_dir / img.name
        with open(img_path, "wb") as f:
            f.write(img.getbuffer())
        image_paths[img.name] = img_path
        
    records = []
    for img in images:
        records.append({
            "base_image": str(image_paths[img.name]),
            "edit_prompt": prompt,
            "strength": strength,
            "edit_type": edit_type,
            "model": model_enum.value
        })
        
    temp_json = temp_dir / "batch_input.json"
    with open(temp_json, "w") as f:
        json.dump(records, f)
        
    try:
        edit_config = EditJobConfig(
            input_file=temp_json,
            output_dir=Path("outputs"),
            default_edit_type=EditType(edit_type),
            default_strength=strength,
            model=model_enum,
            max_workers=3,
            api_key=api_key,
        )
        provider = GeminiProvider(api_key=api_key, default_model=model_enum.value)
        file_manager = FileManager(edit_config.output_dir)
        processor = BatchEditProcessor(provider=provider, config=edit_config, file_manager=file_manager)
        
        results = []
        async for r in processor.process_stream():
            results.append(r)
            st.session_state.edit_results = results
            
            with progress_bar_pl.container():
                percent = processor.progress.progress_percent / 100.0
                st.progress(percent)
            with progress_text_pl.container():
                total = processor.progress.total
                completed = processor.progress.completed
                errors = processor.progress.failed
                err_text = f" ({errors} erros)" if errors > 0 else ""
                
                st.markdown(f'''
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span>Processando: {completed} / {total} {err_text}</span>
                        <span>{int(percent * 100)}%</span>
                    </div>
                ''', unsafe_allow_html=True)
                
        return results
    finally:
        pass

def main():
    init_session_state()
    inject_dashboard_css()
    
    st.markdown("<h1>Batch Photo Editor</h1>", unsafe_allow_html=True)
    st.markdown("<p class='subtitle'>MVP de Estúdio: Inpainting + Masking com Nano Banana</p>", unsafe_allow_html=True)
    
    api_key_check = os.getenv("GEMINI_API_KEY")
    if not api_key_check:
        st.error("ERRO: GEMINI_API_KEY não encontrada nas variáveis de ambiente. Configure a chave no .env ou .env.example")
        return

    if not st.session_state.is_running and not st.session_state.edit_results:
        st.markdown("<div class='card-container'>", unsafe_allow_html=True)
        col1, col2 = st.columns(2)
        with col1:
            st.markdown("<label style='font-weight: 500; margin-bottom: 8px; display: block;'>Modelo</label>", unsafe_allow_html=True)
            model = st.selectbox("Modelo", options=[m.value for m in ModelName], index=0, label_visibility="collapsed")
            model_enum = ModelName(model)
        with col2:
            st.markdown("<label style='font-weight: 500; margin-bottom: 8px; display: block;'>Tipo de Edição</label>", unsafe_allow_html=True)
            edit_type = st.selectbox("Tipo de Edição", options=[e.value for e in EditType], index=1, label_visibility="collapsed")
            
        st.markdown("<label style='font-weight: 500; margin-bottom: 8px; display: block; margin-top: 16px;'>Prompt (O que gerar na imagem?)</label>", unsafe_allow_html=True)
        prompt = st.text_area("Prompt", height=100, placeholder="Descreva as modificações em detalhes...", label_visibility="collapsed")
        
        st.markdown("<label style='font-weight: 500; margin-bottom: 8px; display: block; margin-top: 16px;'>Força/Intensidade da Modificação</label>", unsafe_allow_html=True)
        strength = st.slider("Intensidade", 0.0, 1.0, 0.75, label_visibility="collapsed")
        
        st.markdown("<div style='margin-bottom: 24px;'></div>", unsafe_allow_html=True)
        st.markdown("<h3 style='text-align: center; font-size: 1.1rem; color: #f8fafc; margin-bottom: 4px;'>Arraste e solte fotos do lote aqui</h3><p style='text-align: center; color: #94a3b8; font-size: 0.9rem;'>Upload em JPEG ou PNG para testar</p>", unsafe_allow_html=True)
        
        uploaded_images = st.file_uploader("Upload", accept_multiple_files=True, type=['png', 'jpg', 'jpeg', 'webp'], label_visibility="collapsed")
        
        if uploaded_images:
            st.markdown(f"<label style='margin-top:20px; display:block;'>Imagens no lote ({len(uploaded_images)}):</label>", unsafe_allow_html=True)
            for f in uploaded_images[:5]:
                st.markdown(f"<div style='background-color:#0f172a; border:1px solid #334155; padding:12px 16px; border-radius:8px; margin-bottom:10px;'><span style='font-size:0.9rem; font-weight:500;'>{f.name}</span></div>", unsafe_allow_html=True)
            if len(uploaded_images) > 5:
                st.markdown(f"<div style='background-color:#0f172a; border:1px solid #334155; padding:12px 16px; border-radius:8px; margin-bottom:10px;'><span style='color:#94a3b8; font-size:0.9rem;'>+ {len(uploaded_images) - 5} outras fotos</span></div>", unsafe_allow_html=True)
                
        if st.button(f"Processar {len(uploaded_images) if uploaded_images else 0} imagens no lote 🚀", type="primary", use_container_width=True, disabled=not uploaded_images or not prompt):
            st.session_state.is_running = True
            
            progress_text_pl = st.empty()
            progress_bar_pl = st.empty()
            
            try:
                res = asyncio.run(run_batch_edit(uploaded_images, prompt, edit_type, strength, model_enum, progress_bar_pl, progress_text_pl))
                st.session_state.edit_results = res
            except Exception as e:
                st.error(f"Erro: {e}")
            finally:
                st.session_state.is_running = False
                st.rerun()
                
        st.markdown("</div>", unsafe_allow_html=True)

    elif st.session_state.edit_results and not st.session_state.is_running:
        st.markdown("<div class='card-container'>", unsafe_allow_html=True)
        st.markdown("<h2 style='margin-top:0;'>Resultados do Lote</h2>", unsafe_allow_html=True)
        
        for res in st.session_state.edit_results:
            status_color = "#065f46" if res.status == JobStatus.COMPLETED else "#7f1d1d"
            status_text = "OK" if res.status == JobStatus.COMPLETED else "ERROR"
            
            st.markdown(f'''
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background-color: #0f172a; border: 1px solid #334155; border-radius: 8px; margin-bottom: 12px;">
                <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 0.9rem; font-weight: 500; color: #f8fafc;">{res.output_path.name if res.output_path else 'Falha na Geração'}</span>
                    {f"<span style='color: #ef4444; font-size: 0.8rem; margin-top: 4px;'>{res.error_message}</span>" if res.error_message else ""}
                </div>
                <span style="background-color: {status_color}; color: #fff; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 600;">
                    {status_text}
                </span>
            </div>
            ''', unsafe_allow_html=True)
            
            if res.status == JobStatus.COMPLETED and res.output_path:
                st.image(str(res.output_path))
                
        st.markdown("<br>", unsafe_allow_html=True)
        if st.button("🔄 Novo Lote", type="primary", use_container_width=True):
            st.session_state.edit_results = []
            st.rerun()
            
        st.markdown("</div>", unsafe_allow_html=True)

if __name__ == "__main__":
    main()
