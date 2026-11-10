-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "empresas" (
    "ticker" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "setor" TEXT,
    "industria" TEXT,
    "volume_medio" BIGINT,
    "ativa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "empresas_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "dados_trimestrais" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "data_referencia" TIMESTAMP(3) NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'quarterly',
    "total_assets" BIGINT,
    "common_stock_equity" BIGINT,
    "stockholders_equity" BIGINT,
    "total_debt" BIGINT,
    "total_liabilities" BIGINT,
    "current_assets" BIGINT,
    "current_liabilities" BIGINT,
    "working_capital" BIGINT,
    "accumulated_depreciation" BIGINT,
    "cash_and_equivalents" BIGINT,
    "total_revenue" BIGINT,
    "operating_revenue" BIGINT,
    "cost_of_revenue" BIGINT,
    "gross_profit" BIGINT,
    "operating_income" BIGINT,
    "ebit" BIGINT,
    "ebitda" BIGINT,
    "net_income" BIGINT,
    "depreciation_amortization" BIGINT,
    "interest_expense" BIGINT,
    "operating_cash_flow" BIGINT,
    "capital_expenditure" BIGINT,
    "free_cash_flow" BIGINT,
    "change_in_working_capital" BIGINT,
    "dadosCompletos" JSONB,

    CONSTRAINT "dados_trimestrais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cotacoes_historicas" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "adjclose" DOUBLE PRECISION,

    CONSTRAINT "cotacoes_historicas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indicadores_calculados" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "data_referencia" TIMESTAMP(3) NOT NULL,
    "roa" DOUBLE PRECISION,
    "roe" DOUBLE PRECISION,
    "gpoa" DOUBLE PRECISION,
    "gmar" DOUBLE PRECISION,
    "cfoa" DOUBLE PRECISION,
    "acc" DOUBLE PRECISION,
    "bab" DOUBLE PRECISION,
    "lev" DOUBLE PRECISION,
    "evol" DOUBLE PRECISION,
    "be_me" DOUBLE PRECISION,
    "mom2_12" DOUBLE PRECISION,

    CONSTRAINT "indicadores_calculados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zscore_resultados" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "data_calculo" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "zLucratividade" DOUBLE PRECISION,
    "zCrescimento" DOUBLE PRECISION,
    "zSeguranca" DOUBLE PRECISION,
    "zQualidade" DOUBLE PRECISION,
    "zValor" DOUBLE PRECISION,
    "zMomento" DOUBLE PRECISION,
    "zValorMomento" DOUBLE PRECISION,
    "classificacao_qualidade" TEXT,
    "sinal_vm" TEXT,

    CONSTRAINT "zscore_resultados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carteiras_simuladas" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "capital_inicial" DOUBLE PRECISION NOT NULL,
    "saldo_disponivel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carteiras_simuladas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carteira_ativos" (
    "id" TEXT NOT NULL,
    "carteira_id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "quantidade" DOUBLE PRECISION NOT NULL,
    "preco_medio" DOUBLE PRECISION NOT NULL,
    "data_compra" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carteira_ativos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transacoes" (
    "id" TEXT NOT NULL,
    "carteira_id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "quantidade" DOUBLE PRECISION NOT NULL,
    "preco" DOUBLE PRECISION NOT NULL,
    "data" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_status" (
    "job_name" TEXT NOT NULL,
    "ultima_execucao" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',

    CONSTRAINT "cron_status_pkey" PRIMARY KEY ("job_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "dados_trimestrais_ticker_data_referencia_tipo_key" ON "dados_trimestrais"("ticker", "data_referencia", "tipo");

-- CreateIndex
CREATE UNIQUE INDEX "cotacoes_historicas_ticker_data_key" ON "cotacoes_historicas"("ticker", "data");

-- CreateIndex
CREATE UNIQUE INDEX "indicadores_calculados_ticker_data_referencia_key" ON "indicadores_calculados"("ticker", "data_referencia");

-- CreateIndex
CREATE UNIQUE INDEX "zscore_resultados_ticker_data_calculo_key" ON "zscore_resultados"("ticker", "data_calculo");

-- CreateIndex
CREATE UNIQUE INDEX "carteira_ativos_carteira_id_ticker_key" ON "carteira_ativos"("carteira_id", "ticker");

-- AddForeignKey
ALTER TABLE "dados_trimestrais" ADD CONSTRAINT "dados_trimestrais_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "empresas"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotacoes_historicas" ADD CONSTRAINT "cotacoes_historicas_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "empresas"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indicadores_calculados" ADD CONSTRAINT "indicadores_calculados_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "empresas"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zscore_resultados" ADD CONSTRAINT "zscore_resultados_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "empresas"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carteiras_simuladas" ADD CONSTRAINT "carteiras_simuladas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carteira_ativos" ADD CONSTRAINT "carteira_ativos_carteira_id_fkey" FOREIGN KEY ("carteira_id") REFERENCES "carteiras_simuladas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carteira_ativos" ADD CONSTRAINT "carteira_ativos_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "empresas"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_carteira_id_fkey" FOREIGN KEY ("carteira_id") REFERENCES "carteiras_simuladas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_ticker_fkey" FOREIGN KEY ("ticker") REFERENCES "empresas"("ticker") ON DELETE RESTRICT ON UPDATE CASCADE;
