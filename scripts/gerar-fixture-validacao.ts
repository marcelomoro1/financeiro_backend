/**
 * Gera o esqueleto da fixture de validacao externa a partir do banco ja sincronizado.
 *
 * Os campos em "protocolo" sao preenchidos automaticamente com os dados brutos que o
 * sistema extraiu (consolidados em LTM). Os campos em "referencia" ficam null e devem
 * ser preenchidos MANUALMENTE com os valores publicados por Status Invest e Fundamentus
 * - e a coleta que o TCC atribui ao autor na secao Validacao da Solucao Proposta.
 *
 *   npx tsx scripts/gerar-fixture-validacao.ts
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import prisma from "../src/dados/armazenamento/prisma";
import { montarLTM } from "../src/modelos/indicadores/calculadora";

const DESTINO = "src/modelos/indicadores/__fixtures__/referencia-externa.json";

async function main() {
  const empresas = await prisma.empresa.findMany({
    where: { ativa: true },
    orderBy: { ticker: "asc" },
  });

  const entradas: any[] = [];
  for (const e of empresas) {
    const ltm = await montarLTM(e.ticker);
    if (!ltm) {
      console.log(`  ${e.ticker}: sem 4 trimestres, fora da fixture`);
      continue;
    }

    entradas.push({
      ticker: e.ticker,
      nome: e.nome,
      janela: ltm.janela,
      protocolo: {
        totalAssets: finito(ltm.totalAssets),
        patrimonioLiquido: finito(ltm.equity),
        lucroLiquidoLTM: finito(ltm.netIncome),
        receitaLTM: finito(ltm.receita),
        cpvLTM: finito(ltm.cpv),
      },
      referencia: {
        fonte: "statusinvest",
        coletadoEm: null,
        roe: null,
        roa: null,
        gmar: null,
      },
    });
  }

  mkdirSync(dirname(DESTINO), { recursive: true });
  writeFileSync(DESTINO, JSON.stringify({ entradas }, null, 2) + "\n", "utf8");
  console.log(`\n${entradas.length} entradas geradas em ${DESTINO}`);
  console.log("Preencha os campos de 'referencia' com os valores publicados nos portais.");
  await prisma.$disconnect();
}

function finito(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
