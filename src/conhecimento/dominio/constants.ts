export const EXCLUDED_SECTORS = ["Financial Services"];

export const TERCIS = {
  TOP: 0.33,
  MIDDLE: 0.34,
  BOTTOM: 0.33,
} as const;

export const CLASSIFICACAO_QUALIDADE = {
  ALTA: "Alta Qualidade",
  MEDIA: "Qualidade Média",
  BAIXA: "Baixa Qualidade",
} as const;

export const SINAL_VM = {
  COMPRA: "Compra",
  INDEFINIDO: "Indefinido",
  VENDA: "Venda",
} as const;

export const MAX_ATIVOS_CARTEIRA = 15;
export const TOLERANCIA_VALIDACAO = 0.05;

// Indicadores de fluxo (lucro, receita, CPV, depreciacao, CAPEX) sao consolidados
// nos ultimos 12 meses (LTM). Usar um trimestre solto sobre um estoque de balanco
// produziria um indicador ~4x menor que o publicado por Status Invest/Fundamentus e
// injetaria sazonalidade no escore de Qualidade.
export const TRIMESTRES_LTM = 4;

// A variacao relativa do crescimento nao esta definida quando a base tende a zero.
// Adota-se como piso 25% do pico da propria serie da empresa: enquanto a base for
// saudavel a conta e exatamente a original, e o piso so atua na regiao patologica.
export const PISO_ESCALA_CRESCIMENTO = 0.25;

// Minimo de observacoes anuais de ROE para que o desvio padrao (EVOL) signifique algo.
export const MIN_OBSERVACOES_EVOL = 3;

// Minimo de retornos diarios pareados por data para estimar o beta.
export const MIN_OBSERVACOES_BETA = 120;

// Q = z(L + C + S) exige os tres pilares. Se um pilar inteiro estiver ausente, a nota
// de Qualidade fica ausente em vez de ser calculada com informacao parcial.
export const MIN_PILARES_QUALIDADE = 3;

export const TICKERS_SAMPLE: string[] = [
  "PETR4.SA", "PRIO3.SA", "BRAV3.SA", "ENGI4.SA",
  "VALE3.SA", "GGBR4.SA", "GOAU4.SA", "CSNA3.SA", "USIM5.SA", "CMIN3.SA",
  "SUZB3.SA", "KLBN4.SA", "DXCO3.SA", "RANI3.SA",
  "ABEV3.SA", "JBSS32.SA", "AGRO3.SA", "MBRF3.SA", "MDIA3.SA", "NATU3.SA",
  "SLCE3.SA", "PCAR3.SA", "ASAI3.SA", "CSAN3.SA",
  "MGLU3.SA", "RENT3.SA", "LREN3.SA", "VIVA3.SA", "AZZA3.SA", "CVCB3.SA",
  "GRND3.SA", "SMFT3.SA",
  "RDOR3.SA", "RADL3.SA", "FLRY3.SA", "ONCO3.SA",
  "WEGE3.SA", "EMBJ3.SA", "RAIL3.SA", "ECOR3.SA", "LOGN3.SA", "SBSP3.SA", "TGMA3.SA",
  "AURE3.SA", "CPLE3.SA", "EGIE3.SA", "ENEV3.SA", "TAEE11.SA",
  "TOTS3.SA", "VIVT3.SA",
];
