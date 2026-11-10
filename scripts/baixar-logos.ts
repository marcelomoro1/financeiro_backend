/**
 * Baixa uma vez os logos das 50 acoes da amostra e salva localmente em
 * financeiro_frontend/public/logos/{TICKER}.svg. E um script one-off: o card do
 * dashboard referencia o arquivo estatico (/logos/PETR4.svg), sem chamada de rede
 * em runtime nem dependencia de uma API externa estar de pe no dia da apresentacao.
 *
 * Fonte: https://icons.brapi.dev/icons/{TICKER}.svg, sem autenticacao. O endpoint
 * de quote do brapi (cogitado como fallback) hoje exige token - nao ha fallback aqui;
 * ticker sem logo simplesmente nao gera arquivo, e o card trata a ausencia escondendo
 * a imagem (onError).
 *
 *   npx tsx scripts/baixar-logos.ts
 */
import fs from "fs/promises";
import path from "path";
import { TICKERS_SAMPLE } from "../src/conhecimento/dominio/constants";

const DEST_DIR = path.resolve(__dirname, "../../financeiro_frontend/public/logos");
const DELAY_MS = 300;

async function baixarLogo(tickerBase: string): Promise<boolean> {
  const url = `https://icons.brapi.dev/icons/${tickerBase}.svg`;
  const res = await fetch(url);
  if (!res.ok) return false;
  const svg = await res.text();
  await fs.writeFile(path.join(DEST_DIR, `${tickerBase}.svg`), svg);
  return true;
}

async function main() {
  await fs.mkdir(DEST_DIR, { recursive: true });
  const semLogo: string[] = [];

  for (const ticker of TICKERS_SAMPLE) {
    const base = ticker.replace(".SA", "");
    try {
      const ok = await baixarLogo(base);
      console.log(`  ${base}: ${ok ? "OK" : "sem logo"}`);
      if (!ok) semLogo.push(base);
    } catch (e: any) {
      console.log(`  ${base}: ERRO - ${e.message?.substring(0, 80)}`);
      semLogo.push(base);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n[LOGOS] ${TICKERS_SAMPLE.length - semLogo.length}/${TICKERS_SAMPLE.length} baixados.`);
  if (semLogo.length) console.log(`  Sem logo: ${semLogo.join(", ")}`);
}

main();
