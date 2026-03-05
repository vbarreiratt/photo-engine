import { useState, useRef, useEffect, useMemo } from "react";
import { 
  UploadCloud, Settings, Image as ImageIcon, Sparkles, 
  CheckCircle2, AlertCircle, RefreshCw, Download, 
  Maximize2, X, ChevronLeft, ChevronRight, Archive, ArrowLeft, Save, Plus
} from "lucide-react";
import { CurvesEditor, computeImageHistogram, applyLUT, computeSplineLUT } from "../components/CurvesEditor";

// API configs
const API_URL = (import.meta.env.VITE_API_URL as string) ?? "/api";

const ImagePreviewNode = ({ url, adj, onHistogramUpdate }: any) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        img.onload = () => {
            const canvas = canvasRef.current;
            if(!canvas) return;
            const maxW = 1200;
            let w = img.width;
            let h = img.height;
            if(w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if(!ctx) return;

            ctx.filter = `brightness(${adj?.brightness ?? 100}%) contrast(${adj?.contrast ?? 100}%) saturate(${adj?.saturate ?? 100}%)`;
            ctx.drawImage(img, 0, 0, w, h);
            ctx.filter = 'none';

            const imgData = ctx.getImageData(0, 0, w, h);
            
            // Decouple histogram update to avoid render loops
            const hist = computeImageHistogram(imgData);
            if(onHistogramUpdate) {
                setTimeout(() => onHistogramUpdate(hist), 0);
            }

            if (adj?.points && adj.points.length >= 2) {
                const lut = computeSplineLUT(adj.points);
                applyLUT(imgData, lut);
                ctx.putImageData(imgData, 0, 0);
            }
        };
    }, [url, adj]); // removed onHistogramUpdate intentionally to prevent loop

    return <canvas ref={canvasRef} className="max-w-full max-h-full object-contain transition-none shadow-lg rounded" />;
};

import { supabase } from "../lib/supabase";
import { useAuth } from "../contexts/AuthContext";
import { Link, useSearchParams } from "react-router-dom";

export default function BatchEditor() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [files, setFiles] = useState<File[]>([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gemini-3.1-flash-image-preview");
  const [editType, setEditType] = useState("transform");
  const [strength, setStrength] = useState(0.75);
  // Multi-chunk job tracking: one job ID per batch of CHUNK_SIZE images
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobStatuses, setJobStatuses] = useState<Record<string, any>>({});

  // Backward-compat alias for single-job operations (reprocess, save)
  const jobId = jobIds[0] ?? null;

  // Merge all chunk statuses into a single virtual job status for the UI
  const jobStatus = useMemo(() => {
    const statuses = jobIds.map(id => jobStatuses[id]).filter(Boolean);
    if (statuses.length === 0) return null;
    // Enrich each item with its source job ID so reprocess can target the right job
    const allItems = jobIds.flatMap(jid =>
      (jobStatuses[jid]?.items || []).map((item: any) => ({ ...item, _jobId: jid }))
    );
    const anyActive = statuses.some((s: any) =>
      s.status === "processing" || s.status === "collecting"
    );
    return {
      status: anyActive ? "processing" : "completed",
      items: allItems,
      total_cost: statuses.reduce((sum: number, s: any) => sum + (s.total_cost || 0), 0),
      total_time: statuses.reduce((sum: number, s: any) => sum + (s.total_time || 0), 0),
    };
  }, [jobIds, jobStatuses]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [presets, setPresets] = useState<any[]>([]);
  const [newPresetName, setNewPresetName] = useState("");
  
  // UI States
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [reprocessPrompt, setReprocessPrompt] = useState("");
  const [reprocessStrength, setReprocessStrength] = useState(0.75);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [donts, setDonts] = useState("");
  const [reprocessDonts, setReprocessDonts] = useState("");
  const [adjustments, setAdjustments] = useState<Record<string, { brightness: number, contrast: number, saturate: number, points: {x:number, y:number}[], histogram?: number[] }>>({});
  const [isBatchSaved, setIsBatchSaved] = useState(false);
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  // Upload progress for the new per-file upload flow
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  // Map of item.id -> authenticated blob URL for image display
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper: get Supabase JWT to send as Bearer token to the backend
  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // Initialize from URL search parameters if accessing from Dashboard
  useEffect(() => {
    const qJobId = searchParams.get('job_id');
    if (qJobId) {
      setJobIds([qJobId]);
      setIsSidebarOpen(false);
      setIsBatchSaved(true); // Se veio do dashboard, já está salvo
    }
  }, [searchParams]);

  useEffect(() => {
    const saved = localStorage.getItem("banana_presets");
    if (saved) {
      setPresets(JSON.parse(saved));
    }
  }, []);

  const savePreset = () => {
    if (!newPresetName) return;
    const newPreset = {
      id: Date.now().toString(),
      name: newPresetName,
      prompt,
      donts,
      model,
      editType,
      strength,
    };
    const updated = [...presets, newPreset];
    setPresets(updated);
    localStorage.setItem("banana_presets", JSON.stringify(updated));
    setNewPresetName("");
  };

  const loadPreset = (presetId: string) => {
    if (!presetId) return;
    const preset = presets.find((p) => p.id === presetId);
    if (preset) {
      setPrompt(preset.prompt);
      setDonts(preset.donts || "");
      // Migrate old preset values automatically
      let modelToLoad = preset.model;
      if (modelToLoad === "gemini-2.5-pro-image") {
          modelToLoad = "gemini-3-pro-image-preview";
      } else if (modelToLoad === "gemini-2.5-flash-image") {
          modelToLoad = "gemini-3.1-flash-image-preview";
      }
      setModel(modelToLoad);
      setEditType(preset.editType);
      setStrength(preset.strength);
    }
  };

  // Fetch image via authenticated request and return a local blob URL
  const fetchBlobUrl = async (apiUrl: string): Promise<string> => {
    const headers = await getAuthHeaders();
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return "";
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  // Poll all active job chunks every 2 seconds
  useEffect(() => {
    if (jobIds.length === 0) return;

    let active = true;
    const interval = setInterval(async () => {
      if (!active) return;
      const headers = await getAuthHeaders();

      const snapshots = await Promise.all(
        jobIds.map(jid =>
          fetch(`${API_URL}/jobs/${jid}`, { headers })
            .then(r => r.json())
            .then(data => ({ jid, data }))
            .catch(() => null)
        )
      );

      if (!active) return;

      // Batch-update all statuses at once to avoid multiple re-renders
      setJobStatuses(prev => {
        const next = { ...prev };
        for (const snap of snapshots) {
          if (snap) next[snap.jid] = snap.data;
        }
        return next;
      });

      // Pre-fetch blob URLs for newly completed items across all chunks
      for (const snap of snapshots) {
        if (!snap?.data?.items) continue;
        for (const item of snap.data.items) {
          if (item.status === "ok" && item.output_url && !blobUrls[item.id]) {
            fetchBlobUrl(item.output_url).then(blobUrl => {
              if (blobUrl) setBlobUrls(prev => ({ ...prev, [item.id]: blobUrl }));
            });
          }
        }
      }

      // Determine if all jobs finished
      const loaded = snapshots.filter(Boolean) as { jid: string; data: any }[];
      if (loaded.length < jobIds.length) return;
      const anyProcessing = loaded.some(s =>
        s.data.status === "processing" ||
        s.data.status === "collecting" ||
        s.data.items?.some((i: any) => i.status === "processing" || i.status === "queued")
      );
      if (!anyProcessing) {
        active = false;
        clearInterval(interval);
        setIsProcessing(false);
        // Sync the modal item if it was being reprocessed
        if (selectedItem) {
          for (const { jid, data } of loaded) {
            const updated = data.items?.find((i: any) => i.id === selectedItem.id);
            if (updated) {
              setIsReprocessing(false);
              setSelectedItem({ ...updated, _jobId: jid });
              break;
            }
          }
        }
      }
    }, 2000);

    return () => { active = false; clearInterval(interval); };
  }, [jobIds, selectedItem]);

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...droppedFiles]);
  };

  const handleProcess = async () => {
    if (!files.length || !prompt) return;
    setIsProcessing(true);
    setIsSidebarOpen(false);
    setUploadProgress({ done: 0, total: files.length });

    const finalPrompt = donts.trim()
      ? `${prompt}\n\nO que evitar (não deve ser feito em hipótese alguma): ${donts}`
      : prompt;

    let authHeaders: Record<string, string> = {};
    try {
      authHeaders = await getAuthHeaders();
    } catch {
      alert("Erro de conexão com o servidor. Verifique sua internet e tente novamente.");
      setIsProcessing(false);
      setUploadProgress(null);
      return;
    }

    // Step 1: Create an empty job shell
    let newJobId: string;
    try {
      const initFd = new FormData();
      initFd.append("total_files", files.length.toString());
      initFd.append("prompt", finalPrompt);
      initFd.append("edit_type", editType);
      initFd.append("strength", strength.toString());
      initFd.append("model", model);

      const res = await fetch(`${API_URL}/jobs/init`, {
        method: "POST",
        headers: authHeaders,
        body: initFd,
      });

      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).detail || ""; } catch {}
        throw new Error(
          (res.status === 401 || res.status === 403)
            ? "Sessão inválida ou expirada. Por favor, faça login novamente."
            : `Erro no servidor (${res.status}): ${detail || res.statusText}`
        );
      }

      const data = await res.json();
      newJobId = data.job_id as string;
    } catch (err: any) {
      alert(err.message || "Erro ao iniciar processamento.");
      setIsProcessing(false);
      setUploadProgress(null);
      return;
    }

    // Step 2: Upload each file individually with concurrency limit of 5
    // Each request is ~1 file (~30-50 MB max) — well within NPM's 100M limit
    const CONCURRENCY = 5;
    let doneCount = 0;
    const queue = [...files];

    const uploadOne = async (file: File): Promise<void> => {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch(`${API_URL}/jobs/${newJobId}/upload`, {
          method: "POST",
          headers: authHeaders,
          body: fd,
        });
        if (!res.ok) {
          let detail = "";
          try { detail = (await res.json()).detail || ""; } catch {}
          console.error(`Falha no upload de ${file.name}: ${detail}`);
        }
      } catch (err) {
        console.error(`Erro de rede ao enviar ${file.name}:`, err);
      }
      doneCount++;
      setUploadProgress({ done: doneCount, total: files.length });
    };

    // Run CONCURRENCY workers in parallel draining the queue
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (file) await uploadOne(file);
      }
    });
    await Promise.all(workers);

    // Step 3: All files uploaded — hand off to polling
    setUploadProgress(null);
    setJobIds([newJobId]);
  };

  const handleSaveBatch = async () => {
    if (!user || !jobIds.length) return;
    
    setIsSavingBatch(true);
    const finalStatus = jobStatus?.items?.some((i: any) => i.status === "processing") ? "processing" : "completed";
    
    const { error } = await supabase.from("batches").insert([{ 
       user_id: user.id, 
       job_id: jobId, 
       prompt: prompt,
       model: model,
       status: finalStatus
    }]);
    
    setIsSavingBatch(false);
    
    if (error) {
       console.warn("Supabase insert error:", error);
       alert("Erro ao salvar lote no histórico: " + error.message);
    } else {
       setIsBatchSaved(true);
    }
  };

  const handleReprocess = async () => {
    // Use the item's own job ID (set when merging statuses) or fall back to first chunk
    const targetJobId = selectedItem?._jobId || jobIds[0];
    if (!selectedItem || !targetJobId || !reprocessPrompt) return;

    setIsReprocessing(true);
    const formData = new FormData();

    const finalReprocessPrompt = reprocessDonts.trim() ? `${reprocessPrompt}\n\nO que evitar (não deve ser feito em hipótese alguma): ${reprocessDonts}` : reprocessPrompt;
    formData.append("prompt", finalReprocessPrompt);

    formData.append("edit_type", editType);
    formData.append("strength", reprocessStrength.toString());
    formData.append("model", model);

    try {
      const authHeaders = await getAuthHeaders();
      await fetch(`${API_URL}/jobs/${targetJobId}/reprocess/${selectedItem.id}`, {
        method: "POST",
        headers: authHeaders,
        body: formData,
      });
      // Will naturally update via polling interval!
    } catch (err) {
      alert("Error triggering reprocess.");
      setIsReprocessing(false);
    }
  };

  const handleDownloadZip = async () => {
    if (!jobIds.length) return;
    setIsDownloadingZip(true);
    try {
      const authHeaders = await getAuthHeaders();
      const usePartSuffix = jobIds.length > 1;
      for (let i = 0; i < jobIds.length; i++) {
        const jid = jobIds[i];
        const res = await fetch(`${API_URL}/jobs/${jid}/download`, { headers: authHeaders });
        if (!res.ok) { alert(`Erro ao baixar ZIP (parte ${i + 1})`); continue; }
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = usePartSuffix
          ? `bananabatch_parte${i + 1}.zip`
          : `bananabatch_${jid}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      }
    } catch (err) {
      console.error(err);
      alert("Erro ao baixar ZIP");
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const openItemModal = (item: any) => {
    setSelectedItem(item);
    setReprocessPrompt(prompt); // load original prompt as suggestion
    setReprocessDonts(donts); // load original donts as suggestion
    setReprocessStrength(strength);
  };

  const downloadSingleImage = async (url: string, filename: string, adj?: { brightness: number, contrast: number, saturate: number, points?: {x:number, y:number}[] }) => {
    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch(url, { headers: authHeaders });
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const hasCurves = adj?.points && adj.points.length >= 2;
      
      if (!adj || (adj.brightness === 100 && adj.contrast === 100 && adj.saturate === 100 && !hasCurves)) {
         // Direct download
         const a = document.createElement("a");
         a.href = blobUrl;
         a.download = filename;
         document.body.appendChild(a);
         a.click();
         document.body.removeChild(a);
         URL.revokeObjectURL(blobUrl);
         return;
      }
      
      // Canvas logic for customized adjustments
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = blobUrl;
      
      await new Promise((resolve) => {
         img.onload = resolve;
      });
      
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
         ctx.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturate}%)`;
         ctx.drawImage(img, 0, 0);
         
         if (hasCurves) {
             const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
             const lut = computeSplineLUT(adj.points!);
             applyLUT(imgData, lut);
             ctx.putImageData(imgData, 0, 0);
         }
         
         canvas.toBlob(async (bl) => {
            if (!bl) return;
            
            // Inject 300 DPI into JFIF header of the final output JPG
            const buffer = await bl.arrayBuffer();
            const dv = new DataView(buffer);
            let offset = 0;
            if (dv.getUint16(offset) === 0xffd8) { // Is JPEG?
                offset += 2;
                while (offset < dv.byteLength) {
                    const marker = dv.getUint16(offset);
                    const len = dv.getUint16(offset + 2);
                    if (marker === 0xffe0) { // APP0 JFIF
                        if (dv.getUint32(offset + 4) === 0x4a464946) {
                            dv.setUint8(offset + 11, 1); // 1 = dots per inch
                            dv.setUint16(offset + 12, 300); // X density
                            dv.setUint16(offset + 14, 300); // Y density
                            break;
                        }
                    }
                    offset += 2 + len;
                }
            }
            
            const highDpiBlob = new Blob([buffer], { type: "image/jpeg" });
            const newBlobUrl = URL.createObjectURL(highDpiBlob);
            const a = document.createElement("a");
            a.href = newBlobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(newBlobUrl);
            URL.revokeObjectURL(blobUrl);
         }, "image/jpeg", 1.0);
      }
    } catch (error) {
       console.error("Error downloading image:", error);
    }
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-800 font-sans overflow-hidden">
      
      {/* Sidebar - Google Cloud Style */}
      <aside className={`bg-white border-r border-slate-200 flex flex-col z-10 shadow-elevation-1 transition-all duration-300 ${isSidebarOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
        <div className="h-16 flex items-center px-4 border-b border-slate-200 shrink-0 w-80 gap-3">
          <Link to="/" className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition-colors flex-shrink-0" title="Voltar ao Dashboard">
             <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 text-primary">
            <Sparkles className="h-5 w-5" />
            <h1 className="text-sm font-bold text-slate-900 tracking-tight whitespace-nowrap">BananaBatch Editor</h1>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-8 w-80">
          
          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Settings className="w-4 h-4" /> Presets e Configuração
            </h2>

            <div className="space-y-2 pb-4 border-b border-slate-100">
              <label className="text-sm font-medium text-slate-700">Carregar Preset Salvo</label>
              <select 
                onChange={(e) => loadPreset(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded text-sm p-2 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-medium"
              >
                <option value="">-- Selecione ou Manual --</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Modelo</label>
              <select 
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded text-sm p-2 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
              >
                <option value="gemini-3.1-flash-image-preview">Gemini 3.1 Flash Image (Preview)</option>
                <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image (Preview)</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Tipo (Variância)</label>
              <select 
                value={editType}
                onChange={(e) => setEditType(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded text-sm p-2 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
              >
                <option value="transform">Transformação (Geral)</option>
                <option value="masking">Masking</option>
                <option value="inpainting">Inpainting</option>
              </select>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between">
                <label className="text-sm font-medium text-slate-700">Variação da Edição</label>
                <span className="text-xs font-semibold text-primary">{Math.round(strength * 100)}%</span>
              </div>
              <input 
                type="range" 
                min="0.0" max="1.0" step="0.05"
                value={strength}
                onChange={(e) => setStrength(parseFloat(e.target.value))}
                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              Prompt
            </h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ex: Altere o fundo para uma paisagem cyberpunk..."
              className="w-full h-32 bg-slate-50 border border-slate-200 rounded p-3 text-sm resize-none outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
            />
          </div>

          <div className="space-y-4">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              O que evitar (Donts)
            </h2>
            <textarea
              value={donts}
              onChange={(e) => setDonts(e.target.value)}
              placeholder="Ex: sem alterar a pessoa, sem rostos distorcidos, sem fundo branco..."
              className="w-full h-20 bg-slate-50 border border-slate-200 rounded p-3 text-sm resize-none outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400/20 transition-all text-red-900 placeholder:text-red-300"
            />
          </div>

          <div className="pt-2 border-t border-slate-100 flex gap-2">
             <input type="text" placeholder="Nome do Preset" value={newPresetName} onChange={e => setNewPresetName(e.target.value)} className="w-[60%] bg-white border border-slate-200 rounded text-xs p-2 outline-none" />
             <button onClick={savePreset} disabled={!newPresetName} className="flex-1 bg-slate-200 text-slate-700 disabled:opacity-50 text-xs rounded font-medium hover:bg-slate-300 transition-colors">Salvar Preset</button>
          </div>

          <button
            onClick={handleProcess}
            disabled={isProcessing || files.length === 0 || !prompt}
            className="w-full py-3 mt-4 px-4 bg-green-600 text-white rounded-lg text-sm font-bold shadow-lg shadow-green-600/20 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:-translate-y-0.5 active:translate-y-0"
          >
            {isProcessing ? (uploadProgress ? `Enviando ${uploadProgress.done}/${uploadProgress.total}...` : "Processando...") : `Processar ${files.length} imagens`}
          </button>
        </div>
      </aside>

      {/* Main Container */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-slate-50/50">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center px-4 shrink-0 z-0 justify-between">
          <div className="flex items-center gap-4">
            <button 
                onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
                className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                title="Toggle Sidebar"
            >
                {isSidebarOpen ? <ChevronLeft className="w-5 h-5 text-slate-600"/> : <ChevronRight className="w-5 h-5 text-slate-600"/>}
            </button>
            <div className="text-sm text-slate-500 flex items-center gap-2">
              Workspace / <span className="font-semibold text-slate-800">Processamento em Massa</span>
              
              {jobStatus && jobStatus.status !== "processing" && jobStatus.total_time && (
                 <div className="ml-4 flex items-center gap-3 border-l border-slate-200 pl-4">
                    <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded text-xs font-medium border border-slate-200">
                      ⏱ Tempo Total: {jobStatus.total_time.toFixed(1)}s
                    </span>
                    <span className="bg-green-50 text-green-700 px-2 py-1 rounded text-xs font-medium border border-green-200">
                      💰 Custo Processamento: ${(jobStatus.total_cost || 0).toFixed(4)}
                    </span>
                 </div>
              )}
            </div>
          </div>

          {jobStatus && jobStatus.status !== "processing" && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setJobIds([]);
                  setJobStatuses({});
                  setFiles([]);
                  setIsSidebarOpen(true);
                  setIsBatchSaved(false);
                  setSearchParams({});
                }}
                className="flex items-center gap-2 px-4 py-2 bg-transparent text-slate-500 text-sm font-medium rounded hover:bg-slate-100 transition-colors mr-2"
              >
                <Plus className="w-4 h-4" /> Novo Lote
              </button>
              <button 
                onClick={handleSaveBatch}
                disabled={isBatchSaved || isSavingBatch}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-medium rounded hover:bg-slate-50 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4 text-slate-500" /> {isBatchSaved ? "Lote Salvo!" : isSavingBatch ? "Salvando..." : "Salvar Lote"}
              </button>
              <button 
                onClick={handleDownloadZip}
                disabled={isDownloadingZip}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded hover:bg-slate-900 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-[180px] justify-center"
              >
                {isDownloadingZip ? (
                  <RefreshCw className="w-4 h-4 animate-spin"/>
                ) : (
                  <Archive className="w-4 h-4"/>
                )}
                {isDownloadingZip ? "Compactando..." : "Baixar Tudo (.zip)"}
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-6xl mx-auto space-y-8">
            
            {/* Upload progress screen — shown while files are being sent one-by-one */}
            {uploadProgress && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 flex flex-col items-center justify-center text-center space-y-6">
                <div className="h-16 w-16 bg-primary/10 text-primary rounded-full flex items-center justify-center">
                  <UploadCloud className="w-8 h-8 animate-pulse" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800 mb-1">Enviando imagens...</h3>
                  <p className="text-sm text-slate-500">{uploadProgress.done} de {uploadProgress.total} arquivos enviados</p>
                </div>
                <div className="w-full max-w-md">
                  <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-primary h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${(uploadProgress.done / uploadProgress.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-slate-400 mt-2">{Math.round((uploadProgress.done / uploadProgress.total) * 100)}%</p>
                </div>
              </div>
            )}

            {!uploadProgress && !jobStatus ? (
              // Upload Area Active
              <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 bg-white rounded-xl p-12 flex flex-col items-center justify-center text-center cursor-pointer hover:border-primary hover:bg-slate-50 transition-all group"
              >
                <div className="h-16 w-16 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center group-hover:bg-primary/10 group-hover:text-primary transition-all mb-4">
                  <UploadCloud className="w-8 h-8" />
                </div>
                <h3 className="text-lg font-medium text-slate-800 mb-1">Arraste ou Clique para inserir arquivos</h3>
                <p className="text-sm text-slate-500">Imagens JPG, PNG e WEBP suportadas</p>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  ref={fileInputRef}
                  onChange={(e) => e.target.files && handleFiles(e.target.files)}
                />
              </div>
            ) : null}

            {files.length > 0 && !jobStatus && !uploadProgress && (
              <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <ImageIcon className="w-4 h-4 text-slate-400" /> 
                  Fila de Arquivos ({files.length})
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {files.map((file, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 border border-slate-100 rounded-lg bg-slate-50">
                      <div className="w-8 h-8 bg-slate-200 rounded shrink-0 flex items-center justify-center text-xs font-medium text-slate-500 uppercase overflow-hidden">
                        {file.name.split('.').pop()?.substring(0,3)}
                      </div>
                      <span className="text-xs font-medium truncate" title={file.name}>{file.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Results Grid */}
            {jobStatus && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold tracking-tight text-slate-800">Resultados da Edição</h2>
                  {jobStatus.status === "processing" ? (
                    <div className="flex items-center gap-2 text-sm text-primary font-medium bg-primary/10 px-3 py-1.5 rounded-full">
                      <RefreshCw className="w-4 h-4 animate-spin" /> Em Processamento...
                    </div>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {jobStatus.items.map((item: any) => (
                    <div key={item.id} className="bg-white border text-sm font-normal border-slate-200 rounded-xl overflow-hidden shadow-elevation-1 flex flex-col group p-1 transition-all hover:border-primary/50 hover:shadow-elevation-2">
                      
                      <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-white">
                        <span className="font-medium text-slate-700 truncate mr-4 text-xs" title={item.filename}>{item.filename}</span>
                        {item.status === "processing" ? (
                          <RefreshCw className="w-4 h-4 text-slate-400 animate-spin shrink-0" />
                        ) : item.status === "ok" ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
                        )}
                      </div>

                      <div 
                         className="aspect-square bg-slate-100 flex items-center justify-center relative overflow-hidden cursor-pointer"
                         onClick={() => openItemModal(item)}
                      >
                        {item.status === "ok" && item.output_url ? (
                          <img 
                            src={blobUrls[item.id] || ""} 
                            className={`object-cover w-full h-full transform group-hover:scale-105 transition-transform duration-500 ${!blobUrls[item.id] ? 'opacity-0' : 'opacity-100'}`} 
                            alt="Resultado" 
                          />
                        ) : item.status === "processing" ? (
                          <div className="flex flex-col items-center justify-center p-3 text-center w-full">
                              <RefreshCw className="w-5 h-5 text-primary animate-spin mb-3 shadow-none" />
                              <div className="text-[11px] font-medium text-slate-500 px-2 break-words w-full text-center">
                                 {item.sub_status || "Iniciando processo..."}
                              </div>
                          </div>
                        ) : item.status === "error" ? (
                          <div className="p-4 text-xs text-red-500 text-center">{item.error_msg}</div>
                        ) : null}

                        {/* Hover Overlay */}
                        {item.status !== "processing" && (
                           <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <div className="bg-white/90 backdrop-blur text-slate-800 rounded-full p-3 shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-all duration-300">
                                 <Maximize2 className="w-5 h-5"/>
                              </div>
                           </div>
                        )}
                      </div>
                      
                      {/* Cost and Time Metadata below image */}
                      {item.status === "ok" && (
                         <div className="p-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-[11px] font-medium text-slate-500">
                            <div>⏱ {item.processing_time?.toFixed(1) || "0.0"}s</div>
                            <div>${item.estimated_cost?.toFixed(3) || "0.00"}</div>
                         </div>
                      )}
                      
                      {item.status === "ok" && (
                         <div className="p-2 opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-12 right-3 z-10">
                           <button 
                             onClick={(e) => {
                                e.stopPropagation();
                                const url = blobUrls[item.id] || `${API_URL.replace('/api','')}${item.output_url}`;
                                const filename = item.output_url.split('/').pop() || 'image.jpg';
                                downloadSingleImage(url, filename);
                             }}
                             className="h-8 w-8 bg-white text-slate-700 rounded-full flex items-center justify-center hover:bg-primary hover:text-white shadow hover:border-transparent transition-all"
                           >
                             <Download className="w-4 h-4" />
                           </button>
                         </div>
                      )}
                    </div>
                  ))}
                </div>

                {jobStatus.status !== "processing" && (
                  <div className="flex justify-center pt-8">
                     <button 
                       onClick={() => {
                         setJobIds([]);
                         setJobStatuses({});
                         setFiles([]);
                         setIsSidebarOpen(true);
                         setIsBatchSaved(false);
                         setSearchParams({});
                       }}
                       className="px-6 py-2.5 bg-white border border-slate-300 text-slate-700 font-medium rounded shadow-sm hover:bg-slate-50 transition-colors"
                     >
                       Novo Lote
                     </button>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </main>

      {/* Modal / Lightbox */}
      {selectedItem && (
         <div className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4 lg:p-12">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-full flex flex-col md:flex-row overflow-hidden relative">
               
               <button onClick={() => setSelectedItem(null)} className="absolute top-4 right-4 z-10 p-2 bg-black/10 hover:bg-black/20 text-white rounded-full transition-colors backdrop-blur">
                  <X className="w-5 h-5" />
               </button>

               {/* Left: Image Display */}
               <div className="flex-1 bg-slate-100 relative min-h-[300px] min-w-0 flex items-center justify-center p-4">
                   {selectedItem.status === "ok" && selectedItem.output_url ? (
                      <ImagePreviewNode 
                           url={blobUrls[selectedItem.id] || `${API_URL.replace('/api','')}${selectedItem.output_url}`}
                           adj={adjustments[selectedItem.id]}
                           onHistogramUpdate={(hist: number[]) => {
                               setAdjustments(prev => {
                                   const cur = prev[selectedItem.id];
                                   // Only update if array is actually different to avoid render loops, although ImagePreviewNode already decouples
                                   if (cur?.histogram && cur.histogram.length > 0) return prev; 
                                   return {
                                       ...prev,
                                       [selectedItem.id]: {
                                           ...(cur || {brightness: 100, contrast: 100, saturate: 100, points: [{x:0,y:0}, {x:255,y:255}]}),
                                           histogram: hist
                                       }
                                   };
                               });
                           }}
                      />
                   ) : selectedItem.status === "processing" ? (
                      <div className="flex flex-col items-center text-slate-500 max-w-sm text-center">
                         <RefreshCw className="w-8 h-8 animate-spin mb-4 text-primary" />
                         <span className="font-medium text-sm">{selectedItem.sub_status || "Processando arquivo..."}</span>
                      </div>
                   ) : (
                      <div className="p-8 text-center text-red-500 max-w-md">
                         <AlertCircle className="w-8 h-8 mx-auto mb-4" />
                         <span className="font-medium">{selectedItem.error_msg}</span>
                      </div>
                   )}
               </div>

               {/* Right: Tools & Reprocess */}
               <div className="w-full md:w-[450px] bg-white p-6 md:p-8 flex flex-col border-l border-slate-100 overflow-y-auto shrink-0">
                  <div className="mb-6">
                     <h3 className="text-lg font-bold text-slate-800">Auditoria de Imagem</h3>
                     <p className="text-sm text-slate-500 break-all">{selectedItem.filename}</p>
                  </div>

                  {selectedItem.status === "ok" && (
                     <div className="flex items-center gap-2 mb-6 bg-green-50 text-green-700 px-4 py-3 rounded-lg border border-green-100">
                        <CheckCircle2 className="w-5 h-5" />
                        <span className="text-sm font-medium">Renderização aprovada</span>
                     </div>
                  )}

                  <div className="space-y-6 flex-1">
                     
                     {/* Photoshop curves/lighting */}
                     {selectedItem.status === "ok" && (
                         <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-4">
                             <h4 className="text-sm font-bold text-slate-700 flex flex-col gap-1">
                                 Ajustes Rápidos (Lightroom)
                                 <span className="text-[11px] font-normal text-slate-500">Baixa junto com a imagem</span>
                             </h4>
                             
                             <div className="space-y-3">
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[11px] font-medium text-slate-600">
                                        <label>Brilho</label>
                                        <span>{adjustments[selectedItem.id]?.brightness ?? 100}%</span>
                                    </div>
                                    <input 
                                        type="range" min="50" max="150" step="1" 
                                        value={adjustments[selectedItem.id]?.brightness ?? 100}
                                        onChange={e => setAdjustments(prev => ({...prev, [selectedItem.id]: { ...(prev[selectedItem.id] || {contrast: 100, saturate: 100}), brightness: Number(e.target.value) }}))}
                                        className="w-full h-1 bg-slate-200 rounded appearance-none accent-primary cursor-pointer"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[11px] font-medium text-slate-600">
                                        <label>Contraste</label>
                                        <span>{adjustments[selectedItem.id]?.contrast ?? 100}%</span>
                                    </div>
                                    <input 
                                        type="range" min="50" max="150" step="1" 
                                        value={adjustments[selectedItem.id]?.contrast ?? 100}
                                        onChange={e => setAdjustments(prev => ({...prev, [selectedItem.id]: { ...(prev[selectedItem.id] || {brightness: 100, saturate: 100}), contrast: Number(e.target.value) }}))}
                                        className="w-full h-1 bg-slate-200 rounded appearance-none accent-primary cursor-pointer"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[11px] font-medium text-slate-600">
                                        <label>Saturação</label>
                                        <span>{adjustments[selectedItem.id]?.saturate ?? 100}%</span>
                                    </div>
                                    <input 
                                        type="range" min="0" max="200" step="1" 
                                        value={adjustments[selectedItem.id]?.saturate ?? 100}
                                        onChange={e => setAdjustments(prev => ({...prev, [selectedItem.id]: { ...(prev[selectedItem.id] || {brightness: 100, contrast: 100}), saturate: Number(e.target.value) }}))}
                                        className="w-full h-1 bg-slate-200 rounded appearance-none accent-primary cursor-pointer"
                                    />
                                </div>
                                <div className="space-y-1 pt-4">
                                    <div className="flex justify-between text-[11px] font-medium text-slate-600 mb-2">
                                        <label>Curvas (RGB)</label>
                                    </div>
                                    <CurvesEditor 
                                        points={adjustments[selectedItem.id]?.points || [{x:0, y:0}, {x:255, y:255}]}
                                        onChange={(newPts: {x:number, y:number}[]) => setAdjustments(prev => ({...prev, [selectedItem.id]: { ...(prev[selectedItem.id] || {brightness: 100, contrast: 100, saturate: 100}), points: newPts }}))}
                                        histogram={adjustments[selectedItem.id]?.histogram}
                                    />
                                </div>
                             </div>
                         </div>
                     )}

                     <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700">Comentários (Novo Prompt)</label>
                        <textarea 
                           className="w-full h-24 bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm resize-none outline-none focus:border-primary focus:ring-1 transition-all"
                           placeholder="Ex: Refazer este fundo deixando-o mais realista..."
                           value={reprocessPrompt}
                           onChange={e => setReprocessPrompt(e.target.value)}
                        />
                     </div>

                     <div className="space-y-2 mt-4">
                        <label className="text-sm font-semibold text-slate-700">O que evitar (Donts)</label>
                        <textarea 
                           className="w-full h-16 bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm resize-none outline-none focus:border-red-400 focus:ring-1 transition-all text-red-900 placeholder:text-red-300"
                           placeholder="Ex: sem alterar as bordas, não escurecer a imagem..."
                           value={reprocessDonts}
                           onChange={e => setReprocessDonts(e.target.value)}
                        />
                     </div>

                     <div className="space-y-2">
                        <div className="flex justify-between">
                           <label className="text-sm font-semibold text-slate-700">Força da Variação</label>
                           <span className="text-xs font-bold text-primary">{Math.round(reprocessStrength * 100)}%</span>
                        </div>
                        <input 
                           type="range" 
                           min="0.0" max="1.0" step="0.05"
                           value={reprocessStrength}
                           onChange={(e) => setReprocessStrength(parseFloat(e.target.value))}
                           className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
                        />
                     </div>
                  </div>

                  <div className="pt-6 mt-6 border-t border-slate-100 flex gap-3">
                     {selectedItem.status === "ok" && selectedItem.output_url && (
                        <button 
                           onClick={() => {
                              const url = blobUrls[selectedItem.id] || `${API_URL.replace('/api','')}${selectedItem.output_url}`;
                              const filename = selectedItem.output_url.split('/').pop() || 'image.jpg';
                              downloadSingleImage(url, filename, adjustments[selectedItem.id]);
                           }}
                           className="flex-1 py-3 px-4 bg-slate-100 text-slate-700 rounded-lg text-sm font-semibold hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
                        >
                           <Download className="w-4 h-4"/> Baixar
                        </button>
                     )}
                     <button
                        onClick={handleReprocess}
                        disabled={isReprocessing || selectedItem.status === "processing"}
                        className="flex-1 py-3 px-4 bg-primary text-white rounded-lg text-sm font-semibold shadow-lg shadow-primary/20 hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                     >
                        {isReprocessing || selectedItem.status === "processing" ? "Processando..." : "Reprocessar"}
                     </button>
                  </div>
               </div>
            </div>
         </div>
      )}

    </div>
  );

  function handleFiles(fileList: FileList) {
    const validFiles = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...validFiles]);
  }
}
