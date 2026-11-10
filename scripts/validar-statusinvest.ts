/**
 * Compara os indicadores calculados pelo prototipo com duas fontes:
 * Status Invest (subamostra coletada) e Fundamentus (fixture de referencia).
 *
 * Le validacao/referencias-statusinvest-30.csv (rodada histórica de 30 empresas), busca o indicador mais recente de cada
 * ticker no banco e grava:
 *   - validacao/comparacao-statusinvest.csv  (90 linhas: 30 empresas x 3 indicadores)
 *   - validacao/resumo-statusinvest.csv      (contagens dentro/fora de 5% por fonte)
 *
 *   npx tsx scripts/validar-statusinvest.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import prisma from "../src/dados/armazenamento/prisma";
import { TOLERANCIA_VALIDACAO } from "../src/conhecimento/dominio/constants";

interface Referencia {
  ticker: string;
  roe: number;
  roa: number;
  gmar: number;
}

interface FundRef {
  roe: number | null;
  roa: number | null;
  gmar: number | null;
}

interface Linha {
  ticker: string;
  indicador: "ROE" | "ROA" | "GMAR";
  statusinvest: number;
  fundamentus: number | null;
  prototipo: number | null;
  desvioSi: number | null;
  desvioFund: number | null;
  statusSi: "OK" | "FORA" | "SEM DADO";
  statusFund: "OK" | "FORA" | "SEM DADO";
}

const ENTRADA = resolve(__dirname, "../../validacao/referencias-statusinvest-30.csv");
const SAIDA = resolve(__dirname, "../../validacao/comparacao-statusinvest.csv");
const RESUMO = resolve(__dirname, "../../validacao/resumo-statusinvest.csv");
const FIXTURE = resolve(__dirname, "../src/modelos/indicadores/__fixtures__/referencia-externa.json");

const INDICADORES = ["ROE", "ROA", "GMAR"] as const;

function lerCsv(caminho: string): Referencia[] {
  const linhas = readFileSync(caminho, "utf8").trim().split(/\r?\n/);
  const cabecalho = linhas.shift()!.split(",");
  const pos = (nome: string) => cabecalho.indexOf(nome);
  const iTicker = pos("ticker");
  const iRoe = pos("roe");
  const iRoa = pos("roa");
  const iGmar = pos("gmar");

  return linhas.filter(Boolean).map((linha) => {
    const c = linha.split(",");
    return {
      ticker: c[iTicker],
      roe: Number(c[iRoe]),
      roa: Number(c[iRoa]),
      gmar: Number(c[iGmar]),
    };
  });
}

function lerFundamentus(): Map<string, FundRef> {
  const { entradas } = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    entradas: { ticker: string; referencia: FundRef }[];
  };
  return new Map(entradas.map((e) => [e.ticker, e.referencia]));
}

function desvio(prototipo: number | null, referencia: number | null): number | null {
  if (prototipo == null || referencia == null) return null;
  if (!Number.isFinite(prototipo) || !Number.isFinite(referencia)) return null;
  return referencia === 0 ? Math.abs(prototipo) : Math.abs(prototipo - referencia) / Math.abs(referencia);
}

function status(d: number | null, prototipo: number | null): "OK" | "FORA" | "SEM DADO" {
  if (prototipo == null || d == null) return "SEM DADO";
  return d <= TOLERANCIA_VALIDACAO ? "OK" : "FORA";
}

function fmt(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return (v * 100).toFixed(2) + "%";
}

async function main() {
  const referencias = lerCsv(ENTRADA);
  const fundamentus = lerFundamentus();
  const tickers = referencias.map((r) => r.ticker);

  const indicadores = await prisma.indicadorCalculado.findMany({
    where: { ticker: { in: tickers } },
    orderBy: [{ ticker: "asc" }, { dataReferencia: "desc" }],
    distinct: ["ticker"],
  });
  const porTicker = new Map(indicadores.map((i) => [i.ticker, i]));

  const linhas: Linha[] = [];
  for (const ref of referencias) {
    const ind = porTicker.get(ref.ticker);
    const fund = fundamentus.get(ref.ticker);
    for (const [indicador, chave] of [
      ["ROE", "roe"],
      ["ROA", "roa"],
      ["GMAR", "gmar"],
    ] as const) {
      const si = ref[chave];
      const fundRef = fund?.[chave] ?? null;
      const prototipo = ind ? ind[chave] : null;
      const dSi = desvio(prototipo, si);
      const dFund = desvio(prototipo, fundRef);

      linhas.push({
        ticker: ref.ticker,
        indicador,
        statusinvest: si,
        fundamentus: fundRef,
        prototipo: prototipo ?? null,
        desvioSi: dSi,
        desvioFund: dFund,
        statusSi: status(dSi, prototipo),
        statusFund: status(dFund, prototipo),
      });
    }
  }

  const cabecalho =
    "ticker,indicador,statusinvest,fundamentus,prototipo,desvio_si,desvio_fund,status_si,status_fund";
  const corpo = linhas.map((l) =>
    [
      l.ticker,
      l.indicador,
      l.statusinvest,
      l.fundamentus ?? "",
      l.prototipo ?? "",
      l.desvioSi ?? "",
      l.desvioFund ?? "",
      l.statusSi,
      l.statusFund,
    ].join(",")
  );
  writeFileSync(SAIDA, [cabecalho, ...corpo].join("\n") + "\n", "utf8");

  const resumo: string[] = ["indicador,n,si_dentro,si_fora,fund_dentro,fund_fora"];
  const totais = { n: 0, siDentro: 0, siFora: 0, fundDentro: 0, fundFora: 0 };

  console.log("\nIND   N   SI OK  SI FORA  FUND OK  FUND FORA");
  console.log("-".repeat(50));
  for (const indicador of INDICADORES) {
    const grupo = linhas.filter((l) => l.indicador === indicador);
    const siComp = grupo.filter((l) => l.statusSi !== "SEM DADO");
    const fundComp = grupo.filter((l) => l.statusFund !== "SEM DADO");
    const siDentro = siComp.filter((l) => l.statusSi === "OK").length;
    const fundDentro = fundComp.filter((l) => l.statusFund === "OK").length;
    const siFora = siComp.length - siDentro;
    const fundFora = fundComp.length - fundDentro;

    totais.n += siComp.length;
    totais.siDentro += siDentro;
    totais.siFora += siFora;
    totais.fundDentro += fundDentro;
    totais.fundFora += fundFora;

    resumo.push([indicador, siComp.length, siDentro, siFora, fundDentro, fundFora].join(","));
    console.log(
      `${indicador.padEnd(5)} ${String(siComp.length).padStart(2)}   ${String(siDentro).padStart(3)}   ${String(siFora).padStart(3)}     ${String(fundDentro).padStart(3)}      ${String(fundFora).padStart(3)}`
    );
  }
  resumo.push(
    ["Total", totais.n, totais.siDentro, totais.siFora, totais.fundDentro, totais.fundFora].join(",")
  );
  console.log("-".repeat(50));
  console.log(
    `TOTAL ${String(totais.n).padStart(2)}   ${String(totais.siDentro).padStart(3)}   ${String(totais.siFora).padStart(3)}     ${String(totais.fundDentro).padStart(3)}      ${String(totais.fundFora).padStart(3)}`
  );
  console.log(
    `\nStatus Invest: ${totais.siDentro}/${totais.n} dentro de 5% (${((totais.siDentro / totais.n) * 100).toFixed(2)}%)`
  );
  console.log(
    `Fundamentus:   ${totais.fundDentro}/${totais.n} dentro de 5% (${((totais.fundDentro / totais.n) * 100).toFixed(2)}%)`
  );

  const foraSi = linhas.filter((l) => l.statusSi === "FORA");
  const foraFund = linhas.filter((l) => l.statusFund === "FORA");
  if (foraSi.length) {
    console.log("\nFora da margem (Status Invest):");
    for (const l of foraSi) console.log(`  ${l.ticker} ${l.indicador}: ${fmt(l.desvioSi)}`);
  }
  if (foraFund.length) {
    console.log("\nFora da margem (Fundamentus):");
    for (const l of foraFund) console.log(`  ${l.ticker} ${l.indicador}: ${fmt(l.desvioFund)}`);
  }

  writeFileSync(RESUMO, resumo.join("\n") + "\n", "utf8");
  console.log(`\nCSV detalhado: ${SAIDA}`);
  console.log(`Resumo: ${RESUMO}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
