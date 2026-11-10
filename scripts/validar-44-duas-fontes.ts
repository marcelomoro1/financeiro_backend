/**
 * Validação externa com 44 empresas completas nas duas fontes.
 *
 * - Usa o protocolo congelado da fixture (dados do protótipo na coleta).
 * - Compara ROE, ROA e GMAR com Fundamentus e Status Invest.
 * - Mantém apenas empresas com os três indicadores disponíveis nas duas
 *   referências e no protocolo (casos completos).
 *
 * Execução:
 *   npm run validar:44
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { TOLERANCIA_VALIDACAO } from "../src/conhecimento/dominio/constants";

const FIXTURE = resolve(__dirname, "../src/modelos/indicadores/__fixtures__/referencia-externa.json");
const SI_CSV = resolve(__dirname, "../../validacao/referencias-statusinvest.csv");
const OUT_DIR = resolve(__dirname, "../../validacao");

type Indicador = "ROE" | "ROA" | "GMAR";

interface EntradaFixture {
  ticker: string;
  nome: string;
  protocolo: {
    totalAssets: number | null;
    patrimonioLiquido: number | null;
    lucroLiquidoLTM: number | null;
    receitaLTM: number | null;
    cpvLTM: number | null;
  };
  referencia: {
    roe: number | null;
    roa: number | null;
    gmar: number | null;
  } | null;
}

interface Linha {
  ticker: string;
  indicador: Indicador;
  statusinvest: number;
  fundamentus: number;
  prototipo: number;
  desvioSi: number;
  desvioFund: number;
  statusSi: "OK" | "FORA";
  statusFund: "OK" | "FORA";
}

function lerStatusInvest(): Map<string, { roe: number; roa: number; gmar: number }> {
  const linhas = readFileSync(SI_CSV, "utf8").trim().split(/\r?\n/);
  const cabecalho = linhas.shift()!.split(",");
  const pos = (nome: string) => cabecalho.indexOf(nome);
  const iTicker = pos("ticker");
  const iRoe = pos("roe");
  const iRoa = pos("roa");
  const iGmar = pos("gmar");

  const mapa = new Map<string, { roe: number; roa: number; gmar: number }>();
  for (const linha of linhas.filter(Boolean)) {
    const c = linha.split(",");
    mapa.set(c[iTicker], {
      roe: Number(c[iRoe]),
      roa: Number(c[iRoa]),
      gmar: Number(c[iGmar]),
    });
  }
  return mapa;
}

function ehNumero(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function desvio(prototipo: number, referencia: number): number {
  if (referencia === 0) return Math.abs(prototipo);
  return Math.abs(prototipo - referencia) / Math.abs(referencia);
}

function status(desvioValor: number): "OK" | "FORA" {
  return desvioValor <= TOLERANCIA_VALIDACAO ? "OK" : "FORA";
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2).replace(".", ",")}%`;
}

function pctDesvio(v: number): string {
  return `${(v * 100).toFixed(2).replace(".", ",")}%`;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { entradas: EntradaFixture[] };
  const si = lerStatusInvest();

  const linhas: Linha[] = [];
  const excluidas: string[] = [];

  for (const entrada of fixture.entradas) {
    const p = entrada.protocolo;
    const r = entrada.referencia;
    const siRef = si.get(entrada.ticker);

    if (!r || !siRef || !ehNumero(p.lucroLiquidoLTM) || !ehNumero(p.patrimonioLiquido) ||
        !ehNumero(p.totalAssets) || !ehNumero(p.receitaLTM) || !ehNumero(p.cpvLTM)) {
      excluidas.push(entrada.ticker);
      continue;
    }

    const prototipo = {
      ROE: p.lucroLiquidoLTM / p.patrimonioLiquido,
      ROA: p.lucroLiquidoLTM / p.totalAssets,
      GMAR: (p.receitaLTM - p.cpvLTM) / p.receitaLTM,
    } as Record<Indicador, number>;

    const referencias = {
      ROE: { si: siRef.roe, fund: r.roe },
      ROA: { si: siRef.roa, fund: r.roa },
      GMAR: { si: siRef.gmar, fund: r.gmar },
    } as Record<Indicador, { si: number | null; fund: number | null }>;

    for (const indicador of ["ROE", "ROA", "GMAR"] as const) {
      const ref = referencias[indicador];
      if (!ehNumero(ref.si) || !ehNumero(ref.fund)) {
        excluidas.push(`${entrada.ticker}:${indicador}`);
        continue;
      }
      const dSi = desvio(prototipo[indicador], ref.si);
      const dFund = desvio(prototipo[indicador], ref.fund);
      linhas.push({
        ticker: entrada.ticker,
        indicador,
        statusinvest: ref.si,
        fundamentus: ref.fund,
        prototipo: prototipo[indicador],
        desvioSi: dSi,
        desvioFund: dFund,
        statusSi: status(dSi),
        statusFund: status(dFund),
      });
    }
  }

  if (linhas.length === 0) {
    throw new Error("Nenhuma comparação válida encontrada.");
  }

  const porIndicador: { indicador: Indicador; n: number; siDentro: number; fundDentro: number }[] = [];
  for (const indicador of ["ROE", "ROA", "GMAR"] as const) {
    const grupo = linhas.filter((l) => l.indicador === indicador);
    porIndicador.push({
      indicador,
      n: grupo.length,
      siDentro: grupo.filter((l) => l.statusSi === "OK").length,
      fundDentro: grupo.filter((l) => l.statusFund === "OK").length,
    });
  }

  const total = {
    n: linhas.length,
    siDentro: linhas.filter((l) => l.statusSi === "OK").length,
    siFora: linhas.filter((l) => l.statusSi === "FORA").length,
    fundDentro: linhas.filter((l) => l.statusFund === "OK").length,
    fundFora: linhas.filter((l) => l.statusFund === "FORA").length,
  };

  console.log("\nIndicador  N   SI OK  SI FORA  FUND OK  FUND FORA");
  console.log("-".repeat(54));
  for (const g of porIndicador) {
    console.log(
      `${g.indicador.padEnd(9)} ${String(g.n).padStart(3)}   ${String(g.siDentro).padStart(3)}   ${String(g.n - g.siDentro).padStart(5)}    ${String(g.fundDentro).padStart(3)}    ${String(g.n - g.fundDentro).padStart(5)}`
    );
  }
  console.log("-".repeat(54));
  console.log(
    `TOTAL     ${String(total.n).padStart(3)}   ${String(total.siDentro).padStart(3)}   ${String(total.siFora).padStart(5)}    ${String(total.fundDentro).padStart(3)}    ${String(total.fundFora).padStart(5)}`
  );
  console.log(
    `\nStatus Invest: ${total.siDentro}/${total.n} dentro de 5% (${((total.siDentro / total.n) * 100).toFixed(2)}%)`
  );
  console.log(
    `Fundamentus:   ${total.fundDentro}/${total.n} dentro de 5% (${((total.fundDentro / total.n) * 100).toFixed(2)}%)`
  );

  const foraSi = linhas.filter((l) => l.statusSi === "FORA");
  const foraFund = linhas.filter((l) => l.statusFund === "FORA");
  if (foraSi.length) {
    console.log("\nFora da margem (Status Invest):");
    for (const l of foraSi) {
      console.log(`  ${l.ticker} ${l.indicador}: ${pctDesvio(l.desvioSi)} (prot. ${pct(l.prototipo)} x SI ${pct(l.statusinvest)})`);
    }
  }
  if (foraFund.length) {
    console.log("\nFora da margem (Fundamentus):");
    for (const l of foraFund) {
      console.log(`  ${l.ticker} ${l.indicador}: ${pctDesvio(l.desvioFund)} (prot. ${pct(l.prototipo)} x Fund. ${pct(l.fundamentus)})`);
    }
  }
  if (excluidas.length) {
    console.log(`\nFora da base completa (${excluidas.length}): ${excluidas.join(", ")}`);
  }

  const detalhado = [
    "ticker,indicador,statusinvest,fundamentus,prototipo,desvio_si,desvio_fund,status_si,status_fund",
    ...linhas.map((l) =>
      [
        l.ticker,
        l.indicador,
        l.statusinvest,
        l.fundamentus,
        l.prototipo,
        l.desvioSi,
        l.desvioFund,
        l.statusSi,
        l.statusFund,
      ].join(",")
    ),
  ].join("\n");
  const detalhadoPath = resolve(OUT_DIR, "comparacao-44-duas-fontes.csv");
  writeFileSync(detalhadoPath, detalhado + "\n", "utf8");

  const resumo = [
    "indicador,n,si_dentro,si_fora,fund_dentro,fund_fora",
    ...porIndicador.map((g) => [g.indicador, g.n, g.siDentro, g.n - g.siDentro, g.fundDentro, g.n - g.fundDentro].join(",")),
    ["Total", total.n, total.siDentro, total.siFora, total.fundDentro, total.fundFora].join(","),
  ].join("\n");
  const resumoPath = resolve(OUT_DIR, "resumo-44-duas-fontes.csv");
  writeFileSync(resumoPath, resumo + "\n", "utf8");

  const md = [
    "# Validação externa — 44 empresas completas (duas fontes)",
    "",
    "**Período da coleta:** Fundamentus em 26/10/2026; Status Invest em 03/11/2026.",
    "**Método:** mesmas 44 empresas com os três indicadores disponíveis no protocolo congelado, no Fundamentus e no Status Invest. Margem de 5%.",
    "",
    "| Indicador | N | SI dentro | SI fora | Fundamentus dentro | Fundamentus fora |",
    "|---|---:|---:|---:|---:|---:|",
    ...porIndicador.map((g) => `| ${g.indicador} | ${g.n} | ${g.siDentro} | ${g.n - g.siDentro} | ${g.fundDentro} | ${g.n - g.fundDentro} |`),
    `| **Total** | **${total.n}** | **${total.siDentro}** | **${total.siFora}** | **${total.fundDentro}** | **${total.fundFora}** |`,
    "",
    `**Aderência Status Invest:** ${((total.siDentro / total.n) * 100).toFixed(2)}%`,
    `**Aderência Fundamentus:** ${((total.fundDentro / total.n) * 100).toFixed(2)}%`,
    "",
    `Empresas/indicadores fora da base completa: ${excluidas.length ? excluidas.join(", ") : "nenhum"}.`,
  ].join("\n");
  const mdPath = resolve(OUT_DIR, "comparacao-44-duas-fontes.md");
  writeFileSync(mdPath, md + "\n", "utf8");

  console.log(`\nCSV detalhado: ${detalhadoPath}`);
  console.log(`Resumo: ${resumoPath}`);
  console.log(`Relatório: ${mdPath}`);
}

main();
