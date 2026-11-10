import { PrismaClient } from "@prisma/client";
import { TICKERS_SAMPLE } from "../src/conhecimento/dominio/constants";

const prisma = new PrismaClient();

async function main() {
  console.log("Criando empresas seed...");
  for (const ticker of TICKERS_SAMPLE) {
    await prisma.empresa.upsert({
      where: { ticker },
      update: {},
      create: {
        ticker,
        nome: ticker,
        ativa: true,
      },
    });
  }
  console.log(`${TICKERS_SAMPLE.length} empresas criadas.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
