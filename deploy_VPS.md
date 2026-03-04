# 🍌 BananaBatch — Guia de Deploy na VPS

> **Contexto de segurança:** Esta ferramenta processa fotos sensíveis de crianças de um estúdio fotográfico. Toda a configuração de segurança abaixo é obrigatória, não opcional.

---

## Visão Geral da Arquitetura

```
Internet (HTTPS)
      │
  [Nginx] ← proxy reverso + SSL (Let's Encrypt)
      │
  ┌───┴─────────────────────────────┐
  │ VPS Linux (Ubuntu 22.04 LTS)    │
  │                                 │
  │  :3000 → [Next/Vite Frontend]  │ (React, build estático servido pelo Nginx)
  │  :8000 → [FastAPI Backend]      │ (Python + Uvicorn ou Gunicorn)
  │                                 │
  │  /tmp/banana_*  ← imagens temp │ (apagadas ao reiniciar o servidor)
  │  /app/outputs/  ← outputs job  │ (inacessível diretamente — só via API autenticada)
  └─────────────────────────────────┘
        │
  [Supabase Cloud]
  ├── Auth (JWT)          ← valida tokens em cada request ao backend
  └── DB: tabela batches  ← histórico de lotes por usuário
```

---

## Pré-requisitos na VPS

- Ubuntu 22.04 LTS (ou Debian 12)
- Python 3.10+
- Node.js 20 LTS (`nvm` recomendado)
- Nginx
- `certbot` para SSL gratuito (Let's Encrypt)
- Um domínio apontado para o IP da VPS (ex: `bananabatch.seudominio.com.br`)

---

## 1. Preparar o Servidor

```bash
# Atualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar dependências do sistema
sudo apt install -y python3 python3-pip python3-venv nginx certbot python3-certbot-nginx git curl

# Instalar Node.js via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
```

---

## 2. Clonar o Projeto

```bash
# Criar pasta da aplicação
sudo mkdir -p /app/bananabatch
sudo chown $USER:$USER /app/bananabatch

# Clonar o repositório
git clone https://github.com/GH05TCREW/bananabatch /app/bananabatch
cd /app/bananabatch
```

---

## 3. Configurar o Backend (Python/FastAPI)

```bash
cd /app/bananabatch

# Criar ambiente virtual Python
python3 -m venv .venv
source .venv/bin/activate

# Instalar dependências do projeto
pip install -e .

# Instalar dependências adicionais da API web
pip install fastapi uvicorn gunicorn python-multipart httpx
```

### 3.1. Criar o arquivo `.env` do Backend

```bash
cp .env.example .env
nano .env
```

Preencha **todos** os campos:

```env
# API Google Gemini
GEMINI_API_KEY=AIza...

# Supabase (para validação JWT e histórico)
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_PROJECT_ID=nfureglhbglwbnpokpey
SUPABASE_SECRECT_KEY=sb_secret_...
SUPABASE_API_URL=https://nfureglhbglwbnpokpey.supabase.co

# SEGURANÇA: Troque para seu domínio real em produção!
ALLOWED_ORIGIN=https://bananabatch.seudominio.com.br
```

> ⚠️ **CRÍTICO:** `ALLOWED_ORIGIN` deve ser o domínio exato do frontend. Isso bloqueia chamadas de qualquer outra origem (CORS).

---

## 4. Criar a Pasta de Outputs

```bash
mkdir -p /app/bananabatch/outputs
chmod 700 /app/bananabatch/outputs
```

> 🔒 `chmod 700` garante que apenas o usuário do processo tem acesso — o Nginx **nunca** deve ter permissão de servir essa pasta diretamente.

---

## 5. Configurar o Backend como Serviço (Systemd)

```bash
sudo nano /etc/systemd/system/bananabatch.service
```

Cole o conteúdo abaixo (substitua `SEU_USUARIO` pelo usuário real):

```ini
[Unit]
Description=BananaBatch FastAPI Backend
After=network.target

[Service]
User=SEU_USUARIO
Group=SEU_USUARIO
WorkingDirectory=/app/bananabatch
Environment="PATH=/app/bananabatch/.venv/bin"
EnvironmentFile=/app/bananabatch/.env
ExecStart=/app/bananabatch/.venv/bin/gunicorn \
    -k uvicorn.workers.UvicornWorker \
    -w 2 \
    --bind 127.0.0.1:8000 \
    --timeout 300 \
    --access-logfile /var/log/bananabatch/access.log \
    --error-logfile /var/log/bananabatch/error.log \
    bananabatch.api:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
# Criar pasta de logs
sudo mkdir -p /var/log/bananabatch
sudo chown $USER:$USER /var/log/bananabatch

# Ativar e iniciar o serviço
sudo systemctl daemon-reload
sudo systemctl enable bananabatch
sudo systemctl start bananabatch

# Verificar status
sudo systemctl status bananabatch
```

---

## 6. Build do Frontend (React/Vite)

```bash
cd /app/bananabatch/web-ui

# Criar .env do frontend
nano .env
```

```env
VITE_SUPABASE_URL=https://nfureglhbglwbnpokpey.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
```

```bash
# Instalar dependências e fazer build de produção
npm install
npm run build

# O build ficará em /app/bananabatch/web-ui/dist/
```

---

## 7. Configurar Nginx

```bash
sudo nano /etc/nginx/sites-available/bananabatch
```

```nginx
server {
    listen 80;
    server_name bananabatch.seudominio.com.br;
    # O certbot vai adicionar o HTTPS automaticamente

    # --- Frontend estático ---
    root /app/bananabatch/web-ui/dist;
    index index.html;

    # SPA: redirecionar tudo para index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # --- Backend API ---
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Necessário para uploads grandes (fotos de alta resolução)
        client_max_body_size 100M;
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
    }

    # --- BLOQUEAR acesso direto à pasta outputs ---
    # (redundância de segurança — o Nginx não deve nem chegar lá)
    location /app/bananabatch/outputs/ {
        deny all;
        return 403;
    }
}
```

```bash
# Ativar site
sudo ln -s /etc/nginx/sites-available/bananabatch /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 8. Configurar HTTPS (SSL Gratuito)

```bash
sudo certbot --nginx -d bananabatch.seudominio.com.br
```

O Certbot vai:

1. Obter o certificado automaticamente
2. Atualizar o arquivo Nginx com as configs de HTTPS
3. Configurar renovação automática

---

## 9. Configurar Supabase para Produção

No painel do Supabase (`app.supabase.com`), vá em:

**Authentication → URL Configuration**

Adicione a URL de produção nas listas:

- **Site URL:** `https://bananabatch.seudominio.com.br`
- **Redirect URLs:** `https://bananabatch.seudominio.com.br/update-password`

> Isso é necessário para que os links de reset de senha funcionem em produção.

---

## 10. Firewall (UFW)

```bash
# Permitir apenas SSH, HTTP e HTTPS
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
sudo ufw enable

# Verificar
sudo ufw status
```

> ⚡ As portas `8000` (backend) e `5173` (dev) devem ficar **fechadas** — o acesso ao backend só deve ocorrer via Nginx (proxy reverso na porta 443/80).

---

## 11. Hardening Adicional (Recomendado)

### 11.1. Rate Limiting no Nginx (proteção contra força bruta)

Adicione dentro do bloco `server {}` do Nginx:

```nginx
# Limitar requisições à API de autenticação
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=5r/m;

location /api/jobs {
    limit_req zone=auth_limit burst=10 nodelay;
    proxy_pass http://127.0.0.1:8000;
    # ... restante das configs
}
```

### 11.2. Headers de Segurança HTTP

Adicione no bloco `server {}`:

```nginx
add_header X-Frame-Options "DENY";
add_header X-Content-Type-Options "nosniff";
add_header Referrer-Policy "strict-origin-when-cross-origin";
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://*.supabase.co;";
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

### 11.3. Rotação de Logs

```bash
sudo nano /etc/logrotate.d/bananabatch
```

```
/var/log/bananabatch/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload bananabatch
    endscript
}
```

---

## 12. Atualizar a Aplicação (Deploy de Nova Versão)

```bash
cd /app/bananabatch

# Baixar atualizações
git pull origin main

# Rebuild do frontend
cd web-ui && npm install && npm run build && cd ..

# Reiniciar backend
sudo systemctl restart bananabatch

# Verificar que está ok
sudo systemctl status bananabatch
sudo journalctl -u bananabatch -n 50
```

---

## Checklist Final de Segurança

| Item                                                  | Status                    |
| ----------------------------------------------------- | ------------------------- |
| `.env` NÃO está no repositório Git                    | ✅ verifique `.gitignore` |
| `ALLOWED_ORIGIN` apontando para o domínio de produção | ☐                         |
| Porta `8000` bloqueada no firewall                    | ☐                         |
| HTTPS ativo com certificado válido                    | ☐                         |
| Pasta `outputs/` com `chmod 700`                      | ☐                         |
| Supabase Auth configurado com URL de produção         | ☐                         |
| Rate limiting ativo no Nginx                          | ☐                         |
| Logs configurados e com rotação                       | ☐                         |

---

## Troubleshooting Rápido

**Backend não inicia:**

```bash
sudo journalctl -u bananabatch -n 100 --no-pager
```

**Nginx erro 502 Bad Gateway:**

```bash
# Verificar se o backend está rodando
systemctl status bananabatch
curl -s http://127.0.0.1:8000/docs | head -5
```

**Uploads falhando com erro 413:**

```bash
# Aumentar client_max_body_size no nginx.conf
# client_max_body_size 200M;
sudo systemctl reload nginx
```

**Erro de JWT / 401 no backend:**

- Verifique se `SUPABASE_API_URL` e `SUPABASE_ANON_KEY` estão corretos no `.env` do backend.
- O backend valida cada token chamando a API do Supabase em tempo real.

**Reset de senha não redireciona corretamente:**

- Confirme que `https://seudominio.com.br/update-password` está na lista de **Redirect URLs** no painel do Supabase.
