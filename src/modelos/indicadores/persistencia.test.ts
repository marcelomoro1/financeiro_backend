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

type Barra = { data: Date; adjclose: number | null; tipo: string };
let serieMensal: Barra[] = [];

// Reproduz o filtro `data.gte`, o `orderBy` e o `take` do Prisma. Sem isso o teste da
// janela por data nao provaria nada: o mock devolveria a serie inteira independentemente
// do que a consulta pediu, e o bug das duplicatas passaria batido.
function consultarSerie(args: any): Barra[] {
  let r = serieMensal.filter(b => b.adjclose != null);
  const gte = args?.where?.data?.gte;
  if (gte) r = r.filter(b => b.data.getTime() >= gte.getTime());
  const dir = args?.orderBy?.data;
  r = [...r].sort((a, b) =>
    dir === "asc" ? a.data.getTime() - b.data.getTime() : b.data.getTime() - a.data.getTime()
  );
  if (args?.take) r = r.slice(0, args.take);
  return r;
}

const prismaMock = {
  dadosTrimestrais: { findFirst: vi.fn(), findMany: vi.fn() },
  cotacaoHistorica: {
    findFirst: vi.fn(async (args: any) => consultarSerie(args)[0] ?? null),
    findMany: vi.fn(async (args: any) => consultarSerie(args)),
  },
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

// Serie saudavel: uma barra por mes, datada no dia 1o, cobrindo t-2 e t-12.
function barrasMensais(): Barra[] {
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
  serieMensal = barrasMensais();
  prismaMock.indicadorCalculado.update.mockResolvedValue({});
  prismaMock.indicadorCalculado.upsert.mockResolvedValue({});
});

function mom2Gravado(): number | null {
  return prismaMock.indicadorCalculado.update.mock.calls[0][0].data.mom2;
}

describe("calcularMomentum2 - leitura da serie mensal", () => {
  it("sobrevive a duplicatas do mes corrente (incidente de 19/11/2026)", async () => {
    // O Yahoo data a barra do mes EM CURSO no ultimo pregao, e cada sync gravava uma linha
    // nova: PETR4 chegou a 11 linhas de novembro. Com a janela por contagem (`take: 24`),
    // essas duplicatas cobriam apenas 11 meses distintos e t-12 caia fora da leitura.
    serieMensal = [
      ...[1, 3, 10, 11, 12, 13, 16, 17, 18, 19, 20].map(d => ({
        data: new Date(Date.UTC(2026, 10, d)), adjclose: 300, tipo: "mensal",
      })),
      ...Array.from({ length: 23 }, (_, i) => ({
        data: new Date(Date.UTC(2026, 9 - i, 1)), adjclose: 100 + i, tipo: "mensal",
      })),
    ];

    await recalcularValorMomento("PETR4.SA", 500);

    expect(mom2Gravado()).not.toBeNull();
  });

  it("usa a barra do dia 1o, nao o residuo de sync intra-mes, para o P(t-2)", async () => {
    serieMensal = [
      { data: new Date(Date.UTC(2026, 10, 19)), adjclose: 300, tipo: "mensal" }, // mes corrente
      { data: new Date(Date.UTC(2026, 9, 1)), adjclose: 200, tipo: "mensal" },
      // t-2 = 2026-09: o dia 1o traz o fechamento do mes; o dia 11 e residuo
      { data: new Date(Date.UTC(2026, 8, 1)), adjclose: 100, tipo: "mensal" },
      { data: new Date(Date.UTC(2026, 8, 11)), adjclose: 999, tipo: "mensal" },
      ...Array.from({ length: 9 }, (_, i) => ({
        data: new Date(Date.UTC(2026, 7 - i, 1)), adjclose: 90 - i, tipo: "mensal",
      })),
      { data: new Date(Date.UTC(2025, 10, 1)), adjclose: 50, tipo: "mensal" }, // t-12
    ];

    await recalcularValorMomento("PETR4.SA", 500);

    // 100/50 - 1 = 1. Com o residuo vencendo seria 999/50 - 1 = 18,98.
    expect(mom2Gravado()).toBeCloseTo(1, 10);
  });
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
    // Ausencia REAL de dado (o indicador le so o banco, sem rede): grava nulo em vez de
    // preservar o valor anterior, conforme a regra do Bug 2 em projeto.md.
    serieMensal = [{ data: new Date(Date.UTC(2026, 10, 1)), adjclose: 300, tipo: "mensal" }];

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
