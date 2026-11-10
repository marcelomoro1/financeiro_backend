import { covariacao, desvioPadrao, variancia } from "../../shared/utils/estatistica";
import prisma from "../../dados/armazenamento/prisma";
import { fetchSerieDiaria, fetchSerieIbovespa, yahooFinance } from "../../dados/extracao/yahooFinance";
import {
  MIN_OBSERVACOES_BETA,
  MIN_OBSERVACOES_EVOL,
  PISO_ESCALA_CRESCIMENTO,
  TRIMESTRES_LTM,
} from "../../conhecimento/dominio/constants";

const DELAY_ENTRE_EMPRESAS_MS = 500;

export function toNumber(value: any): number {
  if (value == null) return NaN;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value) || NaN;
}

// --------------------------------------------------------------------------
// Formulas das Tabelas I, II e III do TCC
// --------------------------------------------------------------------------

export function calcROA(netIncome: number, totalAssets: number): number | null {
  if (!totalAssets || totalAssets === 0 || isNaN(netIncome) || isNaN(totalAssets)) return null;
  return netIncome / totalAssets;
}

export function calcROE(netIncome: number, equity: number): number | null {
  if (!equity || equity <= 0 || isNaN(netIncome) || isNaN(equity)) return null;
  return netIncome / equity;
}

export function calcGPOA(receita: number, cpv: number, totalAssets: number): number | null {
  if (!totalAssets || totalAssets === 0 || isNaN(receita) || isNaN(cpv) || isNaN(totalAssets)) return null;
  return (receita - cpv) / totalAssets;
}

export function calcGMAR(receita: number, cpv: number): number | null {
  if (!receita || receita === 0 || isNaN(receita) || isNaN(cpv)) return null;
  return (receita - cpv) / receita;
}

// (L. Liq. + Depr. - Delta Capital de Giro - CAPEX) / Ativo Total
// Componente ausente devolve null, nunca zero: substituir CAPEX por 0 nao produz um
// CFOA aproximado, produz um CFOA inflado que entra no rank como se fosse dado bom.
// A tolerancia a dado ausente prevista no TCC age na agregacao do pilar, nao aqui.
export function calcCFOA(
  netIncome: number,
  depreciacao: number,
  deltaCapitalGiro: number,
  capex: number,
  totalAssets: number
): number | null {
  if (!totalAssets || totalAssets === 0 || isNaN(netIncome) || isNaN(totalAssets)) return null;
  if (isNaN(depreciacao) || isNaN(deltaCapitalGiro) || isNaN(capex)) return null;
  return (netIncome + depreciacao - deltaCapitalGiro - Math.abs(capex)) / totalAssets;
}

// (Depreciacao - Delta Capital de Giro) / Ativo Total
export function calcACC(depreciacao: number, deltaCapitalGiro: number, totalAssets: number): number | null {
  if (!totalAssets || totalAssets === 0 || isNaN(totalAssets)) return null;
  if (isNaN(depreciacao) || isNaN(deltaCapitalGiro)) return null;
  return (depreciacao - deltaCapitalGiro) / totalAssets;
}

export function calcLEV(dividaTotal: number, totalAssets: number): number | null {
  if (!totalAssets || totalAssets === 0 || isNaN(dividaTotal) || isNaN(totalAssets)) return null;
  return dividaTotal / totalAssets;
}

export function calcBEME(bookValue: number, marketCap: number): number | null {
  if (!marketCap || marketCap <= 0) return null;
  if (bookValue <= 0 || isNaN(bookValue)) return null;
  return bookValue / marketCap;
}

export function calcMOM212(p2: number, p12: number): number | null {
  if (!p12 || p12 === 0) return null;
  return (p2 / p12) - 1;
}

// --------------------------------------------------------------------------
// Resolvedores de campos brutos
// --------------------------------------------------------------------------

function deriveDepreciation(ebitda: number, ebit: number): number {
  if (isNaN(ebitda) || isNaN(ebit)) return NaN;
  if (ebitda < ebit) return NaN;
  return ebitda - ebit;
}

function deriveCAPEX(operatingCF: number, freeCF: number): number {
  if (isNaN(operatingCF) || isNaN(freeCF)) return NaN;
  return operatingCF - freeCF;
}

export function resolveDepreciacao(q: any): number {
  const direct = toNumber(q.depreciationAmortizationDepletion);
  if (!isNaN(direct)) return direct;
  return deriveDepreciation(toNumber(q.ebitda), toNumber(q.ebit));
}

export function resolveCAPEX(q: any): number {
  const direct = toNumber(q.capitalExpenditure);
  if (!isNaN(direct)) return direct;
  return deriveCAPEX(toNumber(q.operatingCashFlow), toNumber(q.freeCashFlow));
}

// Capital de giro OPERACIONAL, na definicao de accruals de Sloan (1996) que o QMJ
// (Asness, Frazzini, Pedersen 2019) adota:
//
//   WC = (Ativo Circ. - caixa e aplicacoes) - (Passivo Circ. - divida de curto prazo - dividendos a pagar)
//
// O circulante contabil bruto (AC - PC, ou o campo workingCapital do Yahoo) inclui caixa
// e divida, que sao decisoes de financiamento, nao de operacao. Como o CFOA entra com
// -dWC, uma distribuicao de dividendos derruba o caixa, derruba o circulante e a saida
// de caixa aparece no indicador COMO SE FOSSE geracao operacional. Medido na GRND3, isso
// inflava o CFOA em 2,4x e o ACC em 5,2x; 11 das 48 empresas tinham distorcao acima de
// 5 p.p. do ativo total, com inversao de sinal em algumas.
//
// A variacao continua sendo diferenca entre dois balancos, e nao a soma de
// changeInWorkingCapital, porque o Yahoo alterna esse campo entre valor do trimestre e
// acumulado no ano dependendo da empresa.
//
// Faltando caixa ou divida de curto prazo o indicador fica ausente (NaN), em vez de cair
// na definicao bruta: pela regra do TCC, indicador ausente e melhor que indicador errado.
export function capitalDeGiro(q: any): number {
  const ca = toNumber(q.currentAssets);
  const cl = toNumber(q.currentLiabilities);
  const caixa = toNumber(q.cashAndShortTermInvestments);
  const dividaCurtoPrazo = toNumber(q.currentDebt);
  if (isNaN(ca) || isNaN(cl) || isNaN(caixa) || isNaN(dividaCurtoPrazo)) return NaN;
  // Dividendo declarado e ainda nao pago tambem sai do circulante. Retirar so caixa e
  // divida deixava a mesma distorcao entrar por outra porta: na B3 o dividendo e
  // declarado no fechamento do exercicio e pago meses depois, entao ele infla o Passivo
  // Circulante, derruba o capital de giro e a distribuicao volta a aparecer no CFOA como
  // geracao de caixa. Medido na GRND3: R$ 980 mi parados no circulante em dez/2025
  // levavam o ACC de 0,0126 para 0,0597.
  //
  // Ausencia aqui e zero legitimo, nao dado faltante: as quatro contas acima ja provam
  // que o balanco foi publicado, e sem dividendo declarado o Yahoo nao emite a linha.
  const dividendosAPagar = toNumber(q.dividendsPayable) || 0;
  return (ca - caixa) - (cl - dividaCurtoPrazo - dividendosAPagar);
}

// --------------------------------------------------------------------------
// Consolidacao LTM (ultimos 12 meses)
// --------------------------------------------------------------------------

function rotuloTrimestre(d: Date): string {
  return `${Math.floor(d.getUTCMonth() / 3) + 1}T${d.getUTCFullYear()}`;
}

export function mesesEntre(maisRecente: Date, maisAntiga: Date): number {
  return (maisRecente.getTime() - maisAntiga.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

export interface AgregadoLTM {
  dataReferencia: Date;
  janela: string;
  // estoques: do balanco mais recente
  totalAssets: number;
  equity: number;
  dividaTotal: number;
  // fluxos: consolidados nos ultimos 4 trimestres
  netIncome: number;
  receita: number;
  cpv: number;
  depreciacao: number;
  capex: number;
  deltaCapitalGiro: number;
  estimados: string[];
}

// Fluxos (DRE) sao somados nos 4 ultimos trimestres; estoques (Balanco) vem do
// trimestre mais recente. E o que Status Invest e Fundamentus publicam, e o que
// elimina a sazonalidade que um trimestre isolado injetaria no escore de Qualidade.
export async function montarLTM(ticker: string): Promise<AgregadoLTM | null> {
  const trimestres = await prisma.dadosTrimestrais.findMany({
    where: { ticker, tipo: "quarterly" },
    orderBy: { dataReferencia: "desc" },
    take: TRIMESTRES_LTM + 1, // +1 apenas como base do capital de giro defasado
  });
  return consolidarLTM(trimestres);
}

// Parte pura da consolidacao: recebe os trimestres em ordem decrescente de data.
export function consolidarLTM(trimestres: any[]): AgregadoLTM | null {
  if (trimestres.length < TRIMESTRES_LTM) return null;

  const janela = trimestres.slice(0, TRIMESTRES_LTM);

  // Os quatro trimestres precisam ser CONSECUTIVOS. Quando a linha de um trimestre nao
  // existe no banco (diferente de existir com os campos nulos), "os quatro mais recentes"
  // saltam o buraco e cobrem 15 meses - somando cinco trimestres de calendario como se
  // fossem quatro. Sem esta checagem o indicador sai inflado e sem nenhum sinal.
  for (let i = 1; i < janela.length; i++) {
    const passo = mesesEntre(janela[i - 1].dataReferencia, janela[i].dataReferencia);
    if (passo < 2 || passo > 4) return null;
  }

  const atual = janela[0];
  const estimados: string[] = [];

  const somar = (extrator: (q: any) => number): number => {
    let total = 0;
    for (const q of janela) {
      const v = extrator(q);
      if (isNaN(v)) return NaN;
      total += v;
    }
    return total;
  };

  const netIncome = somar(q => toNumber(q.netIncome));
  const receita = somar(q => toNumber(q.totalRevenue) || toNumber(q.operatingRevenue));
  const cpv = somar(q => toNumber(q.costOfRevenue));

  const depreciacao = somar(q => {
    const direto = toNumber(q.depreciationAmortizationDepletion);
    if (!isNaN(direto)) return direto;
    const derivado = deriveDepreciation(toNumber(q.ebitda), toNumber(q.ebit));
    if (!isNaN(derivado) && !estimados.includes("depreciationAmortizationDepletion")) estimados.push("depreciationAmortizationDepletion");
    return derivado;
  });

  const capex = somar(q => {
    const direto = toNumber(q.capitalExpenditure);
    if (!isNaN(direto)) return direto;
    const derivado = deriveCAPEX(toNumber(q.operatingCashFlow), toNumber(q.freeCashFlow));
    if (!isNaN(derivado) && !estimados.includes("capitalExpenditure")) estimados.push("capitalExpenditure");
    return derivado;
  });

  // Delta Capital de Giro em 12 meses = WC_t - WC_{t-4}. A base precisa estar a um ano
  // de distancia: com um trimestre faltando na serie ela cairia a 15 meses.
  let deltaCapitalGiro = NaN;
  const base = trimestres[TRIMESTRES_LTM];
  if (base) {
    const defasagem = mesesEntre(atual.dataReferencia, base.dataReferencia);
    if (defasagem >= 11 && defasagem <= 13) {
      const wcAtual = capitalDeGiro(atual);
      const wcBase = capitalDeGiro(base);
      // O dWC e sempre derivado de dois balancos, por decisao metodologica e nao por
      // falta de dado, entao nao entra em `estimados`: o campo changeInWorkingCapital do
      // Yahoo nao serve (alterna entre trimestre e acumulado) e o workingCapital dele usa
      // a definicao contabil bruta, que e justamente a que distorce o CFOA.
      if (!isNaN(wcAtual) && !isNaN(wcBase)) deltaCapitalGiro = wcAtual - wcBase;
    }
  }

  return {
    dataReferencia: atual.dataReferencia,
    janela: `${rotuloTrimestre(janela[janela.length - 1].dataReferencia)}–${rotuloTrimestre(atual.dataReferencia)}`,
    totalAssets: toNumber(atual.totalAssets),
    equity: toNumber(atual.commonStockEquity) || toNumber(atual.stockholdersEquity),
    dividaTotal: toNumber(atual.totalDebt),
    netIncome,
    receita,
    cpv,
    depreciacao,
    capex,
    deltaCapitalGiro,
    estimados,
  };
}

// --------------------------------------------------------------------------
// Pilar de Crescimento
// --------------------------------------------------------------------------

export interface PontoSerie {
  valor: number | null;
  ano: Date;
}

// Media das variacoes relativas ano a ano. A base e protegida por um piso derivado
// da propria serie: enquanto |base| >= 25% do pico a conta e exatamente a original,
// e o piso so atua na regiao onde a variacao relativa nao esta definida. Sem ele,
// uma empresa saindo de ROA 0,0001 para 0,01 registra +9.900% e assume o topo do
// rank de crescimento a frente de uma que foi de 0,15 para 0,25.
export function calcCrescimento(serie: PontoSerie[]): number | null {
  const magnitudes = serie
    .map(p => p.valor)
    .filter((v): v is number => v != null && isFinite(v))
    .map(Math.abs);
  if (magnitudes.length < 2) return null;

  const piso = PISO_ESCALA_CRESCIMENTO * Math.max(...magnitudes);
  if (piso === 0) return null;

  let somaDelta = 0;
  let count = 0;
  for (let i = 1; i < serie.length; i++) {
    const ant = serie[i - 1];
    const atu = serie[i];
    if (ant.valor == null || atu.valor == null) continue;
    if (!isFinite(ant.valor) || !isFinite(atu.valor)) continue;
    // Exercicios adjacentes apenas. Sem esta checagem, um ano faltante faria o par
    // (2024, 2022) ser contado como variacao de um ano, e cada empresa passaria a
    // medir um horizonte diferente enquanto todas sao ranqueadas juntas.
    if (mesesEntre(atu.ano, ant.ano) > 15) continue;

    somaDelta += (atu.valor - ant.valor) / Math.max(Math.abs(ant.valor), piso);
    count++;
  }
  return count > 0 ? somaDelta / count : null;
}

interface CrescimentoPilar {
  roa: number | null;
  roe: number | null;
  gpoa: number | null;
  gmar: number | null;
  cfoa: number | null;
}

// Recebe os exercicios anuais em ordem decrescente. Usa os 4 mais recentes (3 variacoes,
// conforme a secao Fluxo de Processamento do TCC) e o 5o apenas como base do capital
// de giro defasado do exercicio mais antigo.
export function calcularCrescimentoPilar(anual: any[]): CrescimentoPilar {
  const vazio: CrescimentoPilar = { roa: null, roe: null, gpoa: null, gmar: null, cfoa: null };
  if (anual.length < 4) return vazio;

  const serie = anual
    .slice(0, 4)
    .map((a, idx) => {
      const anterior = anual[idx + 1];
      const wc = capitalDeGiro(a);
      const wcAnterior = anterior ? capitalDeGiro(anterior) : NaN;
      const deltaWC = !isNaN(wc) && !isNaN(wcAnterior) ? wc - wcAnterior : NaN;
      const receita = toNumber(a.totalRevenue) || toNumber(a.operatingRevenue);
      const totalAssets = toNumber(a.totalAssets);
      return {
        ano: a.dataReferencia as Date,
        roa: calcROA(toNumber(a.netIncome), totalAssets),
        roe: calcROE(toNumber(a.netIncome), toNumber(a.commonStockEquity) || toNumber(a.stockholdersEquity)),
        gpoa: calcGPOA(receita, toNumber(a.costOfRevenue), totalAssets),
        gmar: calcGMAR(receita, toNumber(a.costOfRevenue)),
        cfoa: calcCFOA(toNumber(a.netIncome), resolveDepreciacao(a), deltaWC, resolveCAPEX(a), totalAssets),
      };
    })
    .reverse(); // mais antigo primeiro

  const extrair = (campo: keyof CrescimentoPilar): PontoSerie[] =>
    serie.map(p => ({ valor: p[campo], ano: p.ano }));

  return {
    roa: calcCrescimento(extrair("roa")),
    roe: calcCrescimento(extrair("roe")),
    gpoa: calcCrescimento(extrair("gpoa")),
    gmar: calcCrescimento(extrair("gmar")),
    cfoa: calcCrescimento(extrair("cfoa")),
  };
}

// --------------------------------------------------------------------------
// Valor e Momento
// --------------------------------------------------------------------------

function chaveMes(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function chaveMesDeslocado(d: Date, meses: number): string {
  return chaveMes(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + meses, 1)));
}

// MOM2-12 = P(t-2) / P(t-12) - 1, buscando os meses-alvo por chave explicita.
// Indexar o array por posicao quebraria em silencio se o Yahoo omitisse a barra do
// mes corrente: o calculo viraria P(t-3)/P(t-13) sem nenhum sinal.
async function calcularMomentum2(ticker: string): Promise<number | null> {
  const barras = await prisma.cotacaoHistorica.findMany({
    where: { ticker, tipo: "mensal", adjclose: { not: null } },
    orderBy: { data: "desc" },
    take: 24,
  });
  if (barras.length === 0) return null;

  const porMes = new Map<string, number>();
  for (const b of barras) {
    const chave = chaveMes(b.data);
    if (!porMes.has(chave) && b.adjclose != null) porMes.set(chave, b.adjclose);
  }

  const referencia = barras[0].data;
  const p2 = porMes.get(chaveMesDeslocado(referencia, -2));
  const p12 = porMes.get(chaveMesDeslocado(referencia, -12));
  if (p2 == null || p12 == null) return null;
  return calcMOM212(p2, p12);
}

// Patrimonio Liquido em (t-6), conforme a Tabela III. Sem registro defasado o
// indicador fica ausente: cair no patrimonio atual violaria em silencio a defasagem
// que existe justamente para o indicador nao usar informacao ainda nao divulgada.
async function resolveBookValueT6(ticker: string): Promise<number | null> {
  const t6 = new Date();
  t6.setMonth(t6.getMonth() - 6);

  const dadosT6 = await prisma.dadosTrimestrais.findMany({
    where: { ticker, tipo: "quarterly", dataReferencia: { lte: t6 } },
    orderBy: { dataReferencia: "desc" },
    take: 3,
  });

  for (const d of dadosT6) {
    const bv = toNumber(d.commonStockEquity) || toNumber(d.stockholdersEquity);
    if (bv && !isNaN(bv)) return bv;
  }
  return null;
}

// --------------------------------------------------------------------------
// Seguranca
// --------------------------------------------------------------------------

export async function calcEVOL(ticker: string): Promise<number | null> {
  const dados = await prisma.dadosTrimestrais.findMany({
    where: { ticker, tipo: "annual" },
    orderBy: { dataReferencia: "asc" },
  });

  const roeValues: number[] = [];
  for (const d of dados) {
    if (d.netIncome && d.commonStockEquity && d.commonStockEquity > 0n) {
      const roe = calcROE(toNumber(d.netIncome), toNumber(d.commonStockEquity));
      if (roe != null && isFinite(roe)) roeValues.push(roe);
    }
  }
  // Um desvio padrao sobre 2 pontos nao mede volatilidade de lucro, mede a distancia
  // entre dois numeros.
  if (roeValues.length < MIN_OBSERVACOES_EVOL) return null;
  return desvioPadrao(roeValues);
}

function chaveDia(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// BAB: beta = Cov(R_i, R_m) / Var(R_m), conforme a Tabela II.
// Retornos diarios de 2 anos pareados POR DATA. Parear por indice de array faria a
// acao ser comparada com pregoes errados do Ibovespa sempre que as series tivessem
// tamanhos diferentes (IPO recente, pregao faltante).
export async function calcBeta(ticker: string): Promise<number | null> {
  const inicio = new Date();
  inicio.setFullYear(inicio.getFullYear() - 2);

  const acao = await fetchSerieDiaria(ticker, inicio);
  const indice = await fetchSerieIbovespa(inicio);
  if (acao.length === 0 || indice.length === 0) return null;

  const mapaIndice = new Map<string, number>();
  for (const p of indice) mapaIndice.set(chaveDia(p.data), p.adjclose);

  const pares: { acao: number; indice: number }[] = [];
  for (const ponto of acao) {
    const valorIndice = mapaIndice.get(chaveDia(ponto.data));
    if (valorIndice != null) pares.push({ acao: ponto.adjclose, indice: valorIndice });
  }
  if (pares.length < MIN_OBSERVACOES_BETA) return null;

  const retornosAcao: number[] = [];
  const retornosIndice: number[] = [];
  for (let i = 1; i < pares.length; i++) {
    const antAcao = pares[i - 1].acao;
    const antIndice = pares[i - 1].indice;
    if (!antAcao || !antIndice) continue;
    retornosAcao.push((pares[i].acao - antAcao) / antAcao);
    retornosIndice.push((pares[i].indice - antIndice) / antIndice);
  }
  if (retornosAcao.length < MIN_OBSERVACOES_BETA) return null;

  const varM = variancia(retornosIndice);
  if (varM === 0) return null;
  return covariacao(retornosAcao, retornosIndice) / varM;
}

// --------------------------------------------------------------------------
// Orquestracao
// --------------------------------------------------------------------------

export async function calcularIndicadores(ticker: string): Promise<void> {
  const balanco = await prisma.dadosTrimestrais.findFirst({
    where: { ticker, tipo: "quarterly" },
    orderBy: { dataReferencia: "desc" },
  });
  if (!balanco) return;

  // Pode ser null quando a serie nao tem 4 trimestres contiguos. Nesse caso os
  // indicadores de FLUXO ficam ausentes, mas a empresa segue pontuando pelos que nao
  // dependem da janela (beta, alavancagem, volatilidade do lucro, valor, momento e
  // crescimento). Retornar cedo aqui deixaria os valores da rodada anterior parados no
  // banco, exibidos como se fossem atuais.
  const ltm = await montarLTM(ticker);

  const anual = await prisma.dadosTrimestrais.findMany({
    where: { ticker, tipo: "annual" },
    orderBy: { dataReferencia: "desc" },
    take: 5,
  });

  const mom2 = await calcularMomentum2(ticker);

  let marketCap = 0;
  try {
    const qm = await yahooFinance.quote(ticker);
    marketCap = qm?.marketCap || 0;
  } catch { /* usa 0 se falhar */ }

  const bookValueT6 = await resolveBookValueT6(ticker);
  const beMe = bookValueT6 != null && marketCap ? calcBEME(bookValueT6, marketCap) : null;

  const crescimento = calcularCrescimentoPilar(anual);
  const bab = await calcBeta(ticker);
  const evol = await calcEVOL(ticker);

  const dados = {
    // Fluxo: dependem da janela LTM de 12 meses contiguos.
    roa: ltm ? calcROA(ltm.netIncome, ltm.totalAssets) : null,
    roe: ltm ? calcROE(ltm.netIncome, ltm.equity) : null,
    gpoa: ltm ? calcGPOA(ltm.receita, ltm.cpv, ltm.totalAssets) : null,
    gmar: ltm ? calcGMAR(ltm.receita, ltm.cpv) : null,
    cfoa: ltm ? calcCFOA(ltm.netIncome, ltm.depreciacao, ltm.deltaCapitalGiro, ltm.capex, ltm.totalAssets) : null,
    acc: ltm ? calcACC(ltm.depreciacao, ltm.deltaCapitalGiro, ltm.totalAssets) : null,
    // LEV cruza dois estoques do mesmo balanco: nao precisa da janela.
    lev: calcLEV(toNumber(balanco.totalDebt), toNumber(balanco.totalAssets)),
    bab,
    evol,
    beMe,
    mom2,
    crescRoa: crescimento.roa,
    crescRoe: crescimento.roe,
    crescGpoa: crescimento.gpoa,
    crescGmar: crescimento.gmar,
    crescCfoa: crescimento.cfoa,
  };

  await prisma.indicadorCalculado.upsert({
    where: { ticker_dataReferencia: { ticker, dataReferencia: balanco.dataReferencia } },
    update: dados,
    create: { ticker, dataReferencia: balanco.dataReferencia, ...dados },
  });
}

export async function recalcularValorMomento(ticker: string, marketCap: number): Promise<void> {
  // Roda a cada 5 minutos para as 50 empresas: basta localizar a linha de indicadores
  // do trimestre corrente, sem remontar a consolidacao LTM inteira.
  const maisRecente = await prisma.dadosTrimestrais.findFirst({
    where: { ticker, tipo: "quarterly" },
    orderBy: { dataReferencia: "desc" },
    select: { dataReferencia: true },
  });
  if (!maisRecente) return;

  const bookValueT6 = await resolveBookValueT6(ticker);
  const beMe = bookValueT6 != null && marketCap ? calcBEME(bookValueT6, marketCap) : null;
  const mom2 = await calcularMomentum2(ticker);

  try {
    await prisma.indicadorCalculado.update({
      where: { ticker_dataReferencia: { ticker, dataReferencia: maisRecente.dataReferencia } },
      data: { beMe, mom2 },
    });
  } catch {
    // indicadores base do trimestre ainda nao foram calculados
  }
}

// Recalcula apenas o MOM2-12 a partir da serie mensal ja sincronizada. Nao faz nenhuma
// chamada ao Yahoo - e leitura de banco, pensado para rodar logo depois de
// syncHistoricosMensais() na rodada diaria.
export async function recalcularMomentoTodos(): Promise<void> {
  const empresas = await prisma.empresa.findMany({ where: { ativa: true } });
  let atualizados = 0;

  for (const e of empresas) {
    const maisRecente = await prisma.dadosTrimestrais.findFirst({
      where: { ticker: e.ticker, tipo: "quarterly" },
      orderBy: { dataReferencia: "desc" },
      select: { dataReferencia: true },
    });
    if (!maisRecente) continue;

    const mom2 = await calcularMomentum2(e.ticker);
    try {
      await prisma.indicadorCalculado.update({
        where: { ticker_dataReferencia: { ticker: e.ticker, dataReferencia: maisRecente.dataReferencia } },
        data: { mom2 },
      });
      atualizados++;
    } catch {
      // indicadores do trimestre ainda nao foram calculados
    }
  }

  console.log(`[MOMENTO] MOM2-12 atualizado para ${atualizados} empresas`);
}

const CAMPOS_INDICADORES = [
  "roa", "roe", "gpoa", "gmar", "cfoa", "acc",
  "bab", "lev", "evol",
  "beMe", "mom2",
  "crescRoa", "crescRoe", "crescGpoa", "crescGmar", "crescCfoa",
] as const;

export async function calcularIndicadoresTodos(): Promise<void> {
  const empresas = await prisma.empresa.findMany({ where: { ativa: true } });
  for (const e of empresas) {
    // Cada empresa faz duas chamadas ao Yahoo (serie diaria para o beta e quote para o
    // market cap). O intervalo entre elas evita bloqueio de acesso a API.
    await new Promise(r => setTimeout(r, DELAY_ENTRE_EMPRESAS_MS));
    try {
      await calcularIndicadores(e.ticker);
      console.log(`  Indicadores ${e.ticker}: OK`);
    } catch (err: any) {
      console.log(`  Indicadores ${e.ticker}: ERRO - ${err.message}`);
    }
  }
  await relatarCobertura();
}

// Depois que dado ausente deixou de virar zero, a cobertura de cada indicador passa a
// ser informacao de primeira ordem: sem ela nao ha como saber se o modelo ficou ralo.
export async function relatarCobertura(): Promise<void> {
  const indicadores = await prisma.indicadorCalculado.findMany({
    orderBy: { dataReferencia: "desc" },
  });

  const maisRecentePorTicker = new Map<string, any>();
  for (const ind of indicadores) {
    if (!maisRecentePorTicker.has(ind.ticker)) maisRecentePorTicker.set(ind.ticker, ind);
  }

  const total = maisRecentePorTicker.size;
  if (total === 0) {
    console.log("[COBERTURA] Nenhum indicador calculado.");
    return;
  }

  console.log(`[COBERTURA] ${total} empresas com indicadores:`);
  for (const campo of CAMPOS_INDICADORES) {
    let preenchidos = 0;
    for (const ind of maisRecentePorTicker.values()) {
      if (ind[campo] != null) preenchidos++;
    }
    const pct = ((preenchidos / total) * 100).toFixed(0);
    console.log(`  ${campo.padEnd(10)} ${String(preenchidos).padStart(3)}/${total}  (${pct}%)`);
  }
}
