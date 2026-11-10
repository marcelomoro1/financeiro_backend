import { Router, Response } from "express";
import prisma from "../../dados/armazenamento/prisma";
import { AuthRequest } from "../../infra/middleware/authMiddleware";
import { MAX_ATIVOS_CARTEIRA } from "../../conhecimento/dominio/constants";

const router = Router();

// Preco de mercado mais recente. Como os snapshots intradiarios sao sempre os mais
// novos, ordenar por data ja entrega o preco atual e degrada para a ultima barra
// mensal quando o cron de 5 minutos ainda nao rodou.
async function precosAtuais(tickers: string[]): Promise<Map<string, number>> {
  if (tickers.length === 0) return new Map();

  // DISTINCT ON devolve so a linha mais recente de cada ticker. Buscar tudo e filtrar
  // em memoria traria milhares de snapshots intradiarios para escolher uma dezena.
  const cotacoes = await prisma.$queryRaw<{ ticker: string; adjclose: number }[]>`
    SELECT DISTINCT ON (ticker) ticker, adjclose
      FROM cotacoes_historicas
     WHERE ticker = ANY(${tickers})
       AND adjclose IS NOT NULL
     ORDER BY ticker, data DESC
  `;

  return new Map(cotacoes.map(c => [c.ticker, c.adjclose]));
}

async function precoDe(ticker: string): Promise<number> {
  return (await precosAtuais([ticker])).get(ticker) ?? 0;
}

// Sinal de Valor e Momento vigente no momento da transacao. E gravado como snapshot:
// o sinal muda a cada reclassificacao diaria, entao consultar o ZScore depois
// devolveria o valor de hoje, nao o da epoca da compra.
async function sinalVigente(ticker: string): Promise<string | null> {
  const ultimo = await prisma.zScoreResultado.findFirst({
    where: { ticker },
    orderBy: { dataCalculo: "desc" },
    select: { sinalVM: true },
  });
  return ultimo?.sinalVM ?? null;
}

// Variacao do Ibovespa no mesmo periodo da carteira - o benchmark que o TCC define
// para avaliar o desempenho da carteira simulada.
async function variacaoIbov(desde: Date): Promise<number | null> {
  const inicio = await prisma.cotacaoIndice.findFirst({
    where: { simbolo: "^BVSP", data: { gte: desde } },
    orderBy: { data: "asc" },
  });
  const fim = await prisma.cotacaoIndice.findFirst({
    where: { simbolo: "^BVSP" },
    orderBy: { data: "desc" },
  });
  if (!inicio || !fim || !inicio.fechamento || inicio.id === fim.id) return null;
  return (fim.fechamento - inicio.fechamento) / inicio.fechamento;
}

// Lista de acoes disponiveis para compra, com a cotacao mais recente. Usa a mesma
// fonte de preco do fluxo de compra (`precosAtuais`), para que o valor exibido na
// lista seja exatamente o valor cobrado ao confirmar a compra.
router.get("/cotacoes", async (_req: AuthRequest, res: Response) => {
  const empresas = await prisma.empresa.findMany({
    where: { ativa: true },
    orderBy: { ticker: "asc" },
  });
  const precos = await precosAtuais(empresas.map((e) => e.ticker));

  const lista = empresas
    .map((e) => ({
      ticker: e.ticker,
      nome: e.nome,
      setor: e.setor,
      precoAtual: precos.get(e.ticker) ?? null,
    }))
    .filter((x) => x.precoAtual != null);

  res.json(lista);
});

// Formata uma carteira (com ativos e transacoes carregadas) no mesmo formato usado
// pelo GET / e pelas respostas de compra/venda, para que o front-end consiga
// atualizar o cache sem refazer a requisicao.
async function formatarCarteira(c: any): Promise<any> {
  const tickers = c.ativos.map((a: any) => a.ticker);
  const precos = await precosAtuais(tickers);

  const ativos = c.ativos.map((a: any) => {
    const precoAtual = precos.get(a.ticker);
    const valorAtual = precoAtual != null ? precoAtual * a.quantidade : undefined;
    return {
      id: a.id,
      ticker: a.ticker,
      nome: a.empresa?.nome || a.ticker,
      quantidade: a.quantidade,
      precoMedio: a.precoMedio,
      precoAtual,
      valorAtual,
      rentabilidade:
        precoAtual != null && a.precoMedio > 0
          ? (precoAtual - a.precoMedio) / a.precoMedio
          : undefined,
      setor: a.empresa?.setor || undefined,
      dataCompra: a.dataCompra,
    };
  });

  // A preco de mercado, nao de custo: usar precoMedio aqui faria o retorno da
  // carteira ficar preso em ~0% independentemente do que o mercado fizesse.
  const valorInvestido = ativos.reduce(
    (s, a) => s + (a.valorAtual ?? a.quantidade * a.precoMedio),
    0
  );
  const patrimonio = c.saldoDisponivel + valorInvestido;

  const porSetor = new Map<string, number>();
  for (const a of ativos) {
    const setor = a.setor || "N/A";
    porSetor.set(setor, (porSetor.get(setor) || 0) + (a.valorAtual ?? a.quantidade * a.precoMedio));
  }
  const distribuicaoSetores = [...porSetor.entries()]
    .map(([setor, valor]) => ({
      setor,
      valor,
      percentual: valorInvestido > 0 ? valor / valorInvestido : 0,
    }))
    .sort((a, b) => b.valor - a.valor);

  return {
    id: c.id,
    nome: c.nome,
    capitalInicial: c.capitalInicial,
    saldoDisponivel: c.saldoDisponivel,
    createdAt: c.createdAt,
    ativos,
    transacoes: c.transacoes,
    valorInvestido,
    patrimonio,
    rentabilidade: c.capitalInicial > 0 ? (patrimonio - c.capitalInicial) / c.capitalInicial : 0,
    rentabilidadeIBOV: await variacaoIbov(c.createdAt),
    distribuicaoSetores,
  };
}

const RANGE_EVOLUCAO: Record<string, number | null> = {
  "1d": 1,
  "1m": 30,
  "6m": 183,
  "1a": 365,
  "3a": 1095,
};

router.get("/", async (req: AuthRequest, res: Response) => {
  const carteiras = await prisma.carteiraSimulada.findMany({
    where: { userId: req.userId, ativa: true },
    include: {
      ativos: { include: { empresa: true } },
      transacoes: { orderBy: { data: "desc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(await Promise.all(carteiras.map(formatarCarteira)));
});

// Evolucao da carteira vs Ibovespa, normalizada em base 100 no inicio do periodo.
// Reconstroi saldo e posicoes a partir das transacoes e marca a carteira pelos
// precos historicos disponiveis (serie mensal + snapshots intradiarios).
router.get("/:id/evolucao", async (req: AuthRequest, res: Response) => {
  const id = (req as any).params.id as string;
  const range = typeof req.query.range === "string" && req.query.range in RANGE_EVOLUCAO
    ? req.query.range
    : "1a";

  const carteira = (await prisma.carteiraSimulada.findFirst({
    where: { id, userId: req.userId },
    include: { ativos: true, transacoes: { orderBy: { data: "asc" } } },
  })) as any;
  if (!carteira) {
    res.status(404).json({ error: "Carteira não encontrada" });
    return;
  }

  const tickers = [...new Set((carteira.transacoes as any[]).map((t) => t.ticker as string))] as string[];

  const [mensais, intraday, ibovSerie] = await Promise.all([
    prisma.cotacaoHistorica.findMany({
      where: { ticker: { in: tickers }, tipo: "mensal" },
      orderBy: { data: "asc" },
    }),
    prisma.cotacaoHistorica.findMany({
      where: { ticker: { in: tickers }, tipo: "intraday" },
      orderBy: { data: "asc" },
    }),
    prisma.cotacaoIndice.findMany({ where: { simbolo: "^BVSP" }, orderBy: { data: "asc" } }),
  ]);

  const precosPorTicker = new Map<string, { data: number; preco: number }[]>();
  for (const t of tickers) precosPorTicker.set(t, []);
  for (const m of mensais) {
    if (m.adjclose == null) continue;
    const arr = precosPorTicker.get(m.ticker);
    if (arr) arr.push({ data: m.data.getTime(), preco: m.adjclose });
  }
  for (const i of intraday) {
    if (i.adjclose == null) continue;
    const arr = precosPorTicker.get(i.ticker);
    if (arr) arr.push({ data: i.data.getTime(), preco: i.adjclose });
  }
  for (const arr of precosPorTicker.values()) arr.sort((a, b) => a.data - b.data);

  // A tabela de indices guarda dois tipos de linha para o mesmo dia: a barra diaria
  // do Yahoo (13:00 UTC) e o snapshot do cron de 5 min (00:00 UTC, que no horario de
  // Brasilia ainda e o dia anterior). Sem consolidar, o mesmo dia aparece duas vezes
  // e o fim da serie fica achatado. Agrupa por dia local e prioriza a barra diaria.
  const ibovPorDia = new Map<string, { data: number; preco: number; horaUtc: number }>();
  for (const i of ibovSerie) {
    const ts = i.data.getTime();
    const dia = new Date(ts).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const horaUtc = i.data.getUTCHours();
    const atual = ibovPorDia.get(dia);
    const prefereBarraDiaria = horaUtc === 13 && atual?.horaUtc !== 13;
    const mesmaHoraMaisRecente = atual != null && horaUtc === atual.horaUtc && ts > atual.data;
    if (!atual || prefereBarraDiaria || mesmaHoraMaisRecente) {
      ibovPorDia.set(dia, { data: ts, preco: i.fechamento, horaUtc });
    }
  }
  const ibovDias = [...ibovPorDia.entries()]
    .map(([dia, p]) => ({ dia, data: p.data, preco: p.preco }))
    .sort((a, b) => a.data - b.data);

  // Preco de fallback por ticker: ultimo preco de transacao conhecido.
  const fallbackPreco = new Map<string, number>();
  for (const t of carteira.transacoes) fallbackPreco.set(t.ticker, t.preco);

  function estadoEm(ts: number): { qtd: Map<string, number>; saldo: number } {
    const qtd = new Map<string, number>();
    let saldo = carteira.capitalInicial;
    for (const t of carteira.transacoes) {
      if (t.data.getTime() > ts) break;
      const atual = qtd.get(t.ticker) ?? 0;
      if (t.tipo === "compra") {
        qtd.set(t.ticker, atual + t.quantidade);
        saldo -= t.quantidade * t.preco;
      } else {
        qtd.set(t.ticker, atual - t.quantidade);
        saldo += t.quantidade * t.preco;
      }
    }
    return { qtd, saldo };
  }

  function precoEm(ticker: string, ts: number): number {
    const arr = precosPorTicker.get(ticker) ?? [];
    let p = fallbackPreco.get(ticker) ?? 0;
    for (const pt of arr) {
      if (pt.data > ts) break;
      p = pt.preco;
    }
    return p;
  }

  const agora = Date.now();
  const dias = RANGE_EVOLUCAO[range];
  // 1D = desde a meia-noite local; os demais periodos usam a janela movel.
  const inicioDoDia = new Date(agora);
  inicioDoDia.setHours(0, 0, 0, 0);
  const corte = dias == null
    ? null
    : range === "1d"
      ? inicioDoDia.getTime()
      : agora - dias * 24 * 60 * 60 * 1000;

  // Grade de avaliacao: snapshots intradiarios apenas em 1D. Nos periodos longos a
  // serie e diaria (precos mensais carregados para frente), para o Ibovespa nao ter
  // um trecho reto gigante no fim do grafico.
  let lista: number[] = [];
  if (range === "1d") {
    for (const p of intraday) if (p.adjclose != null) lista.push(p.data.getTime());
  } else {
    const primeiroIbov = ibovDias.length ? ibovDias[0].data : agora;
    const inicioTs = dias != null ? agora - dias * 24 * 60 * 60 * 1000 : primeiroIbov;
    // Meio-dia local: a meia-noite UTC aparecia como o dia anterior no horario de
    // Brasilia e deslocava os rotulos do eixo X. Em 3A usa passo de 3 dias para
    // reduzir a quantidade de pontos e o custo de renderizacao do grafico.
    const passoDias = range === "3a" ? 3 : 1;
    const inicio = new Date(inicioTs);
    inicio.setHours(12, 0, 0, 0);
    for (let d = new Date(inicio); d.getTime() <= agora; d.setDate(d.getDate() + passoDias)) {
      lista.push(d.getTime());
    }
  }
  lista.push(agora);
  lista = [...new Set(lista)].sort((a, b) => a - b);

  const criacaoTs = carteira.createdAt.getTime();

  function ibovEm(ts: number): number | null {
    // O indice e diario: usa o fechamento do proprio dia local, mesmo que o
    // snapshot tenha sido gravado a noite. Fins de semana/feriados herdam o
    // ultimo pregao disponivel.
    const dia = new Date(ts).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const exato = ibovPorDia.get(dia);
    if (exato) return exato.preco;

    let valor: number | null = null;
    for (const p of ibovDias) {
      if (p.data > ts) break;
      valor = p.preco;
    }
    return valor;
  }

  // Variacao percentual dentro do periodo selecionado: o Ibovespa tem base no
  // inicio da janela (fechamento anterior, no caso de 1D) e a carteira tem base no
  // primeiro ponto em que ela existe dentro da janela (a criacao, se for mais nova).
  const brutos: { ts: number; valor: number | null; ibov: number }[] = [];
  for (const ts of lista) {
    if (corte != null && ts < corte) continue;

    const ibovV = ibovEm(ts);
    if (ibovV == null) continue;

    if (ts < criacaoTs) {
      brutos.push({ ts, valor: null, ibov: ibovV });
      continue;
    }

    const { qtd, saldo } = estadoEm(ts);
    let valor = saldo;
    for (const [ticker, quantidade] of qtd) {
      if (quantidade <= 0) continue;
      valor += quantidade * precoEm(ticker, ts);
    }
    brutos.push({ ts, valor, ibov: ibovV });
  }

  if (brutos.length === 0) {
    res.json({ pontos: [] });
    return;
  }

  // 1D compara com o fechamento anterior (rentabilidade do dia); os demais periodos
  // comecam em 0% no primeiro ponto do grafico.
  const baseI = range === "1d"
    ? (ibovEm(corte! - 1) ?? brutos[0].ibov ?? 1)
    : (brutos[0].ibov ?? 1);
  const baseC = brutos.find((b) => b.valor != null)?.valor ?? 1;

  res.json({
    pontos: brutos.map((p) => ({
      data: new Date(p.ts).toISOString(),
      carteira: p.valor == null ? null : Number((((p.valor / baseC) - 1) * 100).toFixed(4)),
      ibov: Number((((p.ibov / baseI) - 1) * 100).toFixed(4)),
    })),
  });
});

router.post("/", async (req: AuthRequest, res: Response) => {
  const { nome, capitalInicial } = req.body as any;
  if (!nome || !capitalInicial) {
    res.status(400).json({ error: "Nome e capital inicial são obrigatórios" });
    return;
  }
  const carteira = await prisma.carteiraSimulada.create({
    data: {
      userId: req.userId!,
      nome,
      capitalInicial,
      saldoDisponivel: capitalInicial,
    },
  });
  res.status(201).json(carteira);
});

router.post("/:id/comprar", async (req: AuthRequest, res: Response) => {
  const id = (req as any).params.id as string;
  const { ticker, quantidade } = req.body as any;

  const carteira = await prisma.carteiraSimulada.findFirst({
    where: { id, userId: req.userId },
    include: { ativos: true },
  }) as any;
  if (!carteira) {
    res.status(404).json({ error: "Carteira não encontrada" });
    return;
  }

  const ativoExistente = carteira.ativos.find((a: any) => a.ticker === ticker);
  if (!ativoExistente && carteira.ativos.length >= MAX_ATIVOS_CARTEIRA) {
    res.status(400).json({ error: `Máximo de ${MAX_ATIVOS_CARTEIRA} ativos por carteira` });
    return;
  }

  const preco = await precoDe(ticker);
  if (!preco) {
    res.status(400).json({ error: "Preço indisponível para o ativo" });
    return;
  }
  const custo = preco * quantidade;

  if (carteira.saldoDisponivel < custo) {
    res.status(400).json({ error: "Saldo insuficiente" });
    return;
  }

  const sinalVM = await sinalVigente(ticker);

  await prisma.$transaction(async (tx) => {
    if (ativoExistente) {
      const qtdTotal = ativoExistente.quantidade + quantidade;
      const custoTotal = ativoExistente.precoMedio * ativoExistente.quantidade + custo;
      await tx.carteiraAtivo.update({
        where: { id: ativoExistente.id },
        data: {
          quantidade: qtdTotal,
          precoMedio: custoTotal / qtdTotal,
        },
      });
    } else {
      await tx.carteiraAtivo.create({
        data: {
          carteiraId: id,
          ticker,
          quantidade,
          precoMedio: preco,
        },
      });
    }

    await tx.transacao.create({
      data: {
        carteiraId: id,
        ticker,
        tipo: "compra",
        quantidade,
        preco,
        sinalVM,
      },
    });

    await tx.carteiraSimulada.update({
      where: { id },
      data: { saldoDisponivel: carteira.saldoDisponivel - custo },
    });
  });

  const atualizada = await prisma.carteiraSimulada.findUnique({
    where: { id },
    include: {
      ativos: { include: { empresa: true } },
      transacoes: { orderBy: { data: "desc" } },
    },
  });
  res.json(await formatarCarteira(atualizada));
});

router.post("/:id/vender", async (req: AuthRequest, res: Response) => {
  const id = (req as any).params.id as string;
  const { ticker, quantidade } = req.body as any;

  const carteira = await prisma.carteiraSimulada.findFirst({
    where: { id, userId: req.userId },
    include: { ativos: true },
  }) as any;
  if (!carteira) {
    res.status(404).json({ error: "Carteira não encontrada" });
    return;
  }

  const ativo = carteira.ativos.find((a: any) => a.ticker === ticker);
  if (!ativo || ativo.quantidade < quantidade) {
    res.status(400).json({ error: "Quantidade insuficiente" });
    return;
  }

  const preco = await precoDe(ticker);
  if (!preco) {
    res.status(400).json({ error: "Preço indisponível para o ativo" });
    return;
  }
  const receita = preco * quantidade;
  const sinalVM = await sinalVigente(ticker);

  await prisma.$transaction(async (tx) => {
    if (ativo.quantidade === quantidade) {
      await tx.carteiraAtivo.delete({ where: { id: ativo.id } });
    } else {
      await tx.carteiraAtivo.update({
        where: { id: ativo.id },
        data: { quantidade: ativo.quantidade - quantidade },
      });
    }

    await tx.transacao.create({
      data: {
        carteiraId: id,
        ticker,
        tipo: "venda",
        quantidade,
        preco,
        sinalVM,
      },
    });

    await tx.carteiraSimulada.update({
      where: { id },
      data: { saldoDisponivel: carteira.saldoDisponivel + receita },
    });
  });

  const atualizada = await prisma.carteiraSimulada.findUnique({
    where: { id },
    include: {
      ativos: { include: { empresa: true } },
      transacoes: { orderBy: { data: "desc" } },
    },
  });
  res.json(await formatarCarteira(atualizada));
});

router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const id = (req as any).params.id as string;
  await prisma.carteiraSimulada.updateMany({
    where: { id, userId: req.userId },
    data: { ativa: false },
  });
  res.json({ ok: true });
});

export default router;
