-- Corrige a reclassificacao feita pela migracao 20260913120000.
--
-- Aquela migracao separou serie mensal de snapshot intradiario pelo horario, assumindo
-- que "barras mensais chegam em 03:00:00 UTC e snapshots em horarios variados". A
-- premissa esta errada: o cron de precos roda a cada 5 minutos, entao acerta 03:00:00
-- UTC uma vez por dia. Com isso, 100 snapshots (50 tickers x 2 datas) ficaram marcados
-- como 'mensal'.
--
-- O criterio correto e o DIA do mes: o Yahoo devolve a barra mensal sempre no primeiro
-- dia do mes. Qualquer linha 'mensal' fora dos primeiros dias e snapshot intradiario.
--
-- Hoje isso nao corrompe o MOM2-12 (os meses-alvo caem em barras legitimas), mas e
-- latente: calcularMomentum2 monta o mapa pegando a barra mais recente de cada mes,
-- entao um snapshot no meio de um mes-alvo substituiria o preco de abertura daquele mes.
UPDATE "cotacoes_historicas"
   SET "tipo" = 'intraday'
 WHERE "tipo" = 'mensal'
   AND EXTRACT(DAY FROM "data") > 3;
