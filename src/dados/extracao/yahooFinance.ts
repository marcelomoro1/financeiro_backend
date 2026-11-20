import YahooFinance from "yahoo-finance2";
import prisma from "../armazenamento/prisma";
import { EXCLUDED_SECTORS, TICKERS_SAMPLE } from "../../conhecimento/dominio/constants";

const yahooFinance: InstanceType<typeof YahooFinance> = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

const DELAY_MS = 500;

// Empresas cujos fundamentos trimestrais/anuais o Yahoo Finance devolve em USD, nao em BRL
// (verificado contra os resultados oficiais divulgados: Vale e Petrobras reportam globalmente
// em dolar, e a Embraer tem parte relevante da receita em dolar). Sem essa conversao, os valores
// brutos (e o indicador BE/ME, que cruza patrimonio com o market cap em BRL) ficam incorretos.
const TICKERS_REPORTAM_EM_USD = ["VALE3.SA", "PETR4.SA", "EMBJ3.SA"];

let cachedFxRate: { rate: number; fetchedAt: number } | null = null;

async function getFxRateUsdBrl(): Promise<number> {
  const now = Date.now();
  if (cachedFxRate && now - cachedFxRate.fetchedAt < 5 * 60_000) {
    return cachedFxRate.rate;
  }
  const quote = await withRetry(() => yahooFinance.quote("BRL=X"));
  const rate = quote.regularMarketPrice || 5.0;
  cachedFxRate = { rate, fetchedAt: now };
  return rate;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  const backoffs = [1000, 5000, 15000];
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i === retries - 1) throw e;
      console.log(`  Retry ${i + 1}/${retries} - ${e.message?.substring(0, 80)}`);
      await new Promise(r => setTimeout(r, backoffs[i]));
    }
  }
  throw new Error("Max retries exceeded");
}

export async function syncEmpresas(): Promise<void> {
  const falhas: string[] = [];
  const excluidas: string[] = [];

  for (const ticker of TICKERS_SAMPLE) {
    await delay(DELAY_MS);
    try {
      const quote = await withRetry(() => yahooFinance.quote(ticker));
      const profile = await withRetry(() =>
        yahooFinance.quoteSummary(ticker, { modules: ["summaryProfile"] })
      );

      const setor = profile.summaryProfile?.sector || null;
      const industria = profile.summaryProfile?.industry || null;

      if (setor && EXCLUDED_SECTORS.includes(setor)) {
        console.log(`  ${ticker}: EXCLUIDO (setor: ${setor})`);
        excluidas.push(ticker);
        continue;
      }

      await prisma.empresa.upsert({
        where: { ticker },
        update: {
          nome: quote.longName || quote.shortName || ticker,
          setor,
          industria,
          volumeMedio: quote.averageVolume ? BigInt(Math.round(quote.averageVolume)) : null,
        },
        create: {
          ticker,
          nome: quote.longName || quote.shortName || ticker,
          setor,
          industria,
          volumeMedio: quote.averageVolume ? BigInt(Math.round(quote.averageVolume)) : null,
        },
      });
      console.log(`  ${ticker}: OK`);
    } catch (e: any) {
      console.log(`  ${ticker}: ERRO - ${e.message?.substring(0, 100)}`);
      falhas.push(ticker);
    }
  }

  // O TCC declara uma amostra de 50 acoes. Um ticker que o Yahoo nao resolve sai da
  // amostra em silencio, entao o total efetivo precisa ser reportado.
  const efetivas = await prisma.empresa.count({ where: { ativa: true } });
  console.log(`[AMOSTRA] ${efetivas} empresas ativas de ${TICKERS_SAMPLE.length} tickers declarados`);
  if (falhas.length) console.log(`[AMOSTRA] Nao resolvidos pelo Yahoo: ${falhas.join(", ")}`);
  if (excluidas.length) console.log(`[AMOSTRA] Excluidos por setor: ${excluidas.join(", ")}`);
  if (efetivas < TICKERS_SAMPLE.length) {
    console.log(`[AMOSTRA] ATENCAO: amostra abaixo dos ${TICKERS_SAMPLE.length} declarados no TCC`);
  }
}

// Snapshot intraday: 1 linha por ticker POR DIA, sobrescrita a cada ciclo de 5 minutos.
// Antes acumulava uma linha por execucao (~14.400/dia, ~430 mil/mes - ver "Crescimento do
// banco" em hospedagem.md); agora cai para 1/dia por ticker.
//
// A data NAO pode ser uma sentinela fixa: `simulacaoRoutes` une as series "mensal" e
// "intraday" ordenando por `data` (simulacaoRoutes.ts:186-193) e usa `data.getTime()` no
// eixo temporal (simulacaoRoutes.ts:278). Uma data fixa no passado faria o preco de HOJE
// virar o primeiro ponto da serie historica.
function inicioDoDiaUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Retencao dos snapshots intraday, conforme a politica sugerida em hospedagem.md secao 4.
const INTRADAY_RETENCAO_DIAS = 90;

export async function syncCotacoes(): Promise<{ ticker: string; marketCap: number | null }[]> {
  const tickers = await prisma.empresa.findMany({ where: { ativa: true }, select: { ticker: true } });
  const atualizados: { ticker: string; marketCap: number | null }[] = [];
  let semMarketCap = 0;

  for (const { ticker } of tickers) {
    await delay(DELAY_MS);
    try {
      const quote = await withRetry(() => yahooFinance.quote(ticker));
      const preco = quote?.regularMarketPrice;
      if (!preco) {
        console.log(`  Cotacao ${ticker}: sem preco disponivel`);
        continue;
      }
      // tipo "intraday": snapshot de preco atual (sobrescrito ao longo do dia). Fica separado
      // da serie mensal para nao contaminar a janela do MOM2-12 nos primeiros dias do mes.
      const hoje = inicioDoDiaUtc();
      await prisma.cotacaoHistorica.upsert({
        where: { ticker_data_tipo: { ticker, data: hoje, tipo: "intraday" } },
        update: { adjclose: preco },
        create: { ticker, data: hoje, adjclose: preco, tipo: "intraday" },
      });
      // Cacheado em Empresa para o dashboard exibir preco/variacao em lote sem uma
      // segunda chamada ao Yahoo - regularMarketChangePercent ja vem nesta mesma quote().
      await prisma.empresa.update({
        where: { ticker },
        data: { ultimoPreco: preco, variacaoDiaPercentual: quote?.regularMarketChangePercent ?? null },
      });
      // `?? null` em vez de `|| 0`: marketCap ausente e dado FALTANTE, nao valor zero.
      // Degradar para 0 fazia o BE/ME ser calculado como nulo e, pior, gravado como nulo
      // por cima do valor bom (ver recalcularValorMomento em calculadora.ts).
      const marketCap = quote?.marketCap ?? null;
      if (marketCap == null) semMarketCap++;
      atualizados.push({ ticker, marketCap });
    } catch (e: any) {
      console.log(`  Cotacao ${ticker}: ERRO - ${e.message?.substring(0, 80)}`);
    }
  }

  // Um lote inteiro sem marketCap e sintoma de rate limiting do Yahoo (tipico de IP de
  // datacenter - ver hospedagem.md secao 8.1), nao de dado realmente inexistente. Sem este
  // log a perda era 100% silenciosa: so aparecia na tela, como sinal faltando.
  if (semMarketCap > 0) {
    console.log(`[COTACOES] ATENCAO: ${semMarketCap}/${atualizados.length} tickers sem marketCap`);
  }

  // Retencao dos snapshots intraday. Em try/catch proprio: uma falha de limpeza nao pode
  // abortar a atualizacao de precos e Z-Scores do ciclo (o cron de 5 minutos tem um unico
  // try/catch em volta de tudo - cronJobs.ts:91-101).
  try {
    const corte = inicioDoDiaUtc();
    corte.setUTCDate(corte.getUTCDate() - INTRADAY_RETENCAO_DIAS);
    const { count } = await prisma.cotacaoHistorica.deleteMany({
      where: { tipo: "intraday", data: { lt: corte } },
    });
    if (count > 0) console.log(`[COTACOES] Retencao: ${count} snapshots intraday antigos removidos`);
  } catch (e: any) {
    console.log(`[COTACOES] Falha na retencao de snapshots intraday: ${e.message?.substring(0, 80)}`);
  }

  return atualizados;
}

export interface PontoSerie {
  data: Date;
  adjclose: number;
}

// Busca pura, sem gravar no banco. Usada pelo calculo de beta, que antes dependia do
// efeito colateral de gravacao de syncCotacoesHistoricas para o momento funcionar.
export async function fetchSerieDiaria(symbol: string, period1: Date): Promise<PontoSerie[]> {
  try {
    const chart = await withRetry(() => yahooFinance.chart(symbol, { period1, interval: "1d" }));
    const serie: PontoSerie[] = [];
    for (const quote of chart.quotes) {
      if (quote.date && quote.adjclose != null) {
        serie.push({ data: quote.date, adjclose: quote.adjclose });
      }
    }
    return serie;
  } catch (e: any) {
    console.log(`  Serie diaria ${symbol}: ERRO - ${e.message?.substring(0, 80)}`);
    return [];
  }
}

// O Ibovespa e o mesmo para as 50 empresas. Sem cache seriam 50 requisicoes
// redundantes ao indice por rodada, justamente o que o TCC quer evitar.
let cachedIbov: { serie: PontoSerie[]; fetchedAt: number } | null = null;

export async function fetchSerieIbovespa(period1: Date): Promise<PontoSerie[]> {
  const now = Date.now();
  if (cachedIbov && now - cachedIbov.fetchedAt < 30 * 60_000) {
    return cachedIbov.serie;
  }
  const serie = await fetchSerieDiaria("^BVSP", period1);
  if (serie.length) cachedIbov = { serie, fetchedAt: now };
  return serie;
}

// Persiste a serie do Ibovespa em tabela propria. CotacaoHistorica tem FK obrigatoria
// para Empresa, e cadastrar o indice como empresa o faria aparecer em todo
// findMany({ where: { ativa: true } }) do sistema.
export async function syncSerieIndice(simbolo = "^BVSP"): Promise<number> {
  const inicio = new Date();
  inicio.setFullYear(inicio.getFullYear() - 3);

  const serie = await fetchSerieDiaria(simbolo, inicio);
  for (const ponto of serie) {
    await prisma.cotacaoIndice.upsert({
      where: { simbolo_data: { simbolo, data: ponto.data } },
      update: { fechamento: ponto.adjclose },
      create: { simbolo, data: ponto.data, fechamento: ponto.adjclose },
    });
  }
  return serie.length;
}

// Atualiza apenas o ponto mais recente do indice (chamado pelo cron de 5 minutos).
export async function syncPontoIndice(simbolo = "^BVSP"): Promise<void> {
  try {
    const quote = await withRetry(() => yahooFinance.quote(simbolo));
    const preco = quote?.regularMarketPrice;
    if (!preco) return;
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);
    await prisma.cotacaoIndice.upsert({
      where: { simbolo_data: { simbolo, data: hoje } },
      update: { fechamento: preco },
      create: { simbolo, data: hoje, fechamento: preco },
    });
  } catch (e: any) {
    console.log(`  Indice ${simbolo}: ERRO - ${e.message?.substring(0, 80)}`);
  }
}

// Serie mensal usada pelo MOM2-12.
//
// A data de cada barra e normalizada para o primeiro dia do mes em UTC. O Yahoo entrega os
// meses FECHADOS datados no dia 1o, mas a barra do mes EM CURSO vem datada no ultimo
// pregao - e esse timestamp muda a cada dia. Como a unique e [ticker, data, tipo], gravar
// `quote.date` cru fazia cada sync criar uma linha NOVA em vez de atualizar a do mes: em
// novembro/2026 PETR4 acumulou 11 linhas do mesmo mes, o que encurtou a janela de leitura
// do MOM2-12 e zerou o indicador na base inteira (ver calcularMomentum2). Normalizando, o
// mes em curso sobrescreve a propria linha e a serie fica com exatamente 1 linha por mes.
export async function syncCotacoesHistoricas(ticker: string): Promise<number> {
  try {
    const chart = await withRetry(() =>
      yahooFinance.chart(ticker, { period1: "2021-01-01", interval: "1mo" })
    );

    let gravadas = 0;
    for (const quote of chart.quotes) {
      if (!quote.date || quote.adjclose == null) continue;
      const mes = new Date(Date.UTC(quote.date.getUTCFullYear(), quote.date.getUTCMonth(), 1));
      await prisma.cotacaoHistorica.upsert({
        where: { ticker_data_tipo: { ticker, data: mes, tipo: "mensal" } },
        update: { adjclose: quote.adjclose },
        create: { ticker, data: mes, adjclose: quote.adjclose, tipo: "mensal" },
      });
      gravadas++;
    }
    return gravadas;
  } catch (e: any) {
    console.log(`  Historico ${ticker}: ERRO - ${e.message?.substring(0, 80)}`);
    return 0;
  }
}

// O fundamentalsTimeSeries devolve o mesmo dado sob nomes diferentes conforme a empresa
// (EBIT/EBITDA em maiusculas, depreciacao ora como depreciationAndAmortization, ora como
// reconciledDepreciation). Ler so um nome fazia o campo chegar nulo ao banco mesmo estando
// presente no payload - era o que derrubava CFOA e ACC para ~20% de cobertura.
function primeiro(item: any, ...chaves: string[]): any {
  for (const chave of chaves) {
    const v = item?.[chave];
    if (v != null) return v;
  }
  return null;
}

// O total consolidado (cashCashEquivalentsAndShortTermInvestments) e o campo preferido.
// Quando ausente, ele e reconstruido pela soma das duas parcelas - as duas precisam estar
// presentes, porque usar so o caixa deixaria as aplicacoes financeiras dentro do capital
// de giro e reintroduziria parte do artefato que a definicao operacional elimina.
function somaCaixaEAplicacoes(item: any): number | null {
  const total = item?.cashCashEquivalentsAndShortTermInvestments;
  if (total != null) return Number(total);
  const caixa = item?.cashAndCashEquivalents;
  const aplicacoes = item?.otherShortTermInvestments;
  if (caixa == null || aplicacoes == null) return null;
  return Number(caixa) + Number(aplicacoes);
}

function mapearCampos(item: any, fxRate: number) {
  return {
    totalAssets: moneyField(item.totalAssets, fxRate),
    commonStockEquity: moneyField(primeiro(item, "commonStockEquity", "stockholdersEquity"), fxRate),
    stockholdersEquity: moneyField(item.stockholdersEquity, fxRate),
    totalDebt: moneyField(item.totalDebt, fxRate),
    totalLiabilitiesNetMinorityInterest: moneyField(item.totalLiabilitiesNetMinorityInterest, fxRate),
    currentAssets: moneyField(item.currentAssets, fxRate),
    currentLiabilities: moneyField(item.currentLiabilities, fxRate),
    workingCapital: moneyField(item.workingCapital, fxRate),
    accumulatedDepreciation: moneyField(item.accumulatedDepreciation, fxRate),
    cashAndCashEquivalents: moneyField(primeiro(item, "cashAndCashEquivalents", "cashFinancial"), fxRate),
    // Caixa + aplicacoes financeiras. O Yahoo publica o total consolidado, e quando ele
    // falta o total e a soma exata das duas partes (conferido em GRND3: 87.313 + 365.337
    // = 452.650). Sem uma das partes o campo fica nulo - somar so o caixa subestimaria o
    // que a definicao operacional de capital de giro precisa excluir.
    cashAndShortTermInvestments: moneyField(somaCaixaEAplicacoes(item), fxRate),
    // Divida de curto prazo, incluindo arrendamentos, que a definicao de Sloan retira do
    // passivo circulante por ser financiamento, nao operacao.
    currentDebt: moneyField(
      primeiro(item, "currentDebtAndCapitalLeaseObligation", "currentDebt"),
      fxRate
    ),
    // Dividendo/JCP declarado e nao pago. A ausencia da linha e zero legitimo (nenhum
    // dividendo declarado naquela data), e nao dado faltante - por isso nao ha cadeia de
    // fallback aqui: quem decide se o balanco existe e capitalDeGiro(), pelas contas do
    // circulante.
    dividendsPayable: moneyField(item.dividendsPayable, fxRate),

    totalRevenue: moneyField(primeiro(item, "totalRevenue", "operatingRevenue"), fxRate),
    operatingRevenue: moneyField(item.operatingRevenue, fxRate),
    costOfRevenue: moneyField(item.costOfRevenue, fxRate),
    grossProfit: moneyField(item.grossProfit, fxRate),
    operatingIncome: moneyField(item.operatingIncome, fxRate),
    ebit: moneyField(primeiro(item, "ebit", "EBIT"), fxRate),
    ebitda: moneyField(primeiro(item, "ebitda", "EBITDA", "normalizedEBITDA"), fxRate),
    netIncome: moneyField(item.netIncome, fxRate),
    depreciationAmortizationDepletion: moneyField(
      primeiro(
        item,
        "depreciationAmortizationDepletion",
        "depreciationAndAmortization",
        "reconciledDepreciation",
        "depreciationAndAmortizationInIncomeStatement",
        "depreciation"
      ),
      fxRate
    ),
    interestExpense: moneyField(item.interestExpense, fxRate),

    operatingCashFlow: moneyField(item.operatingCashFlow, fxRate),
    capitalExpenditure: moneyField(primeiro(item, "capitalExpenditure", "purchaseOfPPE"), fxRate),
    freeCashFlow: moneyField(item.freeCashFlow, fxRate),
    changeInWorkingCapital: moneyField(item.changeInWorkingCapital, fxRate),
    dadosCompletos: item as any,
  };
}

async function gravarSerie(ticker: string, serie: any[], tipo: "annual" | "quarterly", fxRate: number): Promise<number> {
  let gravados = 0;
  for (const d of serie) {
    const item = d as any;
    if (!item.date) continue;
    const dados = mapearCampos(item, fxRate);
    await prisma.dadosTrimestrais.upsert({
      where: { ticker_dataReferencia_tipo: { ticker, dataReferencia: item.date, tipo } },
      update: dados,
      create: { ticker, dataReferencia: item.date, tipo, ...dados },
    });
    gravados++;
  }
  return gravados;
}

export async function syncDadosTrimestrais(ticker: string): Promise<void> {
  try {
    const fxRate = TICKERS_REPORTAM_EM_USD.includes(ticker) ? await getFxRateUsdBrl() : 1;

    // Anuais alimentam o pilar de Crescimento, o EVOL e a recomposicao de trimestres.
    const annual = await withRetry(() =>
      yahooFinance.fundamentalsTimeSeries(ticker, { period1: "2021-01-01", type: "annual", module: "all" })
    );
    const nAnual = await gravarSerie(ticker, annual, "annual", fxRate);

    // Trimestrais alimentam a consolidacao LTM. A janela cobre mais que os 5 trimestres
    // necessarios para dar folga a recomposicao quando ha buraco na serie.
    const quarterly = await withRetry(() =>
      yahooFinance.fundamentalsTimeSeries(ticker, { period1: "2023-01-01", type: "quarterly", module: "all" })
    );
    const nTri = await gravarSerie(ticker, quarterly, "quarterly", fxRate);

    console.log(`  ${ticker}: ${nAnual} anual + ${nTri} trimestral salvos`);
  } catch (e: any) {
    console.log(`  Dados ${ticker}: ERRO - ${e.message?.substring(0, 100)}`);
  }
}


function moneyField(value: any, fxRate: number): bigint | null {
  if (value == null) return null;
  try {
    return BigInt(Math.round(Number(value) * fxRate));
  } catch {
    return null;
  }
}

export { yahooFinance };
