export interface CarteiraSimuladaDTO {
  id: string;
  nome: string;
  capitalInicial: number;
  saldoDisponivel: number;
  createdAt: Date;
  ativos: CarteiraAtivoDTO[];
  transacoes?: TransacaoDTO[];
  valorInvestido?: number;
  patrimonio?: number;
  rentabilidade?: number;
  rentabilidadeIBOV?: number;
  distribuicaoSetores?: DistribuicaoSetorDTO[];
}

export interface DistribuicaoSetorDTO {
  setor: string;
  valor: number;
  percentual: number;
}

export interface CarteiraAtivoDTO {
  id: string;
  ticker: string;
  nome: string;
  quantidade: number;
  precoMedio: number;
  precoAtual?: number;
  valorAtual?: number;
  rentabilidade?: number;
  setor?: string;
}

export interface TransacaoDTO {
  id: string;
  ticker: string;
  tipo: "compra" | "venda";
  quantidade: number;
  preco: number;
  // Sinal de Valor e Momento no instante da transacao (null em compras antigas,
  // anteriores ao registro do snapshot).
  sinalVM?: string | null;
  data: Date;
}

export interface IndicadorFinanceiro {
  ticker: string;
  dataReferencia: Date;
  roa?: number;
  roe?: number;
  gpoa?: number;
  gmar?: number;
  cfoa?: number;
  acc?: number;
  bab?: number;
  lev?: number;
  evol?: number;
  beMe?: number;
  mom2?: number;
  crescRoa?: number;
  crescRoe?: number;
  crescGpoa?: number;
  crescGmar?: number;
  crescCfoa?: number;
}

export interface ZScoreOutput {
  ticker: string;
  zLucratividade: number | null;
  zCrescimento: number | null;
  zSeguranca: number | null;
  zQualidade: number | null;
  zValor: number | null;
  zMomento: number | null;
  zValorMomento: number | null;
  classificacaoQualidade: string | null;
  sinalVM: string | null;
}

export interface RankingItem {
  ticker: string;
  nome: string;
  setor: string;
  zQualidade?: number;
  zValorMomento?: number;
  classificacaoQualidade: string | null;
  sinalVM: string | null;
  indicadores: {
    roa?: number;
    roe?: number;
    beMe?: number;
    mom2?: number;
    lev?: number;
    bab?: number;
  };
}
