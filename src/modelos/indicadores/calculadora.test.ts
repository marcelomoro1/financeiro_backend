import { describe, expect, it } from "vitest";
import {
  calcACC,
  calcBEME,
  calcCFOA,
  calcCrescimento,
  calcGMAR,
  calcGPOA,
  calcLEV,
  calcMOM212,
  calcROA,
  calcROE,
  calcularCrescimentoPilar,
  capitalDeGiro,
  consolidarLTM,
} from "./calculadora";

// ---------------------------------------------------------------------------
// Tabela I - Lucratividade
// ---------------------------------------------------------------------------

describe("formulas da Tabela I", () => {
  it("ROA = Lucro Liquido / Ativo Total", () => {
    expect(calcROA(4_500, 40_000)).toBeCloseTo(0.1125, 10);
  });

  it("ROE = Lucro Liquido / Patrimonio Liquido", () => {
    expect(calcROE(4_500, 20_000)).toBeCloseTo(0.225, 10);
  });

  it("ROE fica ausente com patrimonio liquido negativo", () => {
    expect(calcROE(4_500, -1_000)).toBeNull();
  });

  it("GPOA = (Receita - CPV) / Ativo Total", () => {
    expect(calcGPOA(10_000, 6_000, 40_000)).toBeCloseTo(0.1, 10);
  });

  it("GMAR = (Receita - CPV) / Receita", () => {
    expect(calcGMAR(10_000, 6_000)).toBeCloseTo(0.4, 10);
  });

  it("CFOA = (LL + Depr - dCG - CAPEX) / Ativo Total", () => {
    // (1000 + 300 - 100 - 200) / 10000
    expect(calcCFOA(1_000, 300, 100, -200, 10_000)).toBeCloseTo(0.1, 10);
  });

  it("CFOA fica ausente quando um componente falta, em vez de trata-lo como zero", () => {
    // Substituir CAPEX por 0 nao produz um CFOA aproximado, produz um CFOA inflado.
    expect(calcCFOA(1_000, 300, 100, NaN, 10_000)).toBeNull();
    expect(calcCFOA(1_000, NaN, 100, 200, 10_000)).toBeNull();
    expect(calcCFOA(1_000, 300, NaN, 200, 10_000)).toBeNull();
  });

  it("ACC = (Depreciacao - dCapital de Giro) / Ativo Total", () => {
    expect(calcACC(300, 100, 10_000)).toBeCloseTo(0.02, 10);
  });

  it("ACC fica ausente quando um componente falta", () => {
    expect(calcACC(NaN, 100, 10_000)).toBeNull();
    expect(calcACC(300, NaN, 10_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tabelas II e III
// ---------------------------------------------------------------------------

describe("formulas das Tabelas II e III", () => {
  it("LEV = Divida Total / Ativo Total", () => {
    expect(calcLEV(12_000, 40_000)).toBeCloseTo(0.3, 10);
  });

  it("BE/ME = PL(t-6) / Valor de Mercado(t)", () => {
    expect(calcBEME(20_000, 50_000)).toBeCloseTo(0.4, 10);
  });

  it("BE/ME fica ausente com patrimonio negativo", () => {
    expect(calcBEME(-100, 50_000)).toBeNull();
  });

  it("MOM2-12 = P(t-2) / P(t-12) - 1", () => {
    expect(calcMOM212(120, 100)).toBeCloseTo(0.2, 10);
  });
});

// ---------------------------------------------------------------------------
// Consolidacao LTM
// ---------------------------------------------------------------------------

function trimestre(ano: number, mes: number, campos: Record<string, number>) {
  return {
    dataReferencia: new Date(Date.UTC(ano, mes - 1, 30)),
    totalAssets: null,
    commonStockEquity: null,
    stockholdersEquity: null,
    totalDebt: null,
    currentAssets: null,
    currentLiabilities: null,
    cashAndShortTermInvestments: null,
    currentDebt: null,
    dividendsPayable: null,
    workingCapital: null,
    totalRevenue: null,
    operatingRevenue: null,
    costOfRevenue: null,
    netIncome: null,
    depreciationAmortizationDepletion: null,
    capitalExpenditure: null,
    operatingCashFlow: null,
    freeCashFlow: null,
    ebit: null,
    ebitda: null,
    ...campos,
  };
}

// Ordem decrescente de data, como vem do Prisma.
// O capital de giro e montado pelas quatro parcelas que a definicao operacional usa, e
// nao pelo campo workingCapital do Yahoo: caixa e divida de curto prazo sao neutralizados
// por construcao aqui, para que `capitalGiro[i]` seja exatamente o WC resultante.
function serieTrimestral(
  lucros: number[],
  opts: { capitalGiro?: number[]; caixa?: number[]; dividendosAPagar?: number[] } = {}
) {
  const meses = [9, 6, 3, 12, 9];
  const anos = [2025, 2025, 2025, 2024, 2024];
  return lucros.map((lucro, i) => {
    const cg = opts.capitalGiro ? opts.capitalGiro[i] : 5_000 - i * 100;
    const caixa = opts.caixa ? opts.caixa[i] : 2_000;
    const divPagar = opts.dividendosAPagar ? opts.dividendosAPagar[i] : 0;
    return trimestre(anos[i], meses[i], {
      netIncome: lucro,
      totalAssets: 40_000,
      commonStockEquity: 20_000,
      totalDebt: 12_000,
      totalRevenue: 10_000,
      costOfRevenue: 6_000,
      depreciationAmortizationDepletion: 100,
      capitalExpenditure: -200,
      currentAssets: cg + caixa,
      cashAndShortTermInvestments: caixa,
      // O dividendo declarado entra no Passivo Circulante e sai de novo na formula, para
      // que `capitalGiro[i]` continue sendo exatamente o WC operacional resultante.
      currentLiabilities: 1_500 + divPagar,
      currentDebt: 1_500,
      dividendsPayable: divPagar,
    });
  });
}

describe("consolidarLTM", () => {
  it("soma os fluxos dos 4 trimestres e usa os estoques do balanco mais recente", () => {
    const ltm = consolidarLTM(serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]))!;
    expect(ltm.netIncome).toBe(1_300 + 1_100 + 900 + 1_200); // 4.500
    expect(ltm.receita).toBe(40_000); // 10.000 x 4
    expect(ltm.cpv).toBe(24_000);
    expect(ltm.depreciacao).toBe(400);
    // estoques nao sao somados
    expect(ltm.totalAssets).toBe(40_000);
    expect(ltm.equity).toBe(20_000);
    expect(ltm.dividaTotal).toBe(12_000);
  });

  it("o ROA resultante bate com a base LTM publicada pelas plataformas", () => {
    const ltm = consolidarLTM(serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]))!;
    // 4.500 / 40.000 = 11,25%. Com um trimestre solto daria 1.300/40.000 = 3,25%.
    expect(calcROA(ltm.netIncome, ltm.totalAssets)).toBeCloseTo(0.1125, 10);
  });

  it("calcula o delta de capital de giro contra o balanco de 4 trimestres atras", () => {
    // WC: [5000, 4900, 4800, 4700, 4600] em ordem decrescente de data
    const ltm = consolidarLTM(serieTrimestral([1, 1, 1, 1, 1]))!;
    expect(ltm.deltaCapitalGiro).toBe(5_000 - 4_600);
  });

  it("rotula a janela de 12 meses efetivamente usada", () => {
    const ltm = consolidarLTM(serieTrimestral([1, 1, 1, 1, 1]))!;
    expect(ltm.janela).toBe("4T2024–3T2025");
  });

  it("devolve null com menos de 4 trimestres, em vez de cair no trimestre solto", () => {
    expect(consolidarLTM(serieTrimestral([1, 1, 1]).slice(0, 3))).toBeNull();
  });

  it("devolve null quando falta a LINHA de um trimestre no meio da serie", () => {
    // Caso AGRO3/PCAR3: o registro do trimestre nao existe no banco (diferente de existir
    // com campos nulos). Sem checar contiguidade, "os 4 mais recentes" saltam o buraco e
    // somam 5 trimestres de calendario como se fossem 4, cobrindo 15 meses.
    const serie = serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]);
    serie.splice(2, 1); // remove o 1T2025, deixando Jun26, Mar26, Dez24, Set24
    expect(consolidarLTM(serie)).toBeNull();
  });

  it("nao calcula delta de capital de giro quando a base nao esta a 12 meses", () => {
    // 4 trimestres contiguos, mas o 5o registro (base do dWC) esta a 15 meses.
    const serie = serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]);
    serie[4].dataReferencia = new Date(Date.UTC(2024, 2, 30)); // 1T2024 em vez de 3T2024
    const ltm = consolidarLTM(serie)!;
    expect(ltm).not.toBeNull();
    expect(ltm.deltaCapitalGiro).toBeNaN();
    // e por consequencia CFOA e ACC ficam ausentes, em vez de usar uma variacao de 15 meses
    expect(calcACC(ltm.depreciacao, ltm.deltaCapitalGiro, ltm.totalAssets)).toBeNull();
  });

  it("janela invalida nao produz indicador de fluxo, mas LEV segue calculavel", () => {
    // LEV cruza dois estoques do mesmo balanco, entao independe da janela de 12 meses.
    // E o que mantem AGRO3/PCAR3 pontuando no pilar de Seguranca mesmo sem LTM.
    const serie = serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]);
    serie.splice(2, 1);
    expect(consolidarLTM(serie)).toBeNull();
    expect(calcLEV(12_000, 40_000)).toBeCloseTo(0.3, 10);
  });

  it("aceita a janela quando os quatro trimestres sao consecutivos", () => {
    const ltm = consolidarLTM(serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]))!;
    expect(ltm).not.toBeNull();
    expect(ltm.janela).toBe("4T2024–3T2025");
    expect(ltm.deltaCapitalGiro).not.toBeNaN();
  });

  it("marca o fluxo como ausente quando falta um trimestre da janela", () => {
    const serie = serieTrimestral([1_300, 1_100, 900, 1_200, 1_000]);
    serie[2].netIncome = null;
    const ltm = consolidarLTM(serie)!;
    expect(ltm.netIncome).toBeNaN();
    expect(calcROA(ltm.netIncome, ltm.totalAssets)).toBeNull();
  });

  it("elimina a sazonalidade: o resultado independe de qual trimestre e o mais recente", () => {
    // Varejista que concentra o lucro no 4T. Com um trimestre isolado, o ROA variaria
    // 6x conforme o trimestre de referencia; em LTM os 4 trimestres estao sempre dentro.
    const comQuartoNoTopo = consolidarLTM(serieTrimestral([2_000, 300, 400, 300, 500]))!;
    const comPrimeiroNoTopo = consolidarLTM(serieTrimestral([300, 400, 300, 2_000, 500]))!;
    expect(comQuartoNoTopo.netIncome).toBe(3_000);
    expect(comPrimeiroNoTopo.netIncome).toBe(3_000);
    expect(calcROA(comQuartoNoTopo.netIncome, comQuartoNoTopo.totalAssets)).toBeCloseTo(
      calcROA(comPrimeiroNoTopo.netIncome, comPrimeiroNoTopo.totalAssets)!,
      10
    );
  });
});

// ---------------------------------------------------------------------------
// Capital de giro operacional (Sloan, 1996)
// ---------------------------------------------------------------------------

describe("capitalDeGiro", () => {
  it("exclui caixa, aplicacoes e divida de curto prazo do circulante", () => {
    // (2.000 - 500) - (900 - 300) = 900
    expect(
      capitalDeGiro({
        currentAssets: 2_000,
        cashAndShortTermInvestments: 500,
        currentLiabilities: 900,
        currentDebt: 300,
      })
    ).toBe(900);
  });

  it("fica ausente sem caixa, em vez de cair na definicao contabil bruta", () => {
    // Pela regra do TCC, indicador ausente e melhor que indicador errado: usar AC - PC
    // aqui devolveria 1.100, um numero que parece valido e nao e o que o modelo pede.
    expect(
      capitalDeGiro({
        currentAssets: 2_000,
        cashAndShortTermInvestments: null,
        currentLiabilities: 900,
        currentDebt: 300,
      })
    ).toBeNaN();
  });

  it("fica ausente sem divida de curto prazo", () => {
    expect(
      capitalDeGiro({
        currentAssets: 2_000,
        cashAndShortTermInvestments: 500,
        currentLiabilities: 900,
        currentDebt: null,
      })
    ).toBeNaN();
  });

  it("retira do circulante o dividendo declarado e ainda nao pago", () => {
    // (2.000 - 500) - (1.900 - 300 - 1.000) = 900: o mesmo WC de antes do dividendo ser
    // declarado. Sem a subtracao daria -100, como se a operacao tivesse consumido caixa.
    expect(
      capitalDeGiro({
        currentAssets: 2_000,
        cashAndShortTermInvestments: 500,
        currentLiabilities: 1_900,
        currentDebt: 300,
        dividendsPayable: 1_000,
      })
    ).toBe(900);
  });

  it("trata dividendo a pagar ausente como zero, nao como dado faltante", () => {
    // Sem dividendo declarado o Yahoo nao emite a linha. As outras quatro contas ja
    // provam que o balanco existe, entao aqui ausencia e zero de verdade - devolver NaN
    // derrubaria CFOA e ACC de toda empresa que nao declarou dividendo no trimestre.
    expect(
      capitalDeGiro({
        currentAssets: 2_000,
        cashAndShortTermInvestments: 500,
        currentLiabilities: 900,
        currentDebt: 300,
        dividendsPayable: null,
      })
    ).toBe(900);
  });

  it("ignora o campo workingCapital do Yahoo, que usa a definicao bruta", () => {
    // O Yahoo publica workingCapital = AC - PC. Ler esse campo reintroduziria exatamente
    // o artefato que a definicao operacional existe para eliminar.
    expect(
      capitalDeGiro({
        workingCapital: 1_100,
        currentAssets: 2_000,
        cashAndShortTermInvestments: 500,
        currentLiabilities: 900,
        currentDebt: 300,
      })
    ).toBe(900);
  });
});

describe("regressao: movimento de caixa nao pode virar geracao de caixa operacional", () => {
  // Caso GRND3. A empresa distribuiu dividendo: o caixa caiu de 1.400 para 400 sem que
  // nada mudasse na operacao. Pela definicao bruta (AC - PC), o circulante cai junto, o
  // dWC fica negativo, e como o CFOA entra com -dWC a SAIDA de caixa aparece no indicador
  // como se fosse geracao operacional - no dado real isso inflou o CFOA em 2,4x.
  const caixaCaindo = [400, 700, 1_000, 1_200, 1_400];
  const caixaEstavel = [2_000, 2_000, 2_000, 2_000, 2_000];
  // Operacao parada: estoques, recebiveis e fornecedores identicos nos cinco trimestres.
  const operacaoParada = [5_000, 5_000, 5_000, 5_000, 5_000];

  it("o delta de capital de giro fica em zero quando so o caixa se move", () => {
    const ltm = consolidarLTM(
      serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], {
        capitalGiro: operacaoParada,
        caixa: caixaCaindo,
      })
    )!;
    expect(ltm.deltaCapitalGiro).toBe(0);
  });

  it("CFOA e ACC nao se alteram com a distribuicao de caixa", () => {
    const comDistribuicao = consolidarLTM(
      serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], {
        capitalGiro: operacaoParada,
        caixa: caixaCaindo,
      })
    )!;
    const semDistribuicao = consolidarLTM(
      serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], {
        capitalGiro: operacaoParada,
        caixa: caixaEstavel,
      })
    )!;

    const cfoa = (l: typeof comDistribuicao) =>
      calcCFOA(l.netIncome, l.depreciacao, l.deltaCapitalGiro, l.capex, l.totalAssets)!;
    const acc = (l: typeof comDistribuicao) => calcACC(l.depreciacao, l.deltaCapitalGiro, l.totalAssets)!;

    expect(cfoa(comDistribuicao)).toBeCloseTo(cfoa(semDistribuicao), 12);
    expect(acc(comDistribuicao)).toBeCloseTo(acc(semDistribuicao), 12);

    // Pela definicao bruta o dWC teria sido (400 - 1.400) = -1.000, inflando o CFOA em
    // 1.000/40.000 = 0,025 - um quarto do proprio indicador.
    const cfoaBruto = calcCFOA(
      comDistribuicao.netIncome,
      comDistribuicao.depreciacao,
      -1_000,
      comDistribuicao.capex,
      comDistribuicao.totalAssets
    )!;
    expect(cfoaBruto - cfoa(comDistribuicao)).toBeCloseTo(0.025, 12);
  });

  it("declarar dividendo no fim do exercicio nao gera caixa operacional", () => {
    // Caso GRND3 em dez/2025: R$ 980 mi de dividendo declarado e nao pago inflaram o
    // Passivo Circulante. Retirando so caixa e divida, o WC despenca e a distribuicao
    // volta a entrar no CFOA como geracao de caixa - o bug original por outra porta.
    const semDeclaracao = consolidarLTM(
      serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], { capitalGiro: operacaoParada })
    )!;
    const comDeclaracao = consolidarLTM(
      serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], {
        capitalGiro: operacaoParada,
        dividendosAPagar: [980, 0, 0, 0, 0],
      })
    )!;
    expect(comDeclaracao.deltaCapitalGiro).toBe(0);
    expect(comDeclaracao.deltaCapitalGiro).toBe(semDeclaracao.deltaCapitalGiro);

    // Pela definicao sem essa exclusao o dWC teria sido -980, inflando o ACC em
    // 980/40.000 = 0,0245.
    const accInflado = calcACC(comDeclaracao.depreciacao, -980, comDeclaracao.totalAssets)!;
    const accCorreto = calcACC(comDeclaracao.depreciacao, comDeclaracao.deltaCapitalGiro, comDeclaracao.totalAssets)!;
    expect(accInflado - accCorreto).toBeCloseTo(0.0245, 12);
  });

  it("variacao real de estoques e recebiveis continua sendo capturada", () => {
    // A correcao nao anestesia o indicador: o que muda na OPERACAO segue entrando.
    const ltm = consolidarLTM(
      serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], {
        capitalGiro: [5_400, 5_300, 5_200, 5_100, 5_000],
        caixa: caixaCaindo,
      })
    )!;
    expect(ltm.deltaCapitalGiro).toBe(400);
  });

  it("sem caixa no balanco o indicador de fluxo fica ausente, nao aproximado", () => {
    const serie = serieTrimestral([1_000, 1_000, 1_000, 1_000, 1_000], {
      capitalGiro: operacaoParada,
    });
    serie[0].cashAndShortTermInvestments = null;
    const ltm = consolidarLTM(serie)!;
    expect(ltm.deltaCapitalGiro).toBeNaN();
    expect(calcCFOA(ltm.netIncome, ltm.depreciacao, ltm.deltaCapitalGiro, ltm.capex, ltm.totalAssets)).toBeNull();
    expect(calcACC(ltm.depreciacao, ltm.deltaCapitalGiro, ltm.totalAssets)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pilar de Crescimento
// ---------------------------------------------------------------------------

const ano = (a: number) => new Date(Date.UTC(a, 11, 31));

describe("calcCrescimento", () => {
  it("calcula a media das variacoes relativas ano a ano", () => {
    // 0,10 -> 0,12 (+20%) -> 0,18 (+50%): media +35%
    const serie = [
      { valor: 0.1, ano: ano(2022) },
      { valor: 0.12, ano: ano(2023) },
      { valor: 0.18, ano: ano(2024) },
    ];
    expect(calcCrescimento(serie)).toBeCloseTo(0.35, 10);
  });

  it("nao costura exercicios nao adjacentes", () => {
    // 2023 ausente: o par (2022, 2024) nao pode virar "variacao de um ano".
    const serie = [
      { valor: 0.1, ano: ano(2022) },
      { valor: null, ano: ano(2023) },
      { valor: 0.18, ano: ano(2024) },
    ];
    expect(calcCrescimento(serie)).toBeNull();
  });

  it("nao deixa base proxima de zero explodir a posicao no rank", () => {
    // 0,0001 -> 0,01 daria +9.900% sem piso, pondo essa empresa (ROA de 1%) a frente
    // de uma que foi de 0,15 para 0,25.
    const quaseZero = calcCrescimento([
      { valor: 0.0001, ano: ano(2023) },
      { valor: 0.01, ano: ano(2024) },
    ])!;
    const saudavel = calcCrescimento([
      { valor: 0.15, ano: ano(2023) },
      { valor: 0.25, ano: ano(2024) },
    ])!;
    expect(quaseZero).toBeLessThan(99);
    expect(quaseZero).toBeLessThanOrEqual(1 / 0.25);
    expect(saudavel).toBeCloseTo(2 / 3, 10);
  });

  it("nao altera o resultado quando a base e saudavel", () => {
    // |base| >= 25% do pico: o piso nao morde e a conta e exatamente a original.
    const serie = [
      { valor: 0.2, ano: ano(2023) },
      { valor: 0.25, ano: ano(2024) },
    ];
    expect(calcCrescimento(serie)).toBeCloseTo(0.25, 10);
  });
});

describe("calcularCrescimentoPilar", () => {
  it("exige quatro exercicios anuais", () => {
    const anual = [1, 2, 3].map(i =>
      trimestre(2025 - i, 12, { netIncome: 1_000, totalAssets: 10_000 })
    );
    expect(calcularCrescimentoPilar(anual)).toEqual({
      roa: null, roe: null, gpoa: null, gmar: null, cfoa: null,
    });
  });

  it("mede a variacao do ROA anual ao longo dos exercicios", () => {
    // ROA: 2021 0,08 | 2022 0,09 | 2023 0,10 | 2024 0,11 (ordem decrescente na entrada)
    const anual = [
      trimestre(2024, 12, { netIncome: 1_100, totalAssets: 10_000 }),
      trimestre(2023, 12, { netIncome: 1_000, totalAssets: 10_000 }),
      trimestre(2022, 12, { netIncome: 900, totalAssets: 10_000 }),
      trimestre(2021, 12, { netIncome: 800, totalAssets: 10_000 }),
    ];
    const cresc = calcularCrescimentoPilar(anual);
    expect(cresc.roa).not.toBeNull();
    expect(cresc.roa!).toBeGreaterThan(0);
  });
});
