-- Snapshot do sinal de Valor e Momento no instante da compra/venda.
-- Compras anteriores a esta migração ficam com NULL (o sinal da época não foi
-- registrado e o resultado atual não pode ser usado como se fosse histórico).
ALTER TABLE "transacoes" ADD COLUMN "sinal_vm" TEXT;
