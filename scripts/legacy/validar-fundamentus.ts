/**
 * ARQUIVADO: validacao completa contra o Fundamentus (141 comparacoes).
 * Nao faz parte do TCC final nem do `npm test`; mantido apenas como ferramenta interna.
 *
 * Compara os indicadores calculados pelo prototipo com os valores publicados por
 * Status Invest / Fundamentus, aceitando a margem de 5%.
 *
 * Diferente do teste unitario (que roda sobre a fixture, sem rede), este script roda
 * contra o BANCO REAL ja sincronizado.
 *
 *   npx tsx scripts/legacy/validar-fundamentus.ts
 */
import { readFileSync } from "fs";
import prisma from "../../src/dados/armazenamento/prisma";
import { montarLTM, calcROA, calcROE, calcGMAR } from "../../src/modelos/indicadores/calculadora";
import { TOLERANCIA_VALIDACAO } from "../../src/conhecimento/dominio/constants";

const FIXTURE = "src/modelos/indicadores/__fixtures__/referencia-externa.json";

interface Linha {
  ticker: string;
  indicador: string;
  calculado: number | null;
  referencia: number;
  desvio: number | null;
  ok: boolean;
}

function pct(v: number | null): string {
  return v == null ? "     -" : (v * 100).toFixed(2).padStart(6) + "%";
}

async function main() {
  const { entradas } = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const linhas: Linha[] = [];
  let semReferencia = 0;

  for (const entrada of entradas) {
    const ref = entrada.referencia ?? {};
    if (ref.roe == null && ref.roa == null && ref.gmar == null) {
      semReferencia++;
      continue;
    }

    const ltm = await montarLTM(entrada.ticker);
    if (!ltm) {
      console.log(`  ${entrada.ticker}: sem consolidacao LTM disponivel`);
      continue;
    }

    const calculados: Record<string, number | null> = {
      ROE: calcROE(ltm.netIncome, ltm.equity),
      ROA: calcROA(ltm.netIncome, ltm.totalAssets),
      GMAR: calcGMAR(ltm.receita, ltm.cpv),
    };

    for (const [nome, chave] of [["ROE", "roe"], ["ROA", "roa"], ["GMAR", "gmar"]] as const) {
      const referencia = ref[chave];
      if (referencia == null) continue;

      const calculado = calculados[nome];
      const desvio =
        calculado == null
          ? null
          : referencia === 0
          ? Math.abs(calculado)
          : Math.abs(calculado - referencia) / Math.abs(referencia);

      linhas.push({
        ticker: entrada.ticker,
        indicador: nome,
        calculado,
        referencia,
        desvio,
        ok: desvio != null && desvio <= TOLERANCIA_VALIDACAO,
      });
    }
  }

  console.log("");
  console.log("TICKER      IND    PROTOTIPO  REFERENCIA    DESVIO  STATUS");
  console.log("-".repeat(62));
  for (const l of linhas) {
    console.log(
      `${l.ticker.padEnd(11)} ${l.indicador.padEnd(5)} ${pct(l.calculado)}  ${pct(l.referencia)}  ${pct(l.desvio)}  ${l.ok ? "OK" : "FALHA"}`
    );
  }

  const aprovados = linhas.filter(l => l.ok).length;
  console.log("-".repeat(62));
  console.log(
    `${aprovados}/${linhas.length} comparacoes dentro da margem de ${TOLERANCIA_VALIDACAO * 100}%`
  );
  if (semReferencia) {
    console.log(`${semReferencia} empresas ainda sem referencia coletada na fixture`);
  }

  await prisma.$disconnect();
  process.exit(linhas.length > 0 && aprovados < linhas.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
