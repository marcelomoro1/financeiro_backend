import { zScore, rank, media } from "../../shared/utils/estatistica";
import prisma from "../../dados/armazenamento/prisma";
import { IndicadorFinanceiro, ZScoreOutput } from "../../shared/types";
import { classificarEmTercis, classificarSinalEmTercis } from "../../conhecimento/heuristicas/classificacao";
import { MIN_PILARES_QUALIDADE } from "../../conhecimento/dominio/constants";

const nulo = (v: number): number | null => (isNaN(v) ? null : v);

// Fases 1 e 2 do TCC: rank (equacao 1) seguido de Z-Score sobre as posicoes (equacao 2).
// invert = true quando o menor valor e o melhor (BAB, LEV, EVOL).
function rankThenZScore(values: (number | null | undefined)[], invert = false): number[] {
  const brutos = values.map(v => (v == null ? NaN : v));
  const validos = brutos.filter(v => !isNaN(v)).length;
  // Um z transversal com uma unica observacao nao tem significado. Devolver 0 para
  // todos faria as empresas sem o dado receberem nota mediana de graca.
  if (validos < 2) return brutos.map(() => NaN);
  return zScore(rank(brutos, invert));
}

// Fase 3: media aritmetica dos Z-Scores disponiveis no pilar, seguida de nova
// padronizacao. Indicador ausente simplesmente nao entra na media, conforme o TCC.
function consolidarPilar(componentes: number[][], n: number): number[] {
  const medias = Array.from({ length: n }, (_, i) => media(componentes.map(c => c[i])));
  return zScore(medias);
}

// Equacao (3): Q = z(L + C + S). A nota de Qualidade exige os tres pilares: se um pilar
// inteiro estiver ausente, a empresa nao recebe nota de Qualidade em vez de ser avaliada
// com informacao parcial (imputar zero promoveria/rebaixaria a empresa). Com os tres
// presentes, a media e numericamente equivalente a soma, pois z e invariante a
// transformacao afim.
function consolidarQualidade(zL: number[], zC: number[], zS: number[]): number[] {
  const combinado = zL.map((_, i) => {
    const pilares = [zL[i], zC[i], zS[i]].filter(v => !isNaN(v));
    if (pilares.length < MIN_PILARES_QUALIDADE) return NaN;
    return media(pilares);
  });
  return zScore(combinado);
}

export interface ValorMomentoOutput {
  zValor: number;
  zMomento: number;
  zValorMomento: number;
}

// Soma dos Z-Scores de Valor e Momento seguida de nova padronizacao. O TCC exige peso
// igualitario para as duas estrategias, entao faltando uma das pernas o indicador fica
// ausente em vez de ser calculado so com a outra.
// Nao ha nova padronizacao sobre zValor/zMomento: eles ja saem padronizados de
// rankThenZScore, e reaplicar z seria identidade.
export function calcularValorMomento(
  beMe: (number | null | undefined)[],
  mom2: (number | null | undefined)[]
): ValorMomentoOutput[] {
  const zValor = rankThenZScore(beMe);
  const zMomento = rankThenZScore(mom2);

  const soma = zValor.map((v, i) => (isNaN(v) || isNaN(zMomento[i]) ? NaN : v + zMomento[i]));
  const zValorMomento = zScore(soma);

  return zValor.map((_, i) => ({
    zValor: zValor[i],
    zMomento: zMomento[i],
    zValorMomento: zValorMomento[i],
  }));
}

export function pipelineZScore(indicadores: IndicadorFinanceiro[]): ZScoreOutput[] {
  if (indicadores.length < 2) return [];

  const tickers = indicadores.map(i => i.ticker);
  const n = tickers.length;

  // Lucratividade. ACC NAO e invertido: a formula da Tabela I, (Depreciacao - dCapital
  // de Giro)/Ativo Total, ja e a forma com o sinal trocado do accrual contabil - e a
  // construcao do QMJ, em que ACC assim definido entra positivamente no pilar (ACC
  // maior = menos accruals = mais qualidade). Inverter aqui inverteria duas vezes e
  // passaria a premiar empresas com mais accruals.
  const zLucratividade = consolidarPilar([
    rankThenZScore(indicadores.map(i => i.roa)),
    rankThenZScore(indicadores.map(i => i.roe)),
    rankThenZScore(indicadores.map(i => i.gpoa)),
    rankThenZScore(indicadores.map(i => i.gmar)),
    rankThenZScore(indicadores.map(i => i.cfoa)),
    rankThenZScore(indicadores.map(i => i.acc)),
  ], n);

  const zCrescimento = consolidarPilar([
    rankThenZScore(indicadores.map(i => i.crescRoa)),
    rankThenZScore(indicadores.map(i => i.crescRoe)),
    rankThenZScore(indicadores.map(i => i.crescGpoa)),
    rankThenZScore(indicadores.map(i => i.crescGmar)),
    rankThenZScore(indicadores.map(i => i.crescCfoa)),
  ], n);

  // Seguranca: menor e melhor nos tres (beta baixo, pouca alavancagem, lucro estavel).
  const zSeguranca = consolidarPilar([
    rankThenZScore(indicadores.map(i => i.bab), true),
    rankThenZScore(indicadores.map(i => i.lev), true),
    rankThenZScore(indicadores.map(i => i.evol), true),
  ], n);

  const zQualidade = consolidarQualidade(zLucratividade, zCrescimento, zSeguranca);
  const vm = calcularValorMomento(
    indicadores.map(i => i.beMe),
    indicadores.map(i => i.mom2)
  );

  const mapaQualidade = classificarEmTercis(
    tickers.map((t, i) => ({ ticker: t, valor: zQualidade[i] }))
  );
  const mapaSinalVM = classificarSinalEmTercis(
    tickers.map((t, i) => ({ ticker: t, valor: vm[i].zValorMomento }))
  );

  return tickers.map((ticker, i) => ({
    ticker,
    zLucratividade: nulo(zLucratividade[i]),
    zCrescimento: nulo(zCrescimento[i]),
    zSeguranca: nulo(zSeguranca[i]),
    zQualidade: nulo(zQualidade[i]),
    zValor: nulo(vm[i].zValor),
    zMomento: nulo(vm[i].zMomento),
    zValorMomento: nulo(vm[i].zValorMomento),
    classificacaoQualidade: mapaQualidade.get(ticker) ?? null,
    sinalVM: mapaSinalVM.get(ticker) ?? null,
  }));
}

// Uma empresa entra no pipeline se tiver ao menos um indicador. Exigir ROA descartaria
// empresas que tem os outros treze.
const TEM_ALGUM_INDICADOR = {
  OR: [
    { roa: { not: null } }, { roe: { not: null } }, { gpoa: { not: null } },
    { gmar: { not: null } }, { cfoa: { not: null } }, { acc: { not: null } },
    { bab: { not: null } }, { lev: { not: null } }, { evol: { not: null } },
    { beMe: { not: null } }, { mom2: { not: null } },
  ],
};

async function carregarIndicadoresMaisRecentes(): Promise<IndicadorFinanceiro[]> {
  const indicadores = await prisma.indicadorCalculado.findMany({
    where: TEM_ALGUM_INDICADOR,
    orderBy: { dataReferencia: "desc" },
  });

  const latest: Record<string, IndicadorFinanceiro> = {};
  for (const ind of indicadores) {
    if (latest[ind.ticker]) continue;
    latest[ind.ticker] = {
      ticker: ind.ticker,
      dataReferencia: ind.dataReferencia,
      roa: ind.roa ?? undefined,
      roe: ind.roe ?? undefined,
      gpoa: ind.gpoa ?? undefined,
      gmar: ind.gmar ?? undefined,
      cfoa: ind.cfoa ?? undefined,
      acc: ind.acc ?? undefined,
      bab: ind.bab ?? undefined,
      lev: ind.lev ?? undefined,
      evol: ind.evol ?? undefined,
      beMe: ind.beMe ?? undefined,
      mom2: ind.mom2 ?? undefined,
      crescRoa: ind.crescRoa ?? undefined,
      crescRoe: ind.crescRoe ?? undefined,
      crescGpoa: ind.crescGpoa ?? undefined,
      crescGmar: ind.crescGmar ?? undefined,
      crescCfoa: ind.crescCfoa ?? undefined,
    };
  }
  return Object.values(latest);
}

export async function executarPipelineCompleto(): Promise<void> {
  const resultados = pipelineZScore(await carregarIndicadoresMaisRecentes());
  // Um unico instante para a rodada inteira: o lote fica coerente e a chave
  // [ticker, dataCalculo] nao corre risco de colidir entre criacoes consecutivas.
  const dataCalculo = new Date();

  for (const r of resultados) {
    await prisma.zScoreResultado.create({
      data: {
        ticker: r.ticker,
        dataCalculo,
        zLucratividade: r.zLucratividade,
        zCrescimento: r.zCrescimento,
        zSeguranca: r.zSeguranca,
        zQualidade: r.zQualidade,
        zValor: r.zValor,
        zMomento: r.zMomento,
        zValorMomento: r.zValorMomento,
        classificacaoQualidade: r.classificacaoQualidade,
        sinalVM: r.sinalVM,
      },
    });
    console.log(`  ZScore ${r.ticker}: Q=${r.zQualidade?.toFixed(3) ?? "-"} VM=${r.zValorMomento?.toFixed(3) ?? "-"}`);
  }
}

// Recalcula so a perna de Valor/Momento, que depende do preco atual, sem repetir os
// indicadores fundamentalistas (que so mudam no sync trimestral).
// reclassificar = false mantem o sinal congelado: o tercil so e reescrito na rodada
// diaria, senao uma acao parada em cima do corte de 33% alternaria entre "Compra" e
// "Indefinido" a cada 5 minutos.
export async function recalcularValorMomentoZScore(reclassificar = false): Promise<void> {
  const indicadores = await prisma.indicadorCalculado.findMany({
    orderBy: { dataReferencia: "desc" },
  });

  const latest: Record<string, { ticker: string; beMe: number | null; mom2: number | null }> = {};
  for (const ind of indicadores) {
    if (!latest[ind.ticker]) {
      latest[ind.ticker] = { ticker: ind.ticker, beMe: ind.beMe, mom2: ind.mom2 };
    }
  }

  const rows = Object.values(latest);
  if (rows.length < 2) return;

  const tickers = rows.map(r => r.ticker);
  const vm = calcularValorMomento(rows.map(r => r.beMe), rows.map(r => r.mom2));

  const mapaSinalVM = reclassificar
    ? classificarSinalEmTercis(tickers.map((t, i) => ({ ticker: t, valor: vm[i].zValorMomento })))
    : null;

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const ultimo = await prisma.zScoreResultado.findFirst({
      where: { ticker },
      orderBy: { dataCalculo: "desc" },
    });
    if (!ultimo) continue;

    await prisma.zScoreResultado.update({
      where: { id: ultimo.id },
      data: {
        zValor: nulo(vm[i].zValor),
        zMomento: nulo(vm[i].zMomento),
        zValorMomento: nulo(vm[i].zValorMomento),
        ...(mapaSinalVM ? { sinalVM: mapaSinalVM.get(ticker) ?? null } : {}),
      },
    });
  }
}
