import { beforeEach, describe, expect, it, vi } from "vitest";

// Regressao do incidente de novembro/2026: o sinal de Valor e Momento desapareceu de quase
// todas as empresas do painel. Causa: o BE/ME era gravado como `null` sempre que o Yahoo
// omitia o `marketCap` da cotacao (campo que ele devolve de forma intermitente), apagando a
// cada ciclo um indicador valido ja calculado. Sem `beMe`, `zValor` sai NaN e `zValorMomento`
// tambem - o sinal deixa de existir para a base inteira.
//
// A regra do TCC ("indicador ausente e melhor que indicador errado", projeto.md Bug 2) manda
// gravar `null` por cima do valor antigo quando o dado REALMENTE nao existe, e isso segue
// valendo para tudo que vem do banco. O BE/ME e a excecao: ele depende de uma leitura de
// rede, e falha de rede nao e ausencia de dado.

const prismaMock = {
  dadosTrimestrais: { findFirst: vi.fn(), findMany: vi.fn() },
  cotacaoHistorica: { findMany: vi.fn() },
  indicadorCalculado: { update: vi.fn(), upsert: vi.fn() },
  empresa: { findMany: vi.fn() },
};

const quoteMock = vi.fn();

vi.mock("../../dados/armazenamento/prisma", () => ({ default: prismaMock }));
vi.mock("../../dados/extracao/yahooFinance", () => ({
  yahooFinance: { quote: (...a: unknown[]) => quoteMock(...a) },
  withRetry: (fn: () => Promise<unknown>) => fn(),
  fetchSerieDiaria: vi.fn(async () => []),
  fetchSerieIbovespa: vi.fn(async () => []),
}));

const { recalcularValorMomento, calcularIndicadores } = await import("./calculadora");

const DATA_REF = new Date("2026-09-30T00:00:00.000Z");

// 24 barras mensais descendentes a partir de 2026-11: garante as chaves t-2 e t-12 que
// calcularMomentum2 procura, para que o mom2 nao seja nulo por falta de serie.
function barrasMensais() {
  return Array.from({ length: 24 }, (_, i) => ({
    data: new Date(Date.UTC(2026, 10 - i, 1)),
    adjclose: 100 + i,
    tipo: "mensal",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.dadosTrimestrais.findFirst.mockResolvedValue({ dataReferencia: DATA_REF });
  // resolveBookValueT6: trimestre defasado com patrimonio liquido disponivel
  prismaMock.dadosTrimestrais.findMany.mockResolvedValue([
    { dataReferencia: new Date("2026-03-31T00:00:00.000Z"), commonStockEquity: 1_000n, stockholdersEquity: 1_000n },
  ]);
  prismaMock.cotacaoHistorica.findMany.mockResolvedValue(barrasMensais());
  prismaMock.indicadorCalculado.update.mockResolvedValue({});
  prismaMock.indicadorCalculado.upsert.mockResolvedValue({});
});

describe("recalcularValorMomento - persistencia do BE/ME", () => {
  it("grava o BE/ME quando o valor de mercado veio", async () => {
    await recalcularValorMomento("PETR4.SA", 500);

    const { data } = prismaMock.indicadorCalculado.update.mock.calls[0][0];
    expect(data.beMe).toBeCloseTo(2, 10); // 1000 / 500
  });

  it("NAO toca no BE/ME quando o marketCap nao veio (preserva o valor anterior)", async () => {
    await recalcularValorMomento("PETR4.SA", null);

    expect(prismaMock.indicadorCalculado.update).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.indicadorCalculado.update.mock.calls[0][0];
    expect("beMe" in data).toBe(false);
  });

  it("NAO toca no BE/ME quando o marketCap vem zerado (leitura defeituosa)", async () => {
    await recalcularValorMomento("PETR4.SA", 0);

    const { data } = prismaMock.indicadorCalculado.update.mock.calls[0][0];
    expect("beMe" in data).toBe(false);
  });

  it("grava BE/ME nulo quando o PL em t-6 realmente nao existe (caso PCAR3)", async () => {
    prismaMock.dadosTrimestrais.findMany.mockResolvedValue([]);

    await recalcularValorMomento("PCAR3.SA", 500);

    const { data } = prismaMock.indicadorCalculado.update.mock.calls[0][0];
    expect(data.beMe).toBeNull();
  });

  it("segue gravando o MOM2-12 nulo quando a serie mensal nao tem t-2/t-12", async () => {
    prismaMock.cotacaoHistorica.findMany.mockResolvedValue([]);

    await recalcularValorMomento("PETR4.SA", 500);

    const { data } = prismaMock.indicadorCalculado.update.mock.calls[0][0];
    expect(data.mom2).toBeNull();
  });
});

describe("calcularIndicadores - persistencia do BE/ME no pipeline completo", () => {
  it("NAO apaga o BE/ME quando a cotacao do Yahoo falha", async () => {
    quoteMock.mockRejectedValue(new Error("Too Many Requests"));

    await calcularIndicadores("PETR4.SA");

    const { update, create } = prismaMock.indicadorCalculado.upsert.mock.calls[0][0];
    expect("beMe" in update).toBe(false); // linha existente preserva o ultimo valor
    expect(create.beMe).toBeNull();       // linha nova nao tem o que preservar
  });

  it("NAO apaga o BE/ME quando a cotacao vem sem marketCap", async () => {
    quoteMock.mockResolvedValue({ regularMarketPrice: 42 });

    await calcularIndicadores("PETR4.SA");

    const { update } = prismaMock.indicadorCalculado.upsert.mock.calls[0][0];
    expect("beMe" in update).toBe(false);
  });

  it("grava o BE/ME normalmente quando o marketCap veio", async () => {
    quoteMock.mockResolvedValue({ regularMarketPrice: 42, marketCap: 500 });

    await calcularIndicadores("PETR4.SA");

    const { update } = prismaMock.indicadorCalculado.upsert.mock.calls[0][0];
    expect(update.beMe).toBeCloseTo(2, 10);
  });
});
