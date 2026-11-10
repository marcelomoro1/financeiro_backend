import cron from "node-cron";
import prisma from "../armazenamento/prisma";
import {
  syncCotacoes,
  syncCotacoesHistoricas,
  syncEmpresas,
  syncDadosTrimestrais,
  syncPontoIndice,
  syncSerieIndice,
} from "../extracao/yahooFinance";
import {
  calcularIndicadoresTodos,
  recalcularMomentoTodos,
  recalcularValorMomento,
} from "../../modelos/indicadores/calculadora";
import { executarPipelineCompleto, recalcularValorMomentoZScore } from "../../modelos/zscore/pipeline";
import { reconstruirFluxosTodos } from "../limpeza/reconstrucao";

let sincronizacaoEmAndamento = false;

// A serie mensal alimenta o MOM2-12 e precisa existir ANTES do calculo dos indicadores.
// Antes ela so chegava ao banco como efeito colateral do calculo de beta, que roda
// depois do momento - por isso o fator Momento nascia vazio na primeira execucao.
async function syncHistoricosMensais(): Promise<void> {
  const empresas = await prisma.empresa.findMany({ where: { ativa: true } });
  for (const e of empresas) {
    const n = await syncCotacoesHistoricas(e.ticker);
    console.log(`  Historico ${e.ticker}: ${n} meses`);
  }
}

// Rotina que o cron diario executa. Extraida para ser reutilizada pelo catch-up do boot:
// node-cron so dispara com o processo vivo na hora marcada, e o backend roda solto no
// terminal (pendencia PM2/Task Scheduler), entao as 21:00 raramente encontram o processo
// de pe. Sem esta rotina reutilizavel, o atraso nao poderia ser recuperado no boot.
async function executarRodadaDiaria(): Promise<void> {
  // A serie mensal precisa vir ANTES da reclassificacao. Sem isto ela so seria
  // atualizada no cron trimestral, e o MOM2-12 ficaria ancorado num mes cada vez
  // mais antigo - o cron de 5 minutos chamaria recalcularValorMomento sobre uma
  // tabela estagnada e so o BE/ME mudaria de fato.
  await syncHistoricosMensais();
  await recalcularMomentoTodos();
  await recalcularValorMomentoZScore(true);
  await updateCronStatus("sinal_diario");
}

// Janelas a partir das quais uma rotina agendada e considerada atrasada no boot.
const STALE_DIARIA_MS = 24 * 60 * 60 * 1000;
const STALE_TRIMESTRAL_MS = 90 * 24 * 60 * 60 * 1000;

// Recuperacao de atrasos no boot. Roda logo depois da inicializacao e reexecuta as
// rotinas agendadas que nao conseguiram rodar no horario marcado (processo morto).
// A trimestral cobre a diaria (a sync completa sincroniza a serie mensal e roda o
// pipeline com reclassificacao), entao quando a trimestral esta atrasada so ela roda.
export async function recuperarRotinasAtrasadas(): Promise<void> {
  const trimestral = await prisma.cronStatus.findUnique({ where: { jobName: "trimestral_balancos" } });
  const atrasoTrimestral = !trimestral || Date.now() - trimestral.ultimaExecucao.getTime() > STALE_TRIMESTRAL_MS;
  if (atrasoTrimestral) {
    console.log("[CATCHUP] Sincronizacao trimestral atrasada - executando no boot...");
    try {
      await executarSincronizacaoCompleta();
      // A sync completa cobre tambem a rotina diaria (serie mensal + pipeline + sinal).
      await updateCronStatus("trimestral_balancos");
      await updateCronStatus("sinal_diario");
      console.log("[CATCHUP] Sincronizacao trimestral concluida.");
    } catch (e: any) {
      console.log("[CATCHUP] Erro na sincronizacao trimestral:", e.message);
    }
    return;
  }

  const diaria = await prisma.cronStatus.findUnique({ where: { jobName: "sinal_diario" } });
  const atrasoDiario = !diaria || Date.now() - diaria.ultimaExecucao.getTime() > STALE_DIARIA_MS;
  if (atrasoDiario) {
    console.log("[CATCHUP] Rodada diaria atrasada - executando no boot...");
    try {
      await executarRodadaDiaria();
      console.log("[CATCHUP] Rodada diaria concluida.");
    } catch (e: any) {
      console.log("[CATCHUP] Erro na rodada diaria:", e.message);
    }
  }
}

export function initCronJobs(): void {
  // Precos a cada 5 minutos. O sinal de compra/venda NAO e reclassificado aqui: uma
  // acao parada em cima do corte de 33% alternaria entre "Compra" e "Indefinido" o dia
  // inteiro ao sabor de centavos.
  cron.schedule("*/5 * * * *", async () => {
    console.log("[CRON] Atualizando cotacoes (5min)...");
    try {
      const atualizados = await syncCotacoes();
      for (const { ticker, marketCap } of atualizados) {
        await recalcularValorMomento(ticker, marketCap);
      }
      await recalcularValorMomentoZScore(false);
      await syncPontoIndice();
      await updateCronStatus("precos_5min");
    } catch (e: any) {
      console.log("[CRON] Erro cotacoes:", e.message);
    }
  });

  // Rodada diaria, apos o fechamento do pregao.
  cron.schedule("0 21 * * 1-5", async () => {
    console.log("[CRON] Rodada diaria: serie mensal + reclassificacao do sinal...");
    try {
      await executarRodadaDiaria();
    } catch (e: any) {
      console.log("[CRON] Erro rodada diaria:", e.message);
    }
  });

  // Balancos trimestrais: a B3 divulga a cada tres meses.
  cron.schedule("0 0 1 */3 *", async () => {
    console.log("[CRON] Sincronizacao trimestral de balancos...");
    try {
      const empresas = await prisma.empresa.findMany({ where: { ativa: true } });
      for (const e of empresas) {
        await syncDadosTrimestrais(e.ticker);
      }
      await syncHistoricosMensais();
      console.log("[CRON] Pre-processamento: recompondo trimestres faltantes...");
      await reconstruirFluxosTodos();
      await calcularIndicadoresTodos();
      await executarPipelineCompleto();
      await updateCronStatus("trimestral_balancos");
    } catch (e: any) {
      console.log("[CRON] Erro trimestral:", e.message);
    }
  });
}

export async function runInitialSync(): Promise<void> {
  const status = await prisma.cronStatus.findUnique({ where: { jobName: "initial_sync" } });
  if (status) {
    console.log("[INIT] Sync inicial ja executado em", status.ultimaExecucao);
    return;
  }

  await executarSincronizacaoCompleta();

  await prisma.cronStatus.create({
    data: { jobName: "initial_sync", ultimaExecucao: new Date(), status: "ok" },
  });
  // A sync inicial ja cobre a rotina diaria e a trimestral: registrar as duas evita
  // que o catch-up do boot as reexecute logo em seguida na primeira inicializacao.
  await updateCronStatus("sinal_diario");
  await updateCronStatus("trimestral_balancos");
  console.log("[INIT] Sincronizacao inicial concluida!");
}

// Guard de execucao concorrente: duas chamadas simultaneas fariam ~200 requisicoes
// paralelas ao Yahoo e derrubariam o acesso a API.
export function sincronizacaoAtiva(): boolean {
  return sincronizacaoEmAndamento;
}

export async function executarSincronizacaoCompleta(): Promise<void> {
  if (sincronizacaoEmAndamento) {
    throw new Error("Sincronizacao ja em andamento");
  }
  sincronizacaoEmAndamento = true;
  try {
    console.log("[SYNC] Passo 1/7: Cadastrando empresas...");
    await syncEmpresas();

    console.log("[SYNC] Passo 2/7: Buscando cotacoes atuais...");
    await syncCotacoes();

    console.log("[SYNC] Passo 3/7: Buscando series mensais...");
    await syncHistoricosMensais();

    console.log("[SYNC] Passo 4/7: Buscando serie do Ibovespa...");
    const pontos = await syncSerieIndice();
    console.log(`  Ibovespa: ${pontos} pregoes`);

    console.log("[SYNC] Passo 5/7: Buscando dados trimestrais e anuais...");
    const empresas = await prisma.empresa.findMany({ where: { ativa: true } });
    for (const e of empresas) {
      await syncDadosTrimestrais(e.ticker);
    }

    console.log("[SYNC] Passo 6/7: Pre-processamento dos dados brutos...");
    await reconstruirFluxosTodos();

    console.log("[SYNC] Passo 7/7: Calculando indicadores e Z-Scores...");
    await calcularIndicadoresTodos();
    await executarPipelineCompleto();
  } finally {
    sincronizacaoEmAndamento = false;
  }
}

async function updateCronStatus(jobName: string): Promise<void> {
  await prisma.cronStatus.upsert({
    where: { jobName },
    update: { ultimaExecucao: new Date(), status: "ok" },
    create: { jobName, ultimaExecucao: new Date(), status: "ok" },
  });
}
