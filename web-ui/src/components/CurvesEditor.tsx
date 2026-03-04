import { useRef, useState, useEffect } from 'react';

export function computeSplineLUT(points: {x:number, y:number}[]): Uint8Array {
    const lut = new Uint8Array(256);
    let pts = [...points].sort((a,b) => a.x - b.x);
    if (pts.length === 0) {
        for(let i=0; i<256; i++) lut[i] = i;
        return lut;
    }
    if (pts.length === 1) {
        for(let i=0; i<256; i++) lut[i] = Math.max(0, Math.min(255, pts[0].y));
        return lut;
    }
    
    if (pts[0].x > 0) pts = [{x: 0, y: pts[0].y}, ...pts];
    if (pts[pts.length-1].x < 255) pts.push({x: 255, y: pts[pts.length-1].y});
    
    const unique: {x:number, y:number}[] = [];
    pts.forEach(p => {
        if(unique.length === 0 || unique[unique.length-1].x !== p.x) {
            unique.push(p);
        } else {
            unique[unique.length-1].y = p.y;
        }
    });
    pts = unique;

    const n = pts.length - 1;
    const x = new Float64Array(n + 1);
    const a = new Float64Array(n + 1);
    pts.forEach((p, i) => { x[i] = p.x; a[i] = p.y; });

    const b = new Float64Array(n);
    const d = new Float64Array(n);
    const h = new Float64Array(n);
    const alpha = new Float64Array(n);
    const c = new Float64Array(n + 1);
    const l = new Float64Array(n + 1);
    const mu = new Float64Array(n + 1);
    const z = new Float64Array(n + 1);

    for (let i = 0; i < n; ++i) h[i] = x[i + 1] - x[i];
    for (let i = 1; i < n; ++i) {
        alpha[i] = (3 / h[i]) * (a[i + 1] - a[i]) - (3 / h[i - 1]) * (a[i] - a[i - 1]);
    }

    l[0] = 1; mu[0] = 0; z[0] = 0;
    for (let i = 1; i < n; ++i) {
        l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
        mu[i] = h[i] / l[i];
        z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
    }

    l[n] = 1; z[n] = 0; c[n] = 0;
    for (let j = n - 1; j >= 0; --j) {
        c[j] = z[j] - mu[j] * c[j + 1];
        b[j] = (a[j + 1] - a[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
        d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }

    let p = 0;
    for (let i = 0; i < 256; ++i) {
        while (p < n && i > x[p + 1]) p++;
        const dx = i - x[p];
        let val = a[p] + b[p] * dx + c[p] * dx * dx + d[p] * dx * dx * dx;
        lut[i] = Math.max(0, Math.min(255, Math.round(val)));
    }
    return lut;
}

interface CurvesEditorProps {
    points: {x:number, y:number}[];
    onChange: (pts: {x:number, y:number}[]) => void;
    histogram?: number[];
}

export function CurvesEditor({ points, onChange, histogram }: CurvesEditorProps) {
    const svgRef = useRef<SVGSVGElement>(null);
    const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

    const W = 256;
    const H = 256;
    
    const pts = points.map(p => ({ x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(255, p.y)) }));
    
    // Safeguard, if only 1 point, assume [0,0] and [255,255]
    if (pts.length < 2) {
        pts.push({x:0, y:0}, {x:255, y:255});
    }

    const lut = computeSplineLUT(pts);
    let pathD = `M 0 ${H - lut[0]}`;
    for(let i=1; i<256; i++) {
        pathD += ` L ${i} ${H - lut[i]}`;
    }

    const getMousePos = (e: any) => {
        if (!svgRef.current) return {x:0, y:0};
        const rect = svgRef.current.getBoundingClientRect();
        let clientX = 0;
        let clientY = 0;
        if (e.touches && e.touches.length > 0) {
             clientX = e.touches[0].clientX;
             clientY = e.touches[0].clientY;
        } else {
             clientX = e.clientX;
             clientY = e.clientY;
        }
        return {
             x: Math.max(0, Math.min(255, Math.round((clientX - rect.left) / rect.width * 255))),
             y: Math.max(0, Math.min(255, Math.round((rect.bottom - clientY) / rect.height * 255)))
        };
    };

    const handleSvgPointerDown = (e: any) => {
        const pos = getMousePos(e);
        const thres = 12; // hit distance
        const clickedIdx = pts.findIndex(p => Math.abs(p.x - pos.x) < thres && Math.abs(p.y - pos.y) < thres);
        if (clickedIdx !== -1) {
             setDraggingIdx(clickedIdx);
        } else {
             const newPts = [...pts, pos].sort((a,b) => a.x - b.x);
             onChange(newPts);
             setDraggingIdx(newPts.findIndex(p => p.x === pos.x && p.y === pos.y));
        }
    };

    useEffect(() => {
        const handleMove = (e: any) => {
             if (draggingIdx === null) return;
             // Prevent scrolling when dragging
             if(e.type === 'touchmove') e.preventDefault();
             
             const pos = getMousePos(e);
             
             if (draggingIdx > 0 && draggingIdx < pts.length-1) {
                 const prev = pts[draggingIdx-1];
                 const next = pts[draggingIdx+1];
                 pos.x = Math.max(prev.x + 1, Math.min(next.x - 1, pos.x));
             } else if (draggingIdx === 0) {
                 pos.x = 0;
             } else if (draggingIdx === pts.length - 1) {
                 pos.x = 255;
             }

             const newPts = [...pts];
             newPts[draggingIdx] = pos;
             onChange(newPts);
        };
        const handleUp = () => setDraggingIdx(null);
        
        if (draggingIdx !== null) {
             window.addEventListener('mousemove', handleMove, {passive: false});
             window.addEventListener('mouseup', handleUp);
             window.addEventListener('touchmove', handleMove, {passive: false});
             window.addEventListener('touchend', handleUp);
        }
        return () => {
             window.removeEventListener('mousemove', handleMove);
             window.removeEventListener('mouseup', handleUp);
             window.removeEventListener('touchmove', handleMove);
             window.removeEventListener('touchend', handleUp);
        };
    }, [draggingIdx, pts, onChange]);

    const handleDoubleClickPoint = (e: any, idx: number) => {
         e.stopPropagation();
         if (idx === 0 || idx === pts.length - 1) return;
         const newPts = pts.filter((_, i) => i !== idx);
         onChange(newPts);
    };
    
    let histMax = 1;
    if (histogram) {
       histMax = Math.max(...histogram, 1);
    }

    return (
        <div className="relative w-full aspect-square bg-slate-900 rounded-lg overflow-hidden border border-slate-700 select-none touch-none">
            <svg 
               ref={svgRef}
               viewBox={`0 0 ${W} ${H}`} 
               preserveAspectRatio="none"
               className="w-full h-full cursor-crosshair"
               onMouseDown={handleSvgPointerDown}
               onTouchStart={handleSvgPointerDown}
            >
                {/* Grid */}
                {[...Array(3)].map((_, i) => (
                    <line key={`v${i}`} x1={(i+1)*64} y1="0" x2={(i+1)*64} y2="256" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                ))}
                {[...Array(3)].map((_, i) => (
                    <line key={`h${i}`} x1="0" y1={(i+1)*64} x2="256" y2={(i+1)*64} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                ))}
                
                {/* Center cross */}
                <line x1="0" y1="256" x2="256" y2="0" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />

                {/* Histogram */}
                {histogram && histogram.map((h, i) => {
                    const hNorm = (h / histMax) * 180; // slightly leave space on top
                    if (hNorm < 1) return null;
                    return (
                        <line key={`hist${i}`} x1={i} y1={256} x2={i} y2={256 - hNorm} stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                    );
                })}

                {/* Curve path */}
                <path d={pathD} fill="none" stroke="white" strokeWidth="2" style={{pointerEvents:'none'}} />

                {/* Points */}
                {pts.map((p, i) => (
                    <circle 
                       key={`p${i}`}
                       cx={p.x} 
                       cy={H - p.y} 
                       r="5" 
                       fill="white" 
                       stroke="#0f172a"
                       strokeWidth="1.5"
                       onMouseDown={(e) => { e.stopPropagation(); setDraggingIdx(i); }}
                       onTouchStart={(e) => { e.stopPropagation(); setDraggingIdx(i); }}
                       onDoubleClick={(e) => handleDoubleClickPoint(e, i)}
                       className="cursor-move hover:r-6 transition-all"
                    />
                ))}
            </svg>
        </div>
    );
}

export function computeImageHistogram(imgData: ImageData): number[] {
    const hist = new Array(256).fill(0);
    const data = imgData.data;
    for(let i=0; i<data.length; i+=4) {
        const l = Math.round(0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]);
        if(l >= 0 && l <= 255) hist[l]++;
    }
    return hist;
}

export function applyLUT(imgData: ImageData, lut: Uint8Array) {
    const data = imgData.data;
    for(let i=0; i<data.length; i+=4) {
        data[i] = lut[data[i]];
        data[i+1] = lut[data[i+1]];
        data[i+2] = lut[data[i+2]];
    }
}
