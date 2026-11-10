import { describe, expect, it } from "vitest";
import { covariacao, desvioPadrao, media, rank, variancia, zScore } from "./estatistica";

describe("media", () => {
  it("ignora valores ausentes", () => {
    expect(media([2, NaN, 4])).toBe(3);
  });

  it("devolve NaN quando nao ha nenhum valor valido", () => {
    // Devolver 0 faria uma empresa sem dado nenhum receber nota mediana.
    expect(media([NaN, NaN])).toBeNaN();
    expect(media([])).toBeNaN();
  });
});

describe("desvioPadrao", () => {
  it("usa divisor populacional N, que e o sigma da equacao (2)", () => {
    // media 2; desvios -1,0,1 => sqrt(2/3)
    expect(desvioPadrao([1, 2, 3])).toBeCloseTo(Math.sqrt(2 / 3), 10);
  });

  it("devolve 0 com menos de duas observacoes", () => {
    expect(desvioPadrao([5])).toBe(0);
  });
});

describe("rank (equacao 1)", () => {
  it("atribui 1 ao pior desempenho e N ao melhor", () => {
    expect(rank([10, 30, 20])).toEqual([1, 3, 2]);
  });

  it("inverte quando o menor valor e o melhor", () => {
    // beta baixo = mais seguro = rank alto
    expect(rank([0.5, 1.5, 1.0], true)).toEqual([3, 1, 2]);
  });

  it("mantem ausencia como ausencia e nao ocupa posicao", () => {
    expect(rank([10, NaN, 20])).toEqual([1, NaN, 2]);
  });

  it("empates recebem a media das posicoes", () => {
    // 10, 20, 20, 30 -> posicoes 1, 2, 3, 4; os dois 20 ocupam 2 e 3 -> ambos 2,5
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it("o resultado nao depende da ordem de entrada quando ha empates", () => {
    // Regressao: com posicoes consecutivas, duas empresas de valor identico recebiam
    // notas diferentes conforme a ordem em que as linhas chegavam do banco.
    const a = rank([5, 7, 7, 9]);
    const b = rank([7, 9, 5, 7]);
    // mesmo multiconjunto de posicoes, independentemente da ordem
    expect([...a].sort()).toEqual([...b].sort());
    expect(a[1]).toBe(a[2]);
    expect(b[0]).toBe(b[3]);
  });

  it("empates tambem valem no rank invertido", () => {
    expect(rank([1.0, 0.5, 0.5], true)).toEqual([1, 2.5, 2.5]);
  });
});

describe("zScore (equacao 2)", () => {
  it("produz media 0 e desvio 1", () => {
    const z = zScore([1, 2, 3, 4, 5]);
    expect(media(z)).toBeCloseTo(0, 10);
    expect(desvioPadrao(z)).toBeCloseTo(1, 10);
  });

  it("preserva NaN mesmo sem dispersao", () => {
    // O caso degenerado nao pode converter ausencia em nota media.
    expect(zScore([2, 2, NaN])).toEqual([0, 0, NaN]);
  });

  it("preserva NaN no caso normal", () => {
    const z = zScore([1, NaN, 3]);
    expect(z[1]).toBeNaN();
    expect(z[0]).toBeCloseTo(-1, 10);
    expect(z[2]).toBeCloseTo(1, 10);
  });
});

describe("covariacao e variancia", () => {
  it("beta de uma serie identica ao indice vale 1", () => {
    const r = [0.01, -0.02, 0.03, 0.005, -0.01];
    expect(covariacao(r, r) / variancia(r)).toBeCloseTo(1, 10);
  });

  it("beta de uma serie com o dobro da oscilacao vale 2", () => {
    const mercado = [0.01, -0.02, 0.03, 0.005, -0.01];
    const acao = mercado.map(v => v * 2);
    expect(covariacao(acao, mercado) / variancia(mercado)).toBeCloseTo(2, 10);
  });
});
