-- Capital de giro operacional (Sloan, 1996), usado por CFOA e ACC:
--   WC = (Ativo Circulante - caixa e aplicacoes) - (Passivo Circulante - divida de curto prazo)
-- Os dois campos ja vinham no payload do Yahoo, mas so existiam dentro do JSON bruto
-- em dados_completos. Sem eles, o deltaWC capturava movimento de caixa (dividendo,
-- recompra, reclassificacao de aplicacoes) como se fosse geracao de caixa operacional.
ALTER TABLE "dados_trimestrais" ADD COLUMN "cash_and_short_term_investments" BIGINT;
ALTER TABLE "dados_trimestrais" ADD COLUMN "current_debt" BIGINT;
