import prisma from "../armazenamento/prisma";

/**
 * Pre-processamento da camada de infraestrutura.
 *
 * O fundamentalsTimeSeries do Yahoo devolve, para varias empresas da B3, um trimestre
 * inteiro com os campos da DRE nulos no meio de uma serie saudavel (WEGE3 e LREN3, por
 * exemplo, nao tem 3T2025). Como a consolidacao LTM exige os quatro trimestres, um unico
 * buraco derruba a empresa do modelo inteiro.
 *
 * Quando o exercicio anual esta disponivel e apenas UM dos quatro trimestres daquele ano
 * carece do campo, o valor faltante e obtido por aritmetica exata:
 *
 *     trimestre_faltante = total_anual - soma_dos_outros_tres
 *
 * Nao e interpolacao nem estimativa: o resultado e o valor que a propria empresa reportou,
 * apenas recomposto. Se dois ou mais trimestres faltarem, ou se o exercicio nao tiver os
 * quatro registros, nada e preenchido - o indicador fica ausente, como manda o TCC.
 *
 * Vale so para contas de FLUXO (DRE e fluxo de caixa, que acumulam ao longo do periodo).
 * Contas de estoque do Balanco nao podem ser recompostas assim: o ativo total anual e a
 * fotografia de 31/12, nao a soma dos trimestres.
 */
const CAMPOS_FLUXO = [
  "totalRevenue",
  "operatingRevenue",
  "costOfRevenue",
  "grossProfit",
  "operatingIncome",
  "ebit",
  "ebitda",
  "netIncome",
  "depreciationAmortizationDepletion",
  "interestExpense",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
] as const;

type CampoFluxo = typeof CAMPOS_FLUXO[number];

export interface ResultadoReconstrucao {
  ticker: string;
  reparos: { ano: number; trimestre: string; campos: CampoFluxo[] }[];
}

export async function reconstruirFluxosFaltantes(ticker: string): Promise<ResultadoReconstrucao> {
  const resultado: ResultadoReconstrucao = { ticker, reparos: [] };

  const anuais = await prisma.dadosTrimestrais.findMany({
    where: { ticker, tipo: "annual" },
    orderBy: { dataReferencia: "desc" },
  });

  for (const anual of anuais) {
    const ano = anual.dataReferencia.getUTCFullYear();

    const doAno = await prisma.dadosTrimestrais.findMany({
      where: {
        ticker,
        tipo: "quarterly",
        dataReferencia: {
          gte: new Date(Date.UTC(ano, 0, 1)),
          lt: new Date(Date.UTC(ano + 1, 0, 1)),
        },
      },
      orderBy: { dataReferencia: "asc" },
    });

    // Sem os quatro trimestres do exercicio nao ha identidade a fechar: o "faltante"
    // seria o proprio total anual, o que inflaria o trimestre de forma grosseira.
    if (doAno.length !== 4) continue;

    const patches = new Map<string, Partial<Record<CampoFluxo, bigint>>>();

    for (const campo of CAMPOS_FLUXO) {
      const totalAnual = (anual as any)[campo] as bigint | null;
      if (totalAnual == null) continue;

      const semValor = doAno.filter(q => (q as any)[campo] == null);
      if (semValor.length !== 1) continue;

      const somaConhecida = doAno.reduce<bigint>(
        (s, q) => s + (((q as any)[campo] as bigint | null) ?? 0n),
        0n
      );

      const alvo = semValor[0];
      const patch = patches.get(alvo.id) ?? {};
      patch[campo] = totalAnual - somaConhecida;
      patches.set(alvo.id, patch);
    }

    for (const [id, patch] of patches) {
      const campos = Object.keys(patch) as CampoFluxo[];
      await prisma.dadosTrimestrais.update({ where: { id }, data: patch });
      const alvo = doAno.find(q => q.id === id)!;
      resultado.reparos.push({
        ano,
        trimestre: alvo.dataReferencia.toISOString().slice(0, 10),
        campos,
      });
    }
  }

  return resultado;
}

export async function reconstruirFluxosTodos(): Promise<void> {
  const empresas = await prisma.empresa.findMany({ where: { ativa: true } });
  let totalReparos = 0;

  for (const e of empresas) {
    try {
      const r = await reconstruirFluxosFaltantes(e.ticker);
      for (const rep of r.reparos) {
        console.log(`  ${e.ticker} ${rep.trimestre}: recomposto ${rep.campos.join(", ")}`);
        totalReparos++;
      }
    } catch (err: any) {
      console.log(`  Reconstrucao ${e.ticker}: ERRO - ${err.message}`);
    }
  }

  console.log(`[LIMPEZA] ${totalReparos} trimestres recompostos pela identidade anual`);
}
