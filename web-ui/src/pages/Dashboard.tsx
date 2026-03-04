import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { LogOut, Plus, List, AlertCircle, RefreshCw } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { Link, useNavigate } from "react-router-dom";

export default function Dashboard() {
  const { signOut, user } = useAuth();
  const navigate = useNavigate();
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  const loadBatches = async () => {
    setLoading(true);
    setErrorMsg("");
    const { data, error } = await supabase
      .from("batches")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
       // If table doesn't exist yet, gracefully catch it for user
       if (error.code === '42P01' || error.message?.includes("Could not find the table")) {
          setErrorMsg("A tabela 'batches' ainda não foi criada no Supabase.");
       } else {
          setErrorMsg(error.message);
       }
    } else {
      setBatches(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadBatches();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <List className="w-4 h-4" />
          </div>
          <h1 className="font-bold text-slate-800 tracking-tight">BananaBatch</h1>
        </div>
        
        <div className="flex items-center gap-4">
           <span className="text-xs font-medium text-slate-500 bg-slate-100 px-3 py-1.5 rounded-full">
              {user?.email}
           </span>
           <button 
             onClick={signOut}
             className="text-slate-500 hover:text-red-500 transition-colors p-2"
             title="Sair"
           >
             <LogOut className="w-4 h-4" />
           </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-6 md:p-10 space-y-6">
         <div className="flex justify-between items-end">
            <div>
               <h2 className="text-2xl font-bold text-slate-800">Meus Lotes</h2>
               <p className="text-sm text-slate-500 mt-1">Histórico de processamento de imagens</p>
            </div>
            <Link 
              to="/editor" 
              className="bg-slate-800 text-white px-5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 shadow-lg shadow-slate-800/20 hover:bg-slate-900 active:scale-95 transition-all"
            >
              <Plus className="w-4 h-4" /> Novo Lote
            </Link>
         </div>

         {loading ? (
             <div className="flex justify-center items-center py-20 text-slate-400">
               <RefreshCw className="w-6 h-6 animate-spin" />
             </div>
         ) : errorMsg ? (
             <div className="bg-red-50 border border-red-100 rounded-xl p-6 text-center text-red-600 flex flex-col items-center">
                <AlertCircle className="w-8 h-8 mb-3 opacity-80" />
                <h3 className="font-bold mb-1">Erro ao carregar o histórico</h3>
                <p className="text-sm">{errorMsg}</p>
                {errorMsg.includes("não foi criada") && (
                   <p className="text-xs mt-3 bg-white/50 px-4 py-2 rounded-lg">
                      Abra o SQL Editor no painel do Supabase e rode:<br />
                      <code className="block mt-2 font-mono text-left bg-black text-green-400 p-3 rounded text-[11px] overflow-x-auto">
                         CREATE TABLE batches ( id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID REFERENCES auth.users(id), job_id TEXT NOT NULL, prompt TEXT, model TEXT, status TEXT, created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() );
                      </code>
                   </p>
                )}
             </div>
         ) : batches.length === 0 ? (
             <div className="bg-white border border-slate-200 border-dashed rounded-2xl flex flex-col items-center justify-center p-12 text-slate-500">
                <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                    <List className="w-6 h-6 text-slate-400" />
                </div>
                <h3 className="text-lg font-bold text-slate-700 mb-1">Nenhum lote salvo</h3>
                <p className="text-sm text-center max-w-sm mb-6">
                    Você ainda não processou imagens que foram enviadas para o banco de dados.
                </p>
                <Link to="/editor" className="text-primary font-semibold text-sm hover:underline">
                    Começar um lote agora &rarr;
                </Link>
             </div>
         ) : (
             <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table className="w-full text-left text-sm">
                   <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                         <th className="px-6 py-4">Data</th>
                         <th className="px-6 py-4">Job ID</th>
                         <th className="px-6 py-4">Prompt</th>
                         <th className="px-6 py-4">Modelo</th>
                         <th className="px-6 py-4">Status</th>
                      </tr>
                   </thead>
                    <tbody className="divide-y divide-slate-100">
                      {batches.map((batch) => (
                          <tr 
                            key={batch.id} 
                            onClick={() => navigate(`/editor?job_id=${batch.job_id}`)}
                            className="hover:bg-slate-50 transition-colors cursor-pointer group"
                            title="Ver imagens processadas"
                          >
                              <td className="px-6 py-4 text-slate-500">
                                 {new Date(batch.created_at).toLocaleDateString()}
                              </td>
                              <td className="px-6 py-4 font-mono text-xs text-slate-400">
                                 {batch.job_id.split('-')[0]}...
                              </td>
                              <td className="px-6 py-4 text-slate-700 max-w-[200px] truncate group-hover:text-primary transition-colors">
                                 {batch.prompt || "-"}
                              </td>
                              <td className="px-6 py-4 text-slate-500 text-xs font-mono">
                                 {batch.model || "-"}
                              </td>
                              <td className="px-6 py-4">
                                 <span className="bg-green-100 text-green-700 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">
                                     {batch.status}
                                 </span>
                              </td>
                          </tr>
                      ))}
                   </tbody>
                </table>
                <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-center">
                    <Link to="/editor" className="bg-slate-800 text-white px-6 py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 hover:bg-slate-900 shadow-sm transition-colors cursor-pointer">
                       <Plus className="w-4 h-4" /> Começar um Novo Lote
                    </Link>
                </div>
             </div>
         )}
      </main>
    </div>
  );
}
