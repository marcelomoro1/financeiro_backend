-- Dividendo declarado e ainda nao pago fica no Passivo Circulante. A definicao de Sloan
-- retira do circulante o caixa e a divida de curto prazo, mas nao os dividendos a pagar:
-- na B3 eles sao declarados no fechamento do exercicio e pagos meses depois, e sao
-- materiais (GRND3 tinha R$ 980 mi em dez/2025). Sem retira-los, a distribuicao de
-- capital reaparece no CFOA como se fosse geracao de caixa operacional - o mesmo defeito
-- que a migracao 20260914120000 corrigiu, por outra porta.
ALTER TABLE "dados_trimestrais" ADD COLUMN "dividends_payable" BIGINT;
