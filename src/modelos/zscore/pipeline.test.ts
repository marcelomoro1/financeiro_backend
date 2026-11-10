import { describe, expect, it } from "vitest";
import { calcularValorMomento, pipelineZScore } from "./pipeline";
import { zScore } from "../../shared/utils/estatistica";
import { IndicadorFinanceiro } from "../../shared/types";

function empresa(ticker: string, campos: Partial<IndicadorFinanceiro> = {}): IndicadorFinanceiro {
  return { ticker, dataReferencia: new Date("2025-09-30"), ...campos };
}

// Constroi N empresas variando um unico indicador, para isolar o efeito dele.
function variando(campo: keyof IndicadorFinanceiro, valores: number[]): IndicadorFinanceiro[] {
  return valores.map((v, i) => empresa(`T${i}`, { [campo]: v } as Partial<IndicadorFinanceiro>));
}

describe("sentido dos indicadores", () => {
  it("ACC entra no sentido direto: maior ACC significa mais qualidade", () => {
    // Regressao da inversao dupla. A formula da Tabela I, (Depr - dCG)/AT, ja e a forma
    // com sinal trocado do accrual contabil - e a construcao do QMJ, em que ACC assim
    // definido entra positivamente no pilar. Inverter o rank aqui passaria a premiar
    // empresas com MAIS accruals.
    const r = pipelineZScore(variando("acc", [0.05, 0.04, 0.03, 0.02, 0.01, 0.0]));
    const notas = r.map(x => x.zLucratividade!);

    expect(notas[0]).toBeGreaterThan(notas[5]);
    for (let i = 1; i < notas.length; i++) {
      expect(notas[i - 1]).toBeGreaterThan(notas[i]);
    }
  });

  it("lucratividade cresce com ROA", () => {
    const r = pipelineZScore(variando("roa", [0.20, 0.15, 0.10, 0.05]));
    expect(r[0].zLucratividade!).toBeGreaterThan(r[3].zLucratividade!);
  });

  it.each([
    ["bab", [0.5, 1.0, 1.5, 2.0]],
    ["lev", [0.1, 0.3, 0.5, 0.7]],
    ["evol", [0.01, 0.05, 0.10, 0.20]],
  ] as [keyof IndicadorFinanceiro, number[]][])(
    "seguranca e invertida para %s: menor valor, maior nota",
    (campo, valores) => {
      const r = pipelineZScore(variando(campo, valores));
      expect(r[0].zSeguranca!).toBeGreaterThan(r[3].zSeguranca!);
    }
  );

  it("valor cresce com BE/ME e momento cresce com MOM2-12", () => {
    const porValor = pipelineZScore(variando("beMe", [1.5, 1.0, 0.5, 0.2]));
    expect(porValor[0].zValor!).toBeGreaterThan(porValor[3].zValor!);

    const porMomento = pipelineZScore(variando("mom2", [0.40, 0.20, 0.0, -0.20]));
    expect(porMomento[0].zMomento!).toBeGreaterThan(porMomento[3].zMomento!);
  });
});

describe("agregacao dos pilares", () => {
  const completas = [
    empresa("A", { roa: 0.20, crescRoa: 0.30, bab: 0.6 }),
    empresa("B", { roa: 0.15, crescRoa: 0.20, bab: 0.9 }),
    empresa("C", { roa: 0.10, crescRoa: 0.10, bab: 1.2 }),
    empresa("D", { roa: 0.05, crescRoa: 0.00, bab: 1.5 }),
  ];

  it("Q equivale a z(L + C + S) quando os tres pilares existem", () => {
    // Equacao (3) do TCC. Usar a media dos pilares em vez da soma e indiferente aqui:
    // z e invariante a transformacao afim e soma = 3 x media.
    const r = pipelineZScore(completas);
    const soma = r.map(x => x.zLucratividade! + x.zCrescimento! + x.zSeguranca!);
    const esperado = zScore(soma);

    r.forEach((x, i) => expect(x.zQualidade!).toBeCloseTo(esperado[i], 10));
  });

  it("cada pilar sai padronizado", () => {
    const r = pipelineZScore(completas);
    const soma = r.reduce((s, x) => s + x.zLucratividade!, 0);
    expect(soma / r.length).toBeCloseTo(0, 10);
  });

  it("Q fica ausente quando so um pilar esta disponivel", () => {
    const r = pipelineZScore(variando("roa", [0.2, 0.1, 0.05, 0.01]));
    expect(r[0].zCrescimento).toBeNull();
    expect(r[0].zSeguranca).toBeNull();
    expect(r[0].zQualidade).toBeNull();
  });

  it("Q fica ausente quando um dos tres pilares esta ausente", () => {
    // Regra estrita: a nota de Qualidade exige os tres pilares. Com dois disponiveis
    // a empresa nao recebe nota, em vez de ser avaliada com informacao parcial.
    const r = pipelineZScore([
      empresa("A", { roa: 0.20, crescRoa: 0.30 }),
      empresa("B", { roa: 0.15, crescRoa: 0.20 }),
      empresa("C", { roa: 0.10, crescRoa: 0.10 }),
      empresa("D", { roa: 0.05, crescRoa: 0.00 }),
    ]);
    expect(r[0].zLucratividade).not.toBeNull();
    expect(r[0].zCrescimento).not.toBeNull();
    expect(r[0].zSeguranca).toBeNull();
    expect(r[0].zQualidade).toBeNull();
  });
});

describe("dado ausente", () => {
  it("indicador faltante nao puxa a empresa para o centro", () => {
    // A lidera o ROA e nao tem CFOA; B e a segunda no ROA e lidera o CFOA.
    // Pela regra do TCC, A e avaliada so pelas metricas que tem e permanece na frente.
    // Se a ausencia virasse zero imputado, a media de A cairia pela metade e B a
    // ultrapassaria - demovida por nao ter o dado, e nao por desempenho.
    const r = pipelineZScore([
      empresa("A", { roa: 0.20 }),
      empresa("B", { roa: 0.15, cfoa: 0.09 }),
      empresa("C", { roa: 0.10, cfoa: 0.08 }),
      empresa("D", { roa: 0.05, cfoa: 0.07 }),
    ]);

    expect(r[0].zLucratividade!).toBeGreaterThan(r[1].zLucratividade!);
    expect(r[1].zLucratividade!).toBeGreaterThan(r[2].zLucratividade!);
  });

  it("indicador presente em uma unica empresa e descartado, nao vira nota", () => {
    // Um z transversal com uma observacao so nao tem significado.
    const r = pipelineZScore([
      empresa("A", { roa: 0.20, cfoa: 0.50 }),
      empresa("B", { roa: 0.10 }),
      empresa("C", { roa: 0.05 }),
    ]);
    const soRoa = pipelineZScore([
      empresa("A", { roa: 0.20 }),
      empresa("B", { roa: 0.10 }),
      empresa("C", { roa: 0.05 }),
    ]);
    expect(r[0].zLucratividade!).toBeCloseTo(soRoa[0].zLucratividade!, 10);
  });

  it("empresa sem nenhum indicador nao recebe nota", () => {
    const r = pipelineZScore([
      empresa("A", { roa: 0.20, crescRoa: 0.3, bab: 0.8 }),
      empresa("B", { roa: 0.10, crescRoa: 0.1, bab: 1.2 }),
      empresa("VAZIA"),
    ]);
    const vazia = r.find(x => x.ticker === "VAZIA")!;
    expect(vazia.zQualidade).toBeNull();
    expect(vazia.classificacaoQualidade).toBeNull();
  });
});

describe("valor e momento", () => {
  it("exige as duas pernas, porque o TCC pede peso igualitario", () => {
    const vm = calcularValorMomento([1.0, 0.8, 0.5], [0.2, null, 0.1]);
    expect(isNaN(vm[1].zValorMomento)).toBe(true);
    expect(isNaN(vm[0].zValorMomento)).toBe(false);
  });

  it("nao reaplica padronizacao redundante sobre as pernas", () => {
    // zValor ja sai padronizado do rank; reaplicar z seria identidade.
    const vm = calcularValorMomento([1.5, 1.0, 0.5, 0.2], [0.3, 0.2, 0.1, 0.0]);
    const soma = vm.map(v => v.zValor + v.zMomento);
    const esperado = zScore(soma);
    vm.forEach((v, i) => expect(v.zValorMomento).toBeCloseTo(esperado[i], 10));
  });
});

describe("classificacao em tercis", () => {
  it("divide em 33% superiores, 33% inferiores e grupo central", () => {
    const valores = [0.30, 0.25, 0.20, 0.15, 0.10, 0.05, 0.02, 0.01, 0.005];
    const r = pipelineZScore(
      valores.map((v, i) => empresa(`T${i}`, { roa: v, crescRoa: v, bab: 1 / v }))
    );
    const ordenado = [...r].sort((a, b) => b.zQualidade! - a.zQualidade!);

    expect(ordenado[0].classificacaoQualidade).toBe("Alta Qualidade");
    expect(ordenado[ordenado.length - 1].classificacaoQualidade).toBe("Baixa Qualidade");

    const contagem = r.reduce<Record<string, number>>((acc, x) => {
      acc[x.classificacaoQualidade!] = (acc[x.classificacaoQualidade!] || 0) + 1;
      return acc;
    }, {});
    expect(contagem["Alta Qualidade"]).toBe(2); // floor(9 * 0,33)
    expect(contagem["Baixa Qualidade"]).toBe(3);
    expect(contagem["Qualidade Média"]).toBe(4);
  });

  it("empresas sem nota nao deslocam os tercis das que tem", () => {
    const comNota = [0.30, 0.25, 0.20, 0.15, 0.10, 0.05, 0.02, 0.01, 0.005].map((v, i) =>
      empresa(`T${i}`, { roa: v, crescRoa: v, bab: 1 / v })
    );
    const referencia = pipelineZScore(comNota);
    const comVazias = pipelineZScore([...comNota, empresa("X1"), empresa("X2"), empresa("X3")]);

    for (const r of referencia) {
      const equivalente = comVazias.find(x => x.ticker === r.ticker)!;
      expect(equivalente.classificacaoQualidade).toBe(r.classificacaoQualidade);
    }
  });
});
