import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export default function Login() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (user) {
      navigate("/");
    }
  }, [user, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setErrorMsg(error.message);
      setLoading(false);
    } else {
      navigate("/");
    }
  };

  const handleSignUp = async () => {
    setLoading(true);
    setErrorMsg("");

    const { error, data } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      setErrorMsg(error.message);
    } else {
      if (data.session) {
         setErrorMsg("Registro realizado com sucesso!"); // Optional if auto-login
      } else {
         setErrorMsg("Registro enviado. Verifique seu email para confirmar.");
      }
    }
    setLoading(false);
  };

  const handleResetPassword = async () => {
    if (!email) {
       setErrorMsg("Digite o seu email no campo acima para que possamos enviar o link de redefinição.");
       return;
    }
    setLoading(true);
    setErrorMsg("");

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/update-password',
    });

    if (error) {
      setErrorMsg(error.message);
    } else {
      setErrorMsg("Link de redefinição enviado! Verifique a sua caixa de entrada.");
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
          <h1 className="text-2xl font-bold text-slate-800">BananaBatch</h1>
          <p className="text-sm text-slate-500 mt-1">Acesso Restrito ao Sistema</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
              placeholder="estudio@exemplo.com"
            />
          </div>

          <div className="space-y-2 relative">
            <div className="flex justify-between items-center">
               <label className="text-sm font-semibold text-slate-700">Senha</label>
               <button 
                  type="button" 
                  onClick={handleResetPassword}
                  className="text-xs font-medium text-primary hover:text-primary-hover hover:underline transition-all"
               >
                  Esqueceu a senha?
               </button>
            </div>
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
            <div className={`p-3 rounded-lg text-sm border ${errorMsg.includes("sucesso") || errorMsg.includes("Verifique") ? "bg-green-50 text-green-700 border-green-100" : "bg-red-50 text-red-600 border-red-100"}`}>
              {errorMsg === "Invalid login credentials" ? "Email ou senha incorretos." : errorMsg}
            </div>
          )}

          <div className="flex flex-col gap-3 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-slate-800 text-white py-3 rounded-lg text-sm font-semibold shadow-lg shadow-slate-800/20 hover:bg-slate-900 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? "Processando..." : "Fazer Login Seguro"}
              </button>
              
              <div className="flex items-center gap-3 my-2 opacity-60">
                 <div className="flex-1 h-px bg-slate-300"></div>
                 <span className="text-[10px] uppercase font-bold text-slate-500">Ou</span>
                 <div className="flex-1 h-px bg-slate-300"></div>
              </div>

              <button
                type="button"
                onClick={handleSignUp}
                disabled={loading || !email || !password}
                className="w-full bg-white border border-slate-300 text-slate-700 py-3 rounded-lg text-sm font-semibold hover:bg-slate-50 hover:border-slate-400 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                Criar uma nova conta
              </button>
          </div>
        </form>
      </div>
    </div>
  );
}
