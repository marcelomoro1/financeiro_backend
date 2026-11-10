/**
 * Comparação retrospectiva: outubro/2026.
 *
 * - Seleciona as empresas classificadas como "Alta Qualidade" na última
 *   classificação de qualidade gravada ANTES do início do período.
 * - Mede a rentabilidade pelo preço de fechamento (close), sem dividendos.
 * - Usa o mesmo valor investido em cada empresa (média simples).
 * - Compara com a variação do Ibovespa no mesmo período.
 *
 * Execução:
 *   npm run comparacao
 */
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import YahooFinance from "yahoo-finance2";
import prisma from "../src/dados/armazenamento/prisma";
import { withRetry } from "../src/dados/extracao/yahooFinance";

const INICIO = "2026-09-30";
const FIM = "2026-10-30";
const CORTE_CLASSIFICACAO = new Date("2026-10-01T00:00:00Z");
const DELAY_MS = 500;

const NOMES_CURTOS: Record<string, string> = {
  "ABEV3.SA": "Ambev",
  "CVCB3.SA": "CVC",
  "EMBJ3.SA": "Embraer",
  "FLRY3.SA": "Fleury",
  "GRND3.SA": "Grendene",
  "LREN3.SA": "Lojas Renner",
  "MDIA3.SA": "M. Dias Branco",
  "PETR4.SA": "Petrobras",
  "RADL3.SA": "Raia Drogasil",
  "SBSP3.SA": "Sabesp",
  "TAEE11.SA": "Taesa",
  "TGMA3.SA": "Tegma",
  "TOTS3.SA": "TOTVS",
  "VIVA3.SA": "Vivara",
  "VIVT3.SA": "Telefônica Brasil/Vivo",
  "WEGE3.SA": "WEG",
};

interface ResultadoEmpresa {
  ticker: string;
  nome: string;
  precoInicio: number;
  precoFim: number;
  retorno: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function dataISO(data: Date): string {
  return data.toISOString().slice(0, 10);
}

function acharFechamento(quotes: any[], dataAlvo: string): { data: string; close: number } | null {
  const validos = quotes.filter((q) => q.date && q.close != null);
  const exato = validos.find((q) => dataISO(q.date) === dataAlvo);
  if (exato) return { data: dataAlvo, close: Number(exato.close) };

  const anteriores = validos
    .filter((q) => dataISO(q.date) <= dataAlvo)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  if (anteriores.length === 0) return null;

  return { data: dataISO(anteriores[0].date), close: Number(anteriores[0].close) };
}

function pct(valor: number): string {
  return `${(valor * 100).toFixed(2).replace(".", ",")}%`;
}

function pctComSinal(valor: number): string {
  const sinal = valor > 0 ? "+" : "";
  return `${sinal}${pct(valor)}`;
}

async function fechamentoIbov(dataAlvo: string): Promise<{ data: string; close: number } | null> {
  const rows = await prisma.cotacaoIndice.findMany({
    where: { simbolo: "^BVSP" },
    orderBy: { data: "asc" },
  });

  const doDia = rows.filter((r) => dataISO(r.data) === dataAlvo);
  if (doDia.length > 0) {
    const diario = doDia.find((r) => r.data.getUTCHours() === 13);
    const escolhido = diario ?? doDia[doDia.length - 1];
    return { data: dataISO(escolhido.data), close: escolhido.fechamento };
  }

  const anteriores = rows.filter((r) => dataISO(r.data) <= dataAlvo);
  if (anteriores.length === 0) return null;
  const escolhido = anteriores[anteriores.length - 1];
  return { data: dataISO(escolhido.data), close: escolhido.fechamento };
}

async function main() {
  console.log(`[COMPARACAO] Periodo: ${INICIO} (fechamento) -> ${FIM} (fechamento)`);

  const zs = await prisma.zScoreResultado.findMany({
    where: { dataCalculo: { lt: CORTE_CLASSIFICACAO } },
    orderBy: { dataCalculo: "desc" },
  });

  const ultimoPorTicker = new Map<string, (typeof zs)[number]>();
  for (const z of zs) {
    if (!ultimoPorTicker.has(z.ticker)) ultimoPorTicker.set(z.ticker, z);
  }

  const altaQualidade = [...ultimoPorTicker.values()]
    .filter((z) => z.classificacaoQualidade === "Alta Qualidade")
    .sort((a, b) => (b.zQualidade ?? -Infinity) - (a.zQualidade ?? -Infinity));

  if (altaQualidade.length === 0) {
    throw new Error("Nenhuma empresa de Alta Qualidade encontrada antes do periodo.");
  }

  const snapshot = altaQualidade
    .map((z) => z.dataCalculo)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const snapshotData = snapshot.toISOString().slice(0, 10).split("-").reverse().join("/");

  console.log(
    `[COMPARACAO] Classificacao usada: ${snapshotData} | ${altaQualidade.length} empresas`
  );

  const empresas = await prisma.empresa.findMany({
    where: { ticker: { in: altaQualidade.map((z) => z.ticker) } },
    select: { ticker: true, nome: true },
  });
  const nomePorTicker = new Map(empresas.map((e) => [e.ticker, e.nome]));

  const yahooFinance = new YahooFinance({
    suppressNotices: ["yahooSurvey", "ripHistorical"],
  });

  const resultados: ResultadoEmpresa[] = [];
  const semPreco: string[] = [];

  for (const z of altaQualidade) {
    await delay(DELAY_MS);
    try {
      const chart = await withRetry(() =>
        yahooFinance.chart(z.ticker, {
          period1: "2026-09-28",
          period2: "2026-10-31",
          interval: "1d",
        })
      );

      const inicio = acharFechamento(chart.quotes, INICIO);
      const fim = acharFechamento(chart.quotes, FIM);
      if (!inicio || !fim || inicio.close <= 0) {
        console.log(`  ${z.ticker}: sem fechamento para o periodo`);
        semPreco.push(z.ticker);
        continue;
      }

      resultados.push({
        ticker: z.ticker,
        nome: NOMES_CURTOS[z.ticker] ?? nomePorTicker.get(z.ticker) ?? z.ticker,
        precoInicio: inicio.close,
        precoFim: fim.close,
        retorno: fim.close / inicio.close - 1,
      });
      console.log(
        `  ${z.ticker.replace(".SA", "").padEnd(7)} ${pctComSinal(fim.close / inicio.close - 1).padStart(8)}`
      );
    } catch (e: any) {
      console.log(`  ${z.ticker}: erro ao buscar preco - ${e.message?.substring(0, 80)}`);
      semPreco.push(z.ticker);
    }
  }

  if (resultados.length === 0) {
    throw new Error("Nenhuma empresa com preco disponivel; comparacao cancelada.");
  }

  resultados.sort((a, b) => a.ticker.localeCompare(b.ticker));

  const ibovInicio = await fechamentoIbov(INICIO);
  const ibovFim = await fechamentoIbov(FIM);
  if (!ibovInicio || !ibovFim || ibovInicio.close <= 0) {
    throw new Error("Sem cotacao do Ibovespa para o periodo.");
  }

  const carteira = resultados.reduce((soma, r) => soma + r.retorno, 0) / resultados.length;
  const ibovespa = ibovFim.close / ibovInicio.close - 1;
  const diferencaPp = (carteira - ibovespa) * 100;

  console.log("\n[RESULTADO]");
  console.log(`Carteira (${resultados.length} empresas): ${pctComSinal(carteira)}`);
  console.log(`Ibovespa: ${pctComSinal(ibovespa)}`);
  console.log(
    `Diferenca: ${diferencaPp >= 0 ? "+" : ""}${diferencaPp.toFixed(2).replace(".", ",")} p.p.`
  );
  if (semPreco.length > 0) {
    console.log(`Sem preco: ${semPreco.map((t) => t.replace(".SA", "")).join(", ")}`);
  }

  const outDir = resolve(process.cwd(), "..", "validacao");
  mkdirSync(outDir, { recursive: true });

  const json = {
    periodo: { inicio: INICIO, fim: FIM },
    classificacao: {
      snapshot: snapshot.toISOString(),
      criterio: "Alta Qualidade",
      empresas: resultados.length,
    },
    metodo:
      "Mesmo valor investido em cada empresa; rentabilidade pelo preco de fechamento; sem dividendos, taxas ou impostos.",
    carteira: Number(carteira.toFixed(6)),
    ibovespa: Number(ibovespa.toFixed(6)),
    diferencaPp: Number(diferencaPp.toFixed(2)),
    ibovespaInicio: { data: ibovInicio.data, fechamento: ibovInicio.close },
    ibovespaFim: { data: ibovFim.data, fechamento: ibovFim.close },
    empresas: resultados.map((r) => ({
      ticker: r.ticker,
      nome: r.nome,
      precoInicio: Number(r.precoInicio.toFixed(4)),
      precoFim: Number(r.precoFim.toFixed(4)),
      retorno: Number(r.retorno.toFixed(6)),
    })),
    semPreco,
  };

  const jsonPath = resolve(outDir, "comparacao-outubro-2026.json");
  writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");

  const csvLinhas = [
    "ticker,empresa,preco_inicio,preco_fim,rentabilidade",
    ...resultados.map((r) =>
      [
        r.ticker,
        `"${r.nome.replace(/"/g, '""')}"`,
        r.precoInicio.toFixed(4),
        r.precoFim.toFixed(4),
        (r.retorno * 100).toFixed(2),
      ].join(",")
    ),
  ];
  const csvPath = resolve(outDir, "comparacao-outubro-2026.csv");
  writeFileSync(csvPath, csvLinhas.join("\n"), "utf8");

  const mdLinhas = [
    "# Comparação retrospectiva — outubro/2026",
    "",
    `**Período:** ${INICIO} (fechamento) a ${FIM} (fechamento).`,
    "",
    `**Classificação usada:** ${snapshotData} — empresas classificadas como Alta Qualidade antes do período.`,
    "",
    "**Como foi feito:** a carteira foi formada pelas empresas de Alta Qualidade que o sistema já tinha classificado antes do período. Foi considerado o mesmo valor investido em cada empresa. A rentabilidade foi calculada pela variação do preço de fechamento, sem dividendos, taxas ou impostos. O Ibovespa foi usado como referência no mesmo intervalo.",
    "",
    "| Ticker | Empresa | Rentabilidade |",
    "|---|---|---:|",
    ...resultados.map(
      (r) => `| ${r.ticker.replace(".SA", "")} | ${r.nome} | ${pctComSinal(r.retorno)} |`
    ),
    `| **Carteira** | **${resultados.length} empresas, mesmo valor em cada** | **${pctComSinal(carteira)}** |`,
    `| **Ibovespa** | **Índice de referência** | **${pctComSinal(ibovespa)}** |`,
    "",
    `**Diferença:** ${diferencaPp >= 0 ? "+" : ""}${diferencaPp.toFixed(2).replace(".", ",")} p.p.`,
    "",
    "Fonte: elaborada pelo autor (2026), com dados da classificação de qualidade do sistema e preços de fechamento do Yahoo Finance.",
  ];
  if (semPreco.length > 0) {
    mdLinhas.push("", `Sem preço no período: ${semPreco.join(", ")}.`);
  }
  const mdPath = resolve(outDir, "comparacao-outubro-2026.md");
  writeFileSync(mdPath, mdLinhas.join("\n"), "utf8");

  const latexLinhas = [
    "\\begin{table}[htbp]",
    "\\centering",
    "\\caption{Comparação retrospectiva da carteira de Alta Qualidade com o Ibovespa (30/09/2026 a 30/10/2026)}",
    "\\label{tab:comparacao-outubro}",
    "\\footnotesize",
    "\\begin{tabularx}{\\columnwidth}{@{}l X r@{}}",
    "\\toprule",
    "Ticker & Empresa & Rentabilidade \\\\",
    "\\midrule",
    ...resultados.map(
      (r) =>
        `${r.ticker.replace(".SA", "")} & ${r.nome} & $${r.retorno >= 0 ? "+" : ""}${(r.retorno * 100).toFixed(2).replace(".", ",")}\\%$ \\\\`
    ),
    "\\midrule",
    `\\textbf{Carteira} & \\textbf{${resultados.length} empresas, mesmo valor em cada} & $\\mathbf{${carteira >= 0 ? "+" : ""}${(carteira * 100).toFixed(2).replace(".", ",")}\\%}$ \\\\`,
    `\\textbf{Ibovespa} & \\textbf{Índice de referência} & $\\mathbf{${ibovespa >= 0 ? "+" : ""}${(ibovespa * 100).toFixed(2).replace(".", ",")}\\%}$ \\\\`,
    "\\bottomrule",
    "\\end{tabularx}",
    "\\begin{flushleft}",
    "\\scriptsize Fonte: Elaborada pelo autor (2026), com dados da classificação de qualidade do sistema e preços de fechamento do Yahoo Finance (30/09 e 30/10/2026). Sem dividendos, taxas ou impostos.",
    "\\end{flushleft}",
    "\\end{table}",
  ];
  const texPath = resolve(outDir, "comparacao-outubro-2026.tex");
  writeFileSync(texPath, latexLinhas.join("\n"), "utf8");

  console.log(`\n[ARQUIVOS]`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${csvPath}`);
  console.log(`  ${texPath}`);
}

main()
  .catch((e) => {
    console.error("\n[ERRO]", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
