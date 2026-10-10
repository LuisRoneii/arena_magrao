import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pool } from "./db.js";
import { rotasPublicas } from "./rotas/publicas.js";
import { rotasAdmin } from "./rotas/admin.js";
import { carregarArena } from "./comum.js";
import { tratarErros } from "./erros.js";
import { limiteGeral } from "./limites.js";

export const app = express();

// origens que podem chamar a API (o site). Vírgula para mais de uma.
const origens = (process.env.CORS_ORIGIN || "http://127.0.0.1:5500,http://localhost:5500")
  .split(",")
  .map((o) => o.trim());

// atrás de um proxy (Nginx no servidor), o IP real do visitante vem no cabeçalho
// X-Forwarded-For. TRUST_PROXY=1 no .env de produção; no PC fica desligado.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

app.use(helmet());                        // cabeçalhos de segurança
app.use(cors({ origin: origens }));
app.use(express.json({ limit: "10kb" })); // nenhum pedido legítimo passa disso
app.use("/api", limiteGeral);

// respostas da API não vão para cache (agenda muda a todo instante; dados do painel são privados)
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// verificação rápida: a API está no ar e falando com o banco?
app.get("/api/saude", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

// toda rota com arena na URL carrega a arena (e as configurações) primeiro
app.use("/api/:slug", carregarArena);
app.use("/api/:slug/admin", rotasAdmin);   // painel dos donos (login)
app.use("/api/:slug", rotasPublicas);      // site (sem login)

app.use((req, res) => res.status(404).json({ erro: "Rota não encontrada." }));
app.use(tratarErros);
