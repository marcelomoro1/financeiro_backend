import { Router, Response } from "express";
import prisma from "../../dados/armazenamento/prisma";
import { calcularIndicadoresTodos, capitalDeGiro, montarLTM, toNumber } from "../indicadores/calculadora";
import { executarPipelineCompleto } from "../zscore/pipeline";
import { yahooFinance, withRetry } from "../../dados/extracao/yahooFinance";
import { authMiddleware } from "../../infra/middleware/authMiddleware";
import { sincronizacaoAtiva } from "../../dados/sincronizacao/cronJobs";

const router = Router();

const RANGE_DAYS: Record<string, number | null> = {
  "1s": 7,
  "1m": 30,
  "6m": 183,
  "1a": 365,
  "3a": 365 * 3,
  "tudo": null,
};

function inicioDoRange(range: unknown): Date {
  const chave = typeof range === "string" && range in RANGE_DAYS ? range : "1m";
  const days = RANGE_DAYS[chave];
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date("2021-01-01");
}

router.get("/ranking", async (_req, res: Response) => {
  // `distinct` traduz para DISTINCT ON no Postgres, devolvendo so a linha mais recente
  // de cada ticker. Carregar as tabelas inteiras e filtrar em memoria degrada a cada
  // rodada trimestral, que acrescenta 50 linhas novas em zscore_resultados.
  const resultados = await prisma.zScoreResultado.findMany({
    where: { zQualidade: { not: null } },
    orderBy: [{ ticker: "asc" }, { dataCalculo: "desc" }],
    distinct: ["ticker"],
    include: { empresa: true },
  });

  const indicadores = await prisma.indicadorCalculado.findMany({
    orderBy: [{ ticker: "asc" }, { dataReferencia: "desc" }],
    distinct: ["ticker"],
  });
  const indMap: Record<string, any> = {};
  for (const i of indicadores) indMap[i.ticker] = i;

  const ranking = resultados.map((r) => ({
    ticker: r.ticker,
    nome: r.empresa?.nome || r.ticker,
    setor: r.empresa?.setor || "N/A",
    ultimoPreco: r.empresa?.ultimoPreco ?? null,
    variacaoDiaPercentual: r.empresa?.variacaoDiaPercentual ?? null,
    zQualidade: r.zQualidade,
    zValorMomento: r.zValorMomento,
    classificacaoQualidade: r.classificacaoQualidade,
    sinalVM: r.sinalVM,
    indicadores: {
      roa: indMap[r.ticker]?.roa,
      roe: indMap[r.ticker]?.roe,
      gpoa: indMap[r.ticker]?.gpoa,
      gmar: indMap[r.ticker]?.gmar,
      cfoa: indMap[r.ticker]?.cfoa,
      beMe: indMap[r.ticker]?.beMe,
      mom2: indMap[r.ticker]?.mom2,
      bab: indMap[r.ticker]?.bab,
      lev: indMap[r.ticker]?.lev,
      evol: indMap[r.ticker]?.evol,
    },
  }));

  res.json(ranking.sort((a: any, b: any) => (b.zQualidade || -999) - (a.zQualidade || -999)));
});

router.get("/indicadores/:ticker", async (req, res: Response) => {
  const { ticker } = req.params;
  const empresa = await prisma.empresa.findUnique({ where: { ticker } });
  const indicadores = await prisma.indicadorCalculado.findFirst({
    where: { ticker },
    orderBy: { dataReferencia: "desc" },
  });
  const zscore = await prisma.zScoreResultado.findFirst({
    where: { ticker },
    orderBy: { dataCalculo: "desc" },
  });
  const cotacao = await prisma.cotacaoHistorica.findFirst({
    where: { ticker, tipo: "intraday" },
    orderBy: { data: "desc" },
  });

  // Os indicadores exibidos vem da mesma consolidacao LTM que alimenta o modelo, para
  // que o painel reconcilie com a nota ao lado e seja comparavel com Status Invest e
  // Fundamentus, que publicam em 12 meses.
  const ltm = await montarLTM(ticker);
  const balanco = await prisma.dadosTrimestrais.findFirst({
    where: { ticker, tipo: "quarterly" },
    orderBy: { dataReferencia: "desc" },
  });

  let dadosFundamentalistas: Record<string, any> | null = null;
  if (ltm && balanco) {
    dadosFundamentalistas = {
      janela: ltm.janela,
      dataReferencia: ltm.dataReferencia,
      // estoques: balanco mais recente
      totalAssets: ltm.totalAssets,
      commonStockEquity: ltm.equity,
      totalDebt: ltm.dividaTotal,
      currentAssets: toNumber(balanco.currentAssets),
      currentLiabilities: toNumber(balanco.currentLiabilities),
      cashAndCashEquivalents: toNumber(balanco.cashAndCashEquivalents),
      // As duas parcelas que a definicao operacional retira do circulante, expostas para
      // que o painel reconcilie com o Delta Capital de Giro logo abaixo.
      cashAndShortTermInvestments: toNumber(balanco.cashAndShortTermInvestments),
      currentDebt: toNumber(balanco.currentDebt),
      capitalDeGiro: capitalDeGiro(balanco),
      totalLiabilitiesNetMinorityInterest: toNumber(balanco.totalLiabilitiesNetMinorityInterest),
      // fluxos: consolidados em 12 meses
      netIncome: ltm.netIncome,
      totalRevenue: ltm.receita,
      costOfRevenue: ltm.cpv,
      grossProfit: ltm.receita - ltm.cpv,
      depreciationAmortizationDepletion: ltm.depreciacao,
      capitalExpenditure: ltm.capex,
      changeInWorkingCapital: ltm.deltaCapitalGiro,
      // campos cujo valor veio de derivacao, e nao direto do Yahoo, em ao menos um
      // dos quatro trimestres da janela
      estimados: ltm.estimados,
    };
    for (const [k, v] of Object.entries(dadosFundamentalistas)) {
      if (typeof v === "number" && isNaN(v)) dadosFundamentalistas[k] = null;
    }
  }

  res.json({ empresa, indicadores, zscore, precoAtual: cotacao?.adjclose, dadosFundamentalistas });
});

router.get("/setores", async (_req, res: Response) => {
  const empresas = await prisma.empresa.findMany({
    where: { ativa: true },
    select: { setor: true },
  });
  const setores = [...new Set(empresas.map(e => e.setor).filter(Boolean))];
  res.json(setores);
});

router.get("/historico/:ticker", async (req, res: Response) => {
  const { ticker } = req.params;
  const period1 = inicioDoRange(req.query.range);

  try {
    const chart = await withRetry(() => yahooFinance.chart(ticker, { period1, interval: "1d" }));
    // usa o fechamento real (close), não o ajustado por dividendos (adjclose) —
    // esse endpoint é pra exibição, precisa bater com o preço que o usuário vê em outras fontes.
    // O adjclose continua sendo usado corretamente no cálculo de Beta/Momento do modelo quantitativo.
    const historico = chart.quotes
      .filter((q) => q.date && q.close != null)
      .map((q) => ({ data: q.date, preco: q.close }));
    res.json(historico);
  } catch (err: any) {
    res.status(502).json({ error: "Não foi possível buscar o histórico de preços", detail: err.message });
  }
});

router.get("/ibov", async (req, res: Response) => {
  const historico = await prisma.cotacaoIndice.findMany({
    where: { simbolo: "^BVSP", data: { gte: inicioDoRange(req.query.range) } },
    orderBy: { data: "asc" },
  });
  res.json(historico.map(h => ({ data: h.data, preco: h.fechamento })));
});

// Protegida: dispara ~100 requisicoes ao Yahoo por chamada. Aberta, permitiria que
// qualquer um derrubasse o acesso a API disparando em laco.
router.post("/recalcular", authMiddleware, async (_req, res: Response) => {
  if (sincronizacaoAtiva()) {
    res.status(409).json({ error: "Sincronização já em andamento" });
    return;
  }
  try {
    console.log("[RECALC] Iniciando recálculo de todos os indicadores...");
    await calcularIndicadoresTodos();
    console.log("[RECALC] Executando pipeline Z-Score...");
    await executarPipelineCompleto();
    console.log("[RECALC] Concluído!");
    res.json({ ok: true, message: "Indicadores e Z-Scores recalculados com sucesso" });
  } catch (err: any) {
    console.error("[RECALC] Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/status", async (_req, res: Response) => {
  const precos = await prisma.cronStatus.findUnique({ where: { jobName: "precos_5min" } });
  const trimestral = await prisma.cronStatus.findUnique({ where: { jobName: "trimestral_balancos" } });
  const sync = await prisma.cronStatus.findUnique({ where: { jobName: "initial_sync" } });
  const sinal = await prisma.cronStatus.findUnique({ where: { jobName: "sinal_diario" } });
  res.json({
    ultimaAtualizacaoPrecos: precos?.ultimaExecucao || null,
    ultimaSincronizacaoTrimestral: trimestral?.ultimaExecucao || null,
    ultimaReclassificacaoSinal: sinal?.ultimaExecucao || null,
    syncInicial: sync?.ultimaExecucao || null,
  });
});

export default router;
