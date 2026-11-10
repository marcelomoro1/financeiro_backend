-- AlterTable: separa a serie mensal do snapshot intradiario de preco.
ALTER TABLE "cotacoes_historicas" ADD COLUMN     "tipo" TEXT NOT NULL DEFAULT 'mensal';

-- Reclassifica os dados ja existentes. As barras mensais do Yahoo chegam sempre em
-- 03:00:00 UTC (meia-noite BRT); os snapshots gravados pelo cron de 5 minutos caem em
-- horarios variados. Sem esta reclassificacao, os snapshots continuariam contaminando
-- a janela do MOM2-12.
UPDATE "cotacoes_historicas"
   SET "tipo" = 'intraday'
 WHERE to_char("data", 'HH24:MI:SS') <> '03:00:00';

-- DropIndex
DROP INDEX "cotacoes_historicas_ticker_data_key";

-- CreateIndex
CREATE UNIQUE INDEX "cotacoes_historicas_ticker_data_tipo_key" ON "cotacoes_historicas"("ticker", "data", "tipo");

-- CreateTable: serie do Ibovespa. Fica fora de cotacoes_historicas porque aquela
-- tabela tem FK obrigatoria para empresas, e cadastrar o indice como empresa o faria
-- aparecer em todo findMany({ where: { ativa: true } }) do sistema.
CREATE TABLE "cotacoes_indices" (
    "id" TEXT NOT NULL,
    "simbolo" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "fechamento" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "cotacoes_indices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cotacoes_indices_simbolo_data_key" ON "cotacoes_indices"("simbolo", "data");
