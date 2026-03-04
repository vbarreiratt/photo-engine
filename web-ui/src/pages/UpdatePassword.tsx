import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function UpdatePassword() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg("");
    setSuccessMsg("");

    const { error } = await supabase.auth.updateUser({
      password: password
    });

    if (error) {
      setErrorMsg(error.message);
    } else {
      setSuccessMsg("Senha atualizada com sucesso! Redirecionando...");
      setTimeout(() => {
         navigate("/");
      }, 2000);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-sm bg-white p-8 rounded-2xl shadow-xl shadow-slate-200/50">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center text-primary mb-4">
            <Sparkles className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Nova Senha</h1>
          <p className="text-sm text-slate-500 mt-1">Digite sua nova senha de acesso</p>
        </div>

        <form onSubmit={handleUpdate} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Nova Senha</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
              placeholder="••••••••"
            />
          </div>

          {errorMsg && (
            <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm border border-red-100">
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="p-3 bg-green-50 text-green-700 rounded-lg text-sm border border-green-100">
              {successMsg}
            </div>
          )}

          <div className="pt-2">
              <button
                type="submit"
                disabled={loading || !password}
                className="w-full bg-primary text-white py-3 rounded-lg text-sm font-semibold shadow-lg shadow-primary/20 hover:bg-primary-hover active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? "Processando..." : "Atualizar Senha"}
              </button>
          </div>
        </form>
      </div>
    </div>
  );
}
