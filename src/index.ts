import express from "express";
import cors from "cors";
import { config } from "./infra/config";
import authRoutes from "./infra/auth/authRoutes";
import { authMiddleware } from "./infra/middleware/authMiddleware";
import simulacaoRoutes from "./modelos/simulacao/simulacaoRoutes";
import dashboardRoutes from "./modelos/dashboard/dashboardRoutes";
import { runInitialSync, initCronJobs, recuperarRotinasAtrasadas } from "./dados/sincronizacao/cronJobs";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/carteiras", authMiddleware, simulacaoRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(config.port, async () => {
  console.log(`[SAD] Backend rodando em http://localhost:${config.port}`);

  initCronJobs();

  try {
    await runInitialSync();
  } catch (e: any) {
    console.log("[SAD] Sync inicial falhou (DB pode nao estar pronto):", e.message);
  }

  // node-cron so dispara com o processo vivo na hora marcada. Como o backend ainda
  // roda solto no terminal, as rodadas das 21:00 e a trimestral frequentemente ficam
  // para tras; esta chamada reexecuta no boot o que estiver atrasado.
  recuperarRotinasAtrasadas().catch(e => {
    console.log("[SAD] Catch-up de rotinas atrasadas falhou:", e.message);
  });
});

export default app;
