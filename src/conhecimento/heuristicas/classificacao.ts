import { TERCIS, CLASSIFICACAO_QUALIDADE, SINAL_VM } from "../dominio/constants";

// Divide o ranking em tres grupos iguais, conforme a secao Fluxo de Processamento do
// TCC: 33% superiores, 33% inferiores e o grupo central.
// Empresas sem nota (NaN) sao removidas ANTES do corte: alem de tornar a ordenacao
// indefinida, elas inflariam o denominador e deslocariam os tercis das que tem nota.
function dividirEmTercis(
  valores: { ticker: string; valor: number }[],
  rotulos: { alto: string; medio: string; baixo: string }
): Map<string, string> {
  const classificaveis = valores.filter(v => v.valor != null && !isNaN(v.valor));
  const ordenados = [...classificaveis].sort((a, b) => b.valor - a.valor);

  const n = ordenados.length;
  const topCut = Math.floor(n * TERCIS.TOP);
  const midCut = Math.floor(n * (TERCIS.TOP + TERCIS.MIDDLE));

  const result = new Map<string, string>();
  ordenados.forEach((item, i) => {
    if (i < topCut) result.set(item.ticker, rotulos.alto);
    else if (i < midCut) result.set(item.ticker, rotulos.medio);
    else result.set(item.ticker, rotulos.baixo);
  });
  return result;
}

export function classificarEmTercis(valores: { ticker: string; valor: number }[]): Map<string, string> {
  return dividirEmTercis(valores, {
    alto: CLASSIFICACAO_QUALIDADE.ALTA,
    medio: CLASSIFICACAO_QUALIDADE.MEDIA,
    baixo: CLASSIFICACAO_QUALIDADE.BAIXA,
  });
}

export function classificarSinalEmTercis(valores: { ticker: string; valor: number }[]): Map<string, string> {
  return dividirEmTercis(valores, {
    alto: SINAL_VM.COMPRA,
    medio: SINAL_VM.INDEFINIDO,
    baixo: SINAL_VM.VENDA,
  });
}
