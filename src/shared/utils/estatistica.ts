export function media(valores: number[]): number {
  const validos = valores.filter(v => v !== null && v !== undefined && !isNaN(v));
  // Sem nenhum valor valido a media nao existe. Devolver 0 aqui faria uma empresa
  // sem dado nenhum receber nota mediana, que e exatamente o oposto da regra do TCC.
  if (validos.length === 0) return NaN;
  return validos.reduce((acc, v) => acc + v, 0) / validos.length;
}

// Desvio padrao populacional (divisor N) - e o sigma da equacao (2) do TCC.
export function desvioPadrao(valores: number[]): number {
  const validos = valores.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (validos.length < 2) return 0;
  const m = media(validos);
  const quadrados = validos.map(v => (v - m) ** 2);
  return Math.sqrt(quadrados.reduce((acc, v) => acc + v, 0) / validos.length);
}

// Equacao (1) do TCC: r_x = rank(x). Substitui o valor bruto pela posicao na
// classificacao, protegendo a analise contra valores fora da curva.
// Entradas ausentes permanecem NaN e nao ocupam posicao.
// invert = true quando o menor valor e o melhor (BAB, LEV, EVOL).
export function rank(valores: number[], invert = false): number[] {
  const validos = valores
    .map((valor, index) => ({ valor, index }))
    .filter(item => !isNaN(item.valor));

  const ordenados = [...validos].sort((a, b) => (invert ? b.valor - a.valor : a.valor - b.valor));

  const ranks: number[] = new Array(valores.length).fill(NaN);

  // Empates recebem a MEDIA das posicoes que ocupam. Atribuir posicoes consecutivas
  // faria duas empresas com o mesmo valor receberem notas diferentes, e a escolha de
  // qual fica na frente dependeria da ordem em que as linhas vieram do banco - o mesmo
  // dado produziria escores diferentes a cada consulta.
  let i = 0;
  while (i < ordenados.length) {
    let j = i;
    while (j + 1 < ordenados.length && ordenados[j + 1].valor === ordenados[i].valor) j++;
    const posicaoMedia = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[ordenados[k].index] = posicaoMedia;
    i = j + 1;
  }

  return ranks;
}

// Equacao (2) do TCC: z_x = (r_x - mu) / sigma.
export function zScore(valores: number[]): number[] {
  const m = media(valores);
  const dp = desvioPadrao(valores);
  // Sem dispersao (ou sem valor valido algum) todos ficam na media - mas ausencia
  // continua sendo ausencia: NaN nao pode virar nota 0.
  if (dp === 0 || isNaN(m)) return valores.map(v => (isNaN(v) ? NaN : 0));
  return valores.map(v => (isNaN(v) ? NaN : (v - m) / dp));
}

// Cov(R_i, R_m) da Tabela II - divisor N, pareado com variancia().
export function covariacao(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return NaN;
  const meanX = media(x.slice(0, n));
  const meanY = media(y.slice(0, n));
  let cov = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - meanX) * (y[i] - meanY);
  }
  return cov / n;
}

// Var(R_m) da Tabela II.
export function variancia(valores: number[]): number {
  const dp = desvioPadrao(valores);
  return dp * dp;
}
